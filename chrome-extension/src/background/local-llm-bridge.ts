/**
 * Local LLM Bridge — IPC between background service worker and offscreen document.
 * Returns an AssistantMessageEventStream so local models plug into the existing
 * agent loop without changes.
 *
 * Parses raw token stream from the worker for <think> and <tool_call> blocks,
 * emitting structured pi-ai events (thinking_delta, toolcall_start/end, text_delta).
 *
 * Follows the kokoro-bridge.ts pattern (requestId-based listener, settle guard, timeout).
 */

import { createAssistantMessageEventStream } from './agents';
import { ensureOffscreenDocument } from './channels/offscreen-manager';
import { createLogger } from './logging/logger-buffer';
import { createXmlTagParser } from './web-providers/xml-tag-parser';
import type { AssistantMessage, AssistantMessageEventStream, TextContent } from './agents';
import type { ParsedEvent } from './web-providers/xml-tag-parser';

const bridgeLog = createLogger('local-llm');

/** Default timeout for local generation (5 minutes). */
const LOCAL_LLM_TIMEOUT_MS = 300_000;

export const requestLocalGeneration = (opts: {
  modelId: string;
  messages: Array<{ role: string; content: string }>;
  systemPrompt: string;
  maxTokens?: number;
  temperature?: number;
  device?: 'webgpu' | 'wasm';
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: unknown };
  }>;
  supportsReasoning?: boolean;
}): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();
  const requestId = crypto.randomUUID();

  // Build a partial AssistantMessage that gets updated as tokens arrive
  const textContent: TextContent = { type: 'text', text: '' };
  const partial: AssistantMessage = {
    role: 'assistant',
    content: [textContent],
    api: 'local-transformers',
    provider: 'local',
    model: opts.modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };

  let fullText = '';

  // Shared XML tag parser for <think> and <tool_call> blocks
  const parser = createXmlTagParser();
  let hasToolCalls = false;

  // Settle guard — prevents double-cleanup and event processing after stream is terminated
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    chrome.runtime.onMessage.removeListener(listener);
  };

  const emitError = (errorMsg: string) => {
    cleanup();
    bridgeLog.error('Generation error', { requestId, error: errorMsg });
    const errorMessage: AssistantMessage = {
      ...partial,
      stopReason: 'error',
      errorMessage: errorMsg,
    };
    stream.push({ type: 'error', reason: 'error', error: errorMessage });
  };

  // Timeout — prevents stream from hanging forever if offscreen document dies
  const timeout = setTimeout(() => {
    emitError(`Local generation timed out after ${LOCAL_LLM_TIMEOUT_MS / 1000}s`);
  }, LOCAL_LLM_TIMEOUT_MS);

  /** Translate parsed events from the shared XML parser into stream events. */
  const emitParsedEvents = (events: ParsedEvent[]) => {
    for (const event of events) {
      switch (event.type) {
        case 'text':
          fullText += event.text;
          textContent.text = fullText;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: event.text, partial });
          break;
        case 'thinking_start':
          stream.push({
            type: 'thinking_start',
            contentIndex: partial.content.length,
            partial,
          });
          partial.content.push({ type: 'thinking', thinking: '' });
          break;
        case 'thinking_delta': {
          const tc = partial.content.find(c => c.type === 'thinking');
          if (tc && tc.type === 'thinking') tc.thinking += event.text;
          stream.push({
            type: 'thinking_delta',
            contentIndex: partial.content.length - 1,
            delta: event.text,
            partial,
          });
          break;
        }
        case 'thinking_end':
          stream.push({
            type: 'thinking_end',
            contentIndex: partial.content.length - 1,
            content: '',
            partial,
          });
          break;
        case 'tool_call': {
          const toolCall = {
            type: 'toolCall' as const,
            id: event.id,
            name: event.name,
            arguments: event.arguments,
          };
          partial.content.push(toolCall);
          hasToolCalls = true;
          stream.push({
            type: 'toolcall_start',
            contentIndex: partial.content.length - 1,
            partial,
          });
          stream.push({
            type: 'toolcall_end',
            contentIndex: partial.content.length - 1,
            toolCall,
            partial,
          });
          break;
        }
        case 'tool_call_malformed':
          // Malformed tool call JSON — emit as text
          fullText += event.rawText;
          textContent.text = fullText;
          stream.push({
            type: 'text_delta',
            contentIndex: 0,
            delta: event.rawText,
            partial,
          });
          break;
      }
    }
  };

  const listener = (message: Record<string, unknown>) => {
    if (message.requestId !== requestId || settled) return;

    switch (message.type) {
      case 'LOCAL_LLM_TOKEN': {
        const token = message.token;
        if (typeof token !== 'string') return;
        emitParsedEvents(parser.feed(token));
        break;
      }

      case 'LOCAL_LLM_END': {
        const usage = message.usage as { inputTokens: number; outputTokens: number } | undefined;
        if (usage) {
          partial.usage = {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: usage.inputTokens + usage.outputTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
        }

        // Flush any remaining buffered state from the parser
        emitParsedEvents(parser.flush());

        textContent.text = fullText;

        cleanup();
        stream.push({
          type: 'text_end',
          contentIndex: 0,
          content: fullText,
          partial,
        });
        stream.push({
          type: 'done',
          reason: hasToolCalls ? 'toolUse' : 'stop',
          message: partial,
        });
        bridgeLog.debug('Generation complete', {
          requestId,
          tokens: usage?.outputTokens,
          hasToolCalls,
        });
        break;
      }

      case 'LOCAL_LLM_ERROR': {
        const errorMsg =
          typeof message.error === 'string'
            ? message.error
            : String(message.error ?? 'Unknown error');
        emitError(errorMsg);
        break;
      }
    }
  };

  chrome.runtime.onMessage.addListener(listener);

  // Fire-and-forget: ensure offscreen document and send request
  ensureOffscreenDocument()
    .then(() => {
      if (settled) return;
      stream.push({ type: 'start', partial });
      stream.push({ type: 'text_start', contentIndex: 0, partial });

      chrome.runtime
        .sendMessage({
          type: 'LOCAL_LLM_GENERATE',
          requestId,
          modelId: opts.modelId,
          messages: opts.messages,
          systemPrompt: opts.systemPrompt,
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          device: opts.device,
          tools: opts.tools,
          supportsReasoning: opts.supportsReasoning,
        })
        .then(response => {
          const resp = response as Record<string, unknown> | undefined;
          if (!resp || !resp.ok) {
            emitError(
              `Offscreen document rejected LOCAL_LLM_GENERATE: ${resp?.error ?? 'no response'}`,
            );
          }
        })
        .catch(err => {
          emitError(
            `Failed to send LOCAL_LLM_GENERATE: ${err instanceof Error ? err.message : String(err)}`,
          );
        });

      bridgeLog.debug('Generation request sent', { requestId, modelId: opts.modelId });
    })
    .catch(err => {
      emitError(err instanceof Error ? err.message : String(err));
    });

  return stream;
};
