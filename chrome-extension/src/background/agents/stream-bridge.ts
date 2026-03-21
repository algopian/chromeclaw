/**
 * StreamFn bridge: uses pi-ai's native streamSimple() to produce
 * AssistantMessageEventStream compatible with pi-agent's agent loop.
 *
 * streamSimple() natively handles provider routing, message conversion,
 * tool definitions, and event emission — no manual bridging needed.
 */

import { chatModelToPiModel } from './model-adapter';
import { requestLocalGeneration } from '../local-llm-bridge';
import { createLogger } from '../logging/logger-buffer';
import { getToolStrategy } from '../web-providers/tool-strategy';
import { requestWebGeneration } from '../web-providers/web-llm-bridge';
import type { WebProviderToolStrategy } from '../web-providers/tool-strategy';
import type { WebProviderId } from '../web-providers/types';
import {
  streamSimple,
  completeSimple,
  createAssistantMessageEventStream,
} from '@mariozechner/pi-ai';
import type { ChatModel } from '@extension/shared';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import type {
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ToolResultMessage,
} from '@mariozechner/pi-ai';

const bridgeLog = createLogger('stream');

/**
 * Install a global fetch interceptor that appends `api-version` to Azure OpenAI
 * requests. Azure requires this query parameter but the standard OpenAI SDK client
 * doesn't add it. We use the standard client (not AzureOpenAI) because Azure
 * endpoints accept Bearer token auth, which AzureOpenAI replaces with api-key header.
 *
 * The interceptor is idempotent — it only modifies Azure URLs that don't already
 * have the `api-version` parameter, and has zero effect on non-Azure requests.
 */
let _azureApiVersion: string | undefined;

const setAzureApiVersion = (version: string | undefined): void => {
  _azureApiVersion = version;
};

const _originalFetch = globalThis.fetch;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  if (_azureApiVersion) {
    try {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(urlStr);
      if (url.hostname.endsWith('.openai.azure.com') && !url.searchParams.has('api-version')) {
        url.searchParams.set('api-version', _azureApiVersion);
        if (typeof input === 'string' || input instanceof URL) {
          return _originalFetch(url.toString(), init);
        }
        return _originalFetch(new Request(url.toString(), input), init);
      }
    } catch {
      // URL parse failed, pass through
    }
  }
  return _originalFetch(input, init);
};

/**
 * Convert pi-agent Context messages to simple {role, content} pairs.
 * Shared by local and web provider branches — both need flat text messages
 * with tool calls serialized as XML tags.
 */
const TOOL_CALL_HINT =
  '\n\n[SYSTEM HINT]: Keep in mind your available tools. To use a tool, you MUST output the EXACT XML format: <tool_call id="unique_id" name="tool_name">{"arg": "value"}</tool_call>.';

const contextToSimpleMessages = (
  context: Context,
  toolStrategy?: WebProviderToolStrategy,
): Array<{ role: string; content: string }> =>
  context.messages.map(m => {
    if (m.role === 'toolResult') {
      const tr = m as ToolResultMessage;
      const resultText = (tr.content ?? [])
        .filter(c => c.type === 'text')
        .map(c => (c as TextContent).text)
        .join('');
      const wrapped = `<tool_response id="${tr.toolCallId}" name="${tr.toolName}">\n${resultText}\n</tool_response>${TOOL_CALL_HINT}`;
      return { role: 'user' as const, content: wrapped };
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      // Use strategy-specific serialization if available (e.g. Qwen preserves <think> blocks)
      if (toolStrategy?.serializeAssistantContent) {
        return {
          role: 'assistant' as const,
          content: toolStrategy.serializeAssistantContent(m.content as any),
        };
      }
      const parts: string[] = [];
      for (const c of m.content) {
        if (c.type === 'text') parts.push((c as TextContent).text);
        else if (c.type === 'toolCall') {
          parts.push(
            `<tool_call id="${c.id}" name="${c.name}">${JSON.stringify(c.arguments)}</tool_call>`,
          );
        }
      }
      return { role: 'assistant' as const, content: parts.join('') };
    }
    return {
      role: m.role as string,
      content:
        typeof m.content === 'string'
          ? m.content
          : (m.content ?? [])
              .filter(c => c.type === 'text')
              .map(c => (c as TextContent).text)
              .join(''),
    };
  });

/** Convert pi-agent tool definitions to OpenAI function-calling schema. */
const contextToFunctionTools = (context: Context) =>
  (context.tools ?? []).map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

/** Create an error stream for non-cloud providers instead of throwing. */
const createProviderErrorStream = (
  api: string,
  provider: string,
  modelId: string,
  errorMsg: string,
) => {
  const errorStream = createAssistantMessageEventStream();
  errorStream.push({
    type: 'error',
    reason: 'error',
    error: {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      api,
      provider,
      model: modelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'error',
      errorMessage: errorMsg,
      timestamp: Date.now(),
    },
  });
  return errorStream;
};

/**
 * Create a StreamFn using pi-mono's native streaming.
 * For cloud providers, streamSimple() already returns AssistantMessageEventStream.
 * For local/web models, routes to the offscreen document or tab-context bridge.
 */
export const createStreamFn = (modelConfig: ChatModel, chatId?: string): StreamFn => {
  if (modelConfig.provider === 'web') {
    const webStrategy = modelConfig.webProviderId
      ? getToolStrategy(modelConfig.webProviderId as WebProviderId)
      : undefined;
    return (_model: Model<any>, context: Context) => {
      try {
        const messages = contextToSimpleMessages(context, webStrategy);
        const tools = contextToFunctionTools(context);

        bridgeLog.trace('Web provider call', {
          modelId: modelConfig.id,
          webProviderId: modelConfig.webProviderId,
          messageCount: messages.length,
          toolCount: tools.length,
          systemPromptLength: (context.systemPrompt ?? '').length,
        });

        return requestWebGeneration({
          modelConfig,
          messages,
          systemPrompt: context.systemPrompt ?? '',
          tools: tools.length > 0 ? tools : undefined,
          supportsReasoning: modelConfig.supportsReasoning,
          chatId,
        });
      } catch (err) {
        console.error('[stream-bridge] Web LLM streamFn error:', err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        return createProviderErrorStream(
          'web-session',
          'web',
          modelConfig.id,
          `Web LLM error: ${errorMsg}`,
        );
      }
    };
  }

  if (modelConfig.provider === 'local') {
    return (_model: Model<any>, context: Context) => {
      try {
        const messages = contextToSimpleMessages(context);
        const tools = contextToFunctionTools(context);

        // Validate device preference — only pass recognized values
        const device =
          modelConfig.baseUrl === 'webgpu' || modelConfig.baseUrl === 'wasm'
            ? modelConfig.baseUrl
            : undefined;

        bridgeLog.trace('Local provider call', {
          modelId: modelConfig.id,
          device,
          messageCount: messages.length,
          toolCount: tools.length,
          systemPromptLength: (context.systemPrompt ?? '').length,
        });

        return requestLocalGeneration({
          modelId: modelConfig.id,
          messages,
          systemPrompt: context.systemPrompt ?? '',
          device,
          tools: tools.length > 0 ? tools : undefined,
          supportsReasoning: modelConfig.supportsReasoning,
        });
      } catch (err) {
        console.error('[stream-bridge] Local LLM streamFn error:', err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        return createProviderErrorStream(
          'local-transformers',
          'local',
          modelConfig.id,
          `Local LLM error: ${errorMsg}`,
        );
      }
    };
  }

  const { model, apiKey, azureApiVersion } = chatModelToPiModel(modelConfig);

  return (_model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
    bridgeLog.trace('Provider call', {
      modelId: model.id,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      hasApiKey: !!apiKey || !!options?.apiKey,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    });
    // Set Azure api-version for the fetch interceptor (if applicable)
    setAzureApiVersion(azureApiVersion);
    return streamSimple(model, context, { ...options, apiKey });
  };
};

/**
 * Non-streaming completion helper for summarizer/journal.
 * Not supported for local models — they only support streaming via the offscreen document.
 */
export const completeText = async (
  modelConfig: ChatModel,
  systemPrompt: string,
  userContent: string,
  opts?: { maxTokens?: number },
): Promise<string> => {
  if (modelConfig.provider === 'local' || modelConfig.provider === 'web') {
    throw new Error(
      `completeText is not supported for ${modelConfig.provider} models. Use streaming via createStreamFn instead.`,
    );
  }

  const { model, apiKey, azureApiVersion } = chatModelToPiModel(modelConfig);
  setAzureApiVersion(azureApiVersion);
  const context: Context = {
    systemPrompt,
    messages: [{ role: 'user', content: userContent, timestamp: Date.now() }],
  };
  const result = await completeSimple(model, context, {
    maxTokens: opts?.maxTokens,
    apiKey,
  });
  return result.content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('');
};
