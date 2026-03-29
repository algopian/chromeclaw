/**
 * Agent loop — local wrapper around pi-agent-core's agent loop logic.
 * Kept locally for ChromeClaw-specific error guard: the async IIFEs in
 * agentLoop/agentLoopContinue wrap runLoop in try/catch to guarantee
 * stream.end() fires on unhandled errors, preventing service worker hangs.
 */

import { EventStream, validateToolArguments } from '@mariozechner/pi-ai';
import type { AssistantMessage, Context, ToolResultMessage, Usage } from '@mariozechner/pi-ai';
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from '@mariozechner/pi-agent-core';
import { createLogger } from '../logging/logger-buffer';
import { createToolLoopState, detectToolCallLoop, recordToolCall, recordToolCallOutcome } from './tool-loop-detection';
import type { ToolLoopState } from './tool-loop-detection';

const agentLoopLog = createLogger('agent');

/**
 * Start an agent loop with a new prompt message.
 */
const agentLoop = (
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> => {
  const stream = createAgentStream();

  (async () => {
    const newMessages: AgentMessage[] = [...prompts];
    const currentContext: AgentContext = {
      ...context,
      messages: [...context.messages, ...prompts],
    };

    stream.push({ type: 'agent_start' });
    stream.push({ type: 'turn_start' });
    for (const prompt of prompts) {
      stream.push({ type: 'message_start', message: prompt });
      stream.push({ type: 'message_end', message: prompt });
    }

    try {
      await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
    } catch (err) {
      emitLoopError(err, newMessages, stream, config);
    }
  })();

  return stream;
};

/**
 * Continue an agent loop from the current context without adding a new message.
 */
const agentLoopContinue = (
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> => {
  if (context.messages.length === 0) {
    throw new Error('Cannot continue: no messages in context');
  }

  if (context.messages[context.messages.length - 1].role === 'assistant') {
    throw new Error('Cannot continue from message role: assistant');
  }

  const stream = createAgentStream();

  (async () => {
    const newMessages: AgentMessage[] = [];
    const currentContext: AgentContext = { ...context };

    stream.push({ type: 'agent_start' });
    stream.push({ type: 'turn_start' });

    try {
      await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
    } catch (err) {
      emitLoopError(err, newMessages, stream, config);
    }
  })();

  return stream;
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const TRACE_TEXT_LIMIT = 500;

const truncate = (text: string): string =>
  text.length > TRACE_TEXT_LIMIT ? text.slice(0, TRACE_TEXT_LIMIT) + '...' : text;

const summarizeLlmContext = (context: Context) => {
  const messagesSummary = context.messages.map(m => {
    if (m.role === 'assistant') {
      const contentLength = m.content.reduce((len, c) => {
        if (c.type === 'text') return len + c.text.length;
        if (c.type === 'thinking') return len + c.thinking.length;
        return len;
      }, 0);
      return { role: m.role, contentLength };
    }
    if (m.role === 'user') {
      const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return { role: m.role, contentPreview: truncate(raw), contentLength: raw.length };
    }
    return { role: m.role, contentLength: JSON.stringify(m.content).length };
  });

  return {
    systemPrompt: context.systemPrompt ?? '',
    messageCount: context.messages.length,
    messages: messagesSummary,
    toolCount: context.tools?.length ?? 0,
    toolNames: context.tools?.map(t => t.name) ?? [],
  };
};

const summarizeLlmResponse = (msg: AssistantMessage) => ({
  model: msg.model,
  provider: msg.provider,
  stopReason: msg.stopReason,
  ...(msg.errorMessage ? { errorMessage: msg.errorMessage } : {}),
  usage: msg.usage,
  contentParts: msg.content.map(c => {
    if (c.type === 'text') return { type: 'text', length: c.text.length, preview: truncate(c.text) };
    if (c.type === 'thinking') return { type: 'thinking', length: c.thinking.length };
    return { type: 'toolCall', toolName: c.name };
  }),
});

/**
 * When runLoop throws unexpectedly, emit a synthetic error AssistantMessage
 * so the Agent's subscriber and state.error are properly populated.
 */
const emitLoopError = (
  err: unknown,
  newMessages: AgentMessage[],
  stream: EventStream<AgentEvent, AgentMessage[]>,
  config: AgentLoopConfig,
): void => {
  const errorText = err instanceof Error ? err.message : String(err);
  console.error('[agent-loop] runLoop threw:', err);

  const errorMsg: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    api: config.model?.api ?? 'openai-completions',
    provider: config.model?.provider ?? 'unknown',
    model: config.model?.id ?? 'unknown',
    usage: ZERO_USAGE,
    stopReason: 'error',
    errorMessage: errorText,
    timestamp: Date.now(),
  };

  newMessages.push(errorMsg);
  stream.push({ type: 'message_start', message: errorMsg });
  stream.push({ type: 'message_end', message: errorMsg });
  stream.push({ type: 'turn_end', message: errorMsg, toolResults: [] });
  stream.push({ type: 'agent_end', messages: newMessages });
  stream.end(newMessages);
};

const createAgentStream = (): EventStream<AgentEvent, AgentMessage[]> =>
  new EventStream<AgentEvent, AgentMessage[]>(
    (event: AgentEvent) => event.type === 'agent_end',
    (event: AgentEvent) => (event.type === 'agent_end' ? event.messages : []),
  );

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
const runLoop = async (
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  streamFn?: StreamFn,
): Promise<void> => {
  let firstTurn = true;
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];
  const toolLoopState = createToolLoopState();

  // Outer loop: continues when queued follow-up messages arrive after agent would stop
  while (true) {
    let hasMoreToolCalls = true;
    let steeringAfterTools: AgentMessage[] | null = null;

    // Inner loop: process tool calls and steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        stream.push({ type: 'turn_start' });
      } else {
        firstTurn = false;
      }

      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          stream.push({ type: 'message_start', message });
          stream.push({ type: 'message_end', message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      const message = await streamAssistantResponse(
        currentContext,
        config,
        signal,
        stream,
        streamFn,
      );
      newMessages.push(message);

      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        stream.push({ type: 'turn_end', message, toolResults: [] });
        stream.push({ type: 'agent_end', messages: newMessages });
        stream.end(newMessages);
        return;
      }

      const toolCalls = message.content.filter(c => c.type === 'toolCall');
      hasMoreToolCalls = toolCalls.length > 0;

      const toolResults: ToolResultMessage[] = [];
      if (hasMoreToolCalls) {
        const toolExecution = await executeToolCalls(
          currentContext.tools,
          message,
          signal,
          stream,
          config.getSteeringMessages,
          toolLoopState,
        );
        toolResults.push(...toolExecution.toolResults);
        steeringAfterTools = toolExecution.steeringMessages ?? null;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      stream.push({ type: 'turn_end', message, toolResults });

      if (steeringAfterTools && steeringAfterTools.length > 0) {
        pendingMessages = steeringAfterTools;
        steeringAfterTools = null;
      } else {
        pendingMessages = (await config.getSteeringMessages?.()) || [];
      }
    }

    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    break;
  }

  stream.push({ type: 'agent_end', messages: newMessages });
  stream.end(newMessages);
};

/**
 * Stream an assistant response from the LLM.
 */
const streamAssistantResponse = async (
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  streamFn?: StreamFn,
): Promise<AssistantMessage> => {
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  const llmMessages = await config.convertToLlm(messages);

  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  if (!streamFn) {
    throw new Error('No streamFn provided — cannot call LLM');
  }

  const resolvedApiKey =
    (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

  agentLoopLog.trace('LLM request', {
    model: config.model.id,
    provider: config.model.provider,
    ...summarizeLlmContext(llmContext),
  });

  const response = await streamFn(config.model, llmContext, {
    ...config,
    apiKey: resolvedApiKey,
    signal,
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case 'start':
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        stream.push({ type: 'message_start', message: { ...partialMessage } });
        break;

      case 'text_start':
      case 'text_delta':
      case 'text_end':
      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_end':
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end':
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          stream.push({
            type: 'message_update',
            assistantMessageEvent: event,
            message: { ...partialMessage },
          });
        }
        break;

      case 'done':
      case 'error': {
        const finalMessage = await response.result();
        agentLoopLog.trace('LLM response', {
          eventType: event.type,
          ...summarizeLlmResponse(finalMessage),
        });
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
        }
        if (!addedPartial) {
          stream.push({ type: 'message_start', message: { ...finalMessage } });
        }
        stream.push({ type: 'message_end', message: finalMessage });
        return finalMessage;
      }
    }
  }

  return await response.result();
};

/**
 * Execute tool calls from an assistant message.
 */
const executeToolCalls = async (
  tools: AgentTool<any>[] | undefined,
  assistantMessage: AssistantMessage,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  getSteeringMessages?: AgentLoopConfig['getSteeringMessages'],
  toolLoopState?: ToolLoopState,
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> => {
  const toolCalls = assistantMessage.content.filter(c => c.type === 'toolCall');
  const results: ToolResultMessage[] = [];
  let steeringMessages: AgentMessage[] | undefined;

  for (let index = 0; index < toolCalls.length; index++) {
    const toolCall = toolCalls[index];
    const tool = tools?.find(t => t.name === toolCall.name);

    // ── Tool loop detection ──
    if (toolLoopState) {
      await recordToolCall(toolLoopState, toolCall.name, toolCall.arguments, toolCall.id);
      const loopCheck = await detectToolCallLoop(toolLoopState, toolCall.name, toolCall.arguments);
      if (loopCheck.shouldBlock) {
        agentLoopLog.warn('Tool loop detected — blocking', {
          toolName: toolCall.name,
          severity: loopCheck.severity,
          reason: loopCheck.reason,
        });

        const blockedResult: AgentToolResult<any> = {
          content: [{ type: 'text', text: `Tool call blocked: ${loopCheck.reason}. Try a different approach.` }],
          details: {},
        };

        stream.push({
          type: 'tool_execution_start',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,
        });
        stream.push({
          type: 'tool_execution_end',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: blockedResult,
          isError: true,
        });

        const toolResultMessage: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: blockedResult.content,
          details: {},
          isError: true,
          timestamp: Date.now(),
        };

        results.push(toolResultMessage);
        stream.push({ type: 'message_start', message: toolResultMessage });
        stream.push({ type: 'message_end', message: toolResultMessage });
        await recordToolCallOutcome(toolLoopState, toolCall.id, blockedResult);
        continue;
      }

      if (loopCheck.severity !== 'none') {
        agentLoopLog.trace('Tool loop detection', {
          toolName: toolCall.name,
          severity: loopCheck.severity,
          reason: loopCheck.reason,
          entries: toolLoopState.entries.length,
        });
      }
    }

    stream.push({
      type: 'tool_execution_start',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    let result: AgentToolResult<any>;
    let isError = false;

    try {
      if (!tool) throw new Error(`Tool ${toolCall.name} not found`);

      const validatedArgs = validateToolArguments(tool, toolCall);

      result = await tool.execute(toolCall.id, validatedArgs, signal, partialResult => {
        stream.push({
          type: 'tool_execution_update',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,
          partialResult,
        });
      });
    } catch (e) {
      result = {
        content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        details: {},
      };
      isError = true;
    }

    // Log tool result for debugging
    const resultText = result.content
      ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map(c => c.text ?? '')
      .join('');
    agentLoopLog.debug('Tool result', {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      isError,
      resultLength: resultText?.length ?? 0,
      resultPreview: resultText ? resultText.slice(0, 300) : '',
    });

    // Record tool result in loop state for progress tracking
    if (toolLoopState) {
      await recordToolCallOutcome(toolLoopState, toolCall.id, result);
      agentLoopLog.trace('Tool call outcome recorded', {
        toolName: toolCall.name,
        entries: toolLoopState.entries.length,
      });
    }

    stream.push({
      type: 'tool_execution_end',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
      isError,
    });

    const toolResultMessage: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: result.content,
      details: result.details,
      isError,
      timestamp: Date.now(),
    };

    results.push(toolResultMessage);
    stream.push({ type: 'message_start', message: toolResultMessage });
    stream.push({ type: 'message_end', message: toolResultMessage });

    if (getSteeringMessages) {
      const steering = await getSteeringMessages();
      if (steering.length > 0) {
        steeringMessages = steering;
        const remainingCalls = toolCalls.slice(index + 1);
        for (const skipped of remainingCalls) {
          results.push(skipToolCall(skipped, stream));
        }
        break;
      }
    }
  }

  return { toolResults: results, steeringMessages };
};

const skipToolCall = (
  toolCall: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>,
  stream: EventStream<AgentEvent, AgentMessage[]>,
): ToolResultMessage => {
  const result: AgentToolResult<any> = {
    content: [{ type: 'text', text: 'Skipped due to queued user message.' }],
    details: {},
  };

  stream.push({
    type: 'tool_execution_start',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });
  stream.push({
    type: 'tool_execution_end',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError: true,
  });

  const toolResultMessage: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: {},
    isError: true,
    timestamp: Date.now(),
  };

  stream.push({ type: 'message_start', message: toolResultMessage });
  stream.push({ type: 'message_end', message: toolResultMessage });

  return toolResultMessage;
};

export { agentLoop, agentLoopContinue };
