/**
 * Web LLM Bridge — runtime bridge for web-based LLM providers.
 * Returns an AssistantMessageEventStream so web providers plug into
 * the existing agent loop without changes.
 *
 * Flow:
 * 1. Look up provider from registry
 * 2. Get credentials from storage
 * 3. If tools provided, inject XML tool defs into system prompt
 * 4. Find/create background tab at provider domain
 * 5. Inject relay script (ISOLATED world) then fetch script (MAIN world)
 * 6. Listen for SSE chunks via chrome.runtime.onMessage
 * 7. Parse SSE → extract delta via provider's parseSseDelta → feed XML parser → emit stream events
 */

import { getWebCredential } from './auth';
import { mainWorldFetch } from './content-fetch-main';
import { installRelay } from './content-fetch-relay';
import { getWebProvider } from './registry';
import { getSseStreamAdapter } from './sse-stream-adapter';
import { createSseParser } from './sse-parser';
import {
  getToolStrategy,
  getConversationId,
  setConversationId,
  clearConversationId,
} from './tool-strategy';
import { createXmlTagParser } from './xml-tag-parser';
import { createAssistantMessageEventStream } from '../agents';
import { createLogger } from '../logging/logger-buffer';
import type { AssistantMessage, AssistantMessageEventStream, TextContent } from '../agents';
import type { ContentFetchRequest } from './content-fetch-main';
import type { WebProviderId } from './types';
import type { ParsedEvent } from './xml-tag-parser';
import type { ChatModel } from '@extension/shared';

const bridgeLog = createLogger('web-llm');

/** Default timeout for web generation (5 minutes). */
const WEB_LLM_TIMEOUT_MS = 300_000;

export const requestWebGeneration = (opts: {
  modelConfig: ChatModel;
  messages: Array<{ role: string; content: string }>;
  systemPrompt: string;
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: unknown };
  }>;
  supportsReasoning?: boolean;
  /** Chat ID for conversation caching — allows conversation ID reuse across turns. */
  chatId?: string;
}): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();
  const requestId = crypto.randomUUID();

  const textContent: TextContent = { type: 'text', text: '' };
  const partial: AssistantMessage = {
    role: 'assistant',
    content: [textContent],
    api: 'web-session',
    provider: 'web',
    model: opts.modelConfig.id,
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
  const xmlParser = createXmlTagParser();
  const sseParser = createSseParser();
  let hasToolCalls = false;

  // Cache provider lookup once — used by the chunk listener
  const cachedProviderId = opts.modelConfig.webProviderId as WebProviderId;
  const adapter = getSseStreamAdapter(cachedProviderId);
  const cachedProvider = cachedProviderId ? getWebProvider(cachedProviderId) : undefined;
  const strategy = cachedProviderId ? getToolStrategy(cachedProviderId) : undefined;
  const cacheKey = cachedProviderId ? `${cachedProviderId}:${opts.chatId ?? requestId}` : '';

  if (cachedProviderId) {
    bridgeLog.debug('Using tool strategy', { requestId, providerId: cachedProviderId });
  }

  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    chrome.runtime.onMessage.removeListener(listener);
  };

  /** Flush adapter + XML parser, emit text_end + done, and clean up the listener. */
  const finishStream = (reason: 'toolUse' | 'stop') => {
    const adapterFlush = adapter.flush();
    if (adapterFlush) emitParsedEvents(xmlParser.feed(adapterFlush.feedText));
    emitParsedEvents(xmlParser.flush());
    textContent.text = fullText;

    cleanup();
    stream.push({ type: 'text_end', contentIndex: 0, content: fullText, partial });
    stream.push({ type: 'done', reason, message: partial });
  };

  const emitError = (errorMsg: string) => {
    cleanup();
    bridgeLog.error('Web generation error', { requestId, error: errorMsg });
    const errorMessage: AssistantMessage = {
      ...partial,
      stopReason: 'error',
      errorMessage: errorMsg,
    };
    stream.push({ type: 'error', reason: 'error', error: errorMessage });
  };

  const timeout = setTimeout(() => {
    emitError(`Web generation timed out after ${WEB_LLM_TIMEOUT_MS / 1000}s`);
  }, WEB_LLM_TIMEOUT_MS);

  /** Translate parsed events from the shared XML parser into stream events. */
  const emitParsedEvents = (events: ParsedEvent[]) => {
    for (const event of events) {
      if (event.type === 'tool_call') {
        bridgeLog.debug('Parsed tool_call', { requestId, id: event.id, name: event.name });
      } else if (event.type === 'tool_call_malformed') {
        bridgeLog.warn('Malformed tool_call', { requestId, rawText: event.rawText.slice(0, 300) });
      }
      switch (event.type) {
        case 'text':
          // Suppress text emitted after tool calls — likely hallucinated content
          // based on fake <tool_response> blocks the model generated inline.
          // The agent loop will re-prompt with real tool results on the next turn.
          if (hasToolCalls) break;
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
      case 'WEB_LLM_CHUNK': {
        const chunk = message.chunk;
        if (typeof chunk !== 'string') return;

        // Parse SSE lines from chunk
        const sseEvents = sseParser.feed(chunk);
        if (!cachedProvider) return;

        for (const sseEvent of sseEvents) {
          if (sseEvent.data === '[DONE]') continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(sseEvent.data);
          } catch {
            // Non-JSON SSE data — try feeding as raw text delta
            if (sseEvent.data) {
              emitParsedEvents(xmlParser.feed(sseEvent.data));
            }
            continue;
          }

          // Log full SSE response structure (first few events only to avoid spam)
          bridgeLog.trace('SSE raw event', {
            requestId,
            data: JSON.stringify(parsed).slice(0, 1000),
          });

          // Extract conversation ID if strategy supports it
          if (strategy?.extractConversationId && cacheKey) {
            const convId = strategy.extractConversationId(parsed);
            if (convId) {
              bridgeLog.debug('Conversation ID captured', {
                requestId,
                cacheKey,
                conversationId: convId,
              });
              setConversationId(cacheKey, convId);
            }
          }

          try {
            const delta = cachedProvider.parseSseDelta(parsed);
            const output = adapter.processEvent({ parsed, delta });
            if (output) {
              bridgeLog.trace('SSE delta', { requestId, delta: output.feedText.slice(0, 500) });
              emitParsedEvents(xmlParser.feed(output.feedText));
            }
          } catch (adapterErr) {
            // Adapter threw — surface as stream error (e.g. GLM error frame)
            emitError(adapterErr instanceof Error ? adapterErr.message : String(adapterErr));
            return;
          }

          // Abort early when the provider attempted native tool calls that were
          // intercepted (e.g. Qwen's built-in web_search) or that failed
          // (e.g. Qwen's "Tool X does not exists"). Everything generated after
          // this point is based on the provider's own results, not ours.
          // Stop processing, let the agent loop execute real tools and retry.
          if (adapter.shouldAbort() && hasToolCalls) {
            bridgeLog.debug('Aborting stream early — native tool call intercepted', {
              requestId,
              hasToolCalls,
            });

            // Flush any remaining pending native calls as tool_calls
            // (handles parallel calls where only the first response triggered abort)
            if (adapter.flushPendingCalls) {
              const flushed = adapter.flushPendingCalls();
              if (flushed) {
                emitParsedEvents(xmlParser.feed(flushed.feedText));
              }
            }

            // Clear conversation ID so next turn uses full history aggregation
            // instead of reusing the contaminated server-side session.
            if (cacheKey) {
              clearConversationId(cacheKey);
              bridgeLog.debug('Cleared conversation ID after native tool interception', {
                requestId,
                cacheKey,
              });
            }

            finishStream('toolUse');
            return;
          }
        }
        break;
      }

      case 'WEB_LLM_DONE': {
        // Flush SSE parser first — drain any buffered data line that lacked a trailing newline
        const remainingSseEvents = sseParser.flush();
        if (remainingSseEvents.length > 0) {
          bridgeLog.trace('SSE parser flushed remaining events', {
            requestId,
            count: remainingSseEvents.length,
            preview: remainingSseEvents.map(e => e.data.slice(0, 100)),
          });
        }
        if (cachedProvider) {
          for (const sseEvent of remainingSseEvents) {
            if (sseEvent.data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(sseEvent.data);
              const delta = cachedProvider.parseSseDelta(parsed);
              if (delta) {
                emitParsedEvents(xmlParser.feed(delta));
              }
            } catch {
              if (sseEvent.data) {
                emitParsedEvents(xmlParser.feed(sseEvent.data));
              }
            }
          }
        }

        finishStream(hasToolCalls ? 'toolUse' : 'stop');
        bridgeLog.debug('Web generation complete', { requestId, hasToolCalls });
        break;
      }

      case 'WEB_LLM_ERROR': {
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

  // Async setup — find/create tab, inject scripts, start fetch
  (async () => {
    try {
      const providerId = opts.modelConfig.webProviderId as WebProviderId;
      if (!providerId) {
        emitError('No webProviderId configured on model');
        return;
      }

      const provider = getWebProvider(providerId);
      if (!provider) {
        emitError(`Unknown web provider: ${providerId}`);
        return;
      }

      const storedCredential = await getWebCredential(providerId);
      if (!storedCredential) {
        emitError(
          `Not logged in to ${provider.name}. ` +
            `Make sure you have an account and can use the model at ${provider.loginUrl}, ` +
            `then connect your session via Settings → Models.`,
        );
        return;
      }

      // Clone to avoid mutating the stored object, then refresh cookies from browser
      // to pick up rotated tokens (e.g. kimi-auth refreshed by the provider's frontend)
      const credential = { ...storedCredential, cookies: { ...storedCredential.cookies } };
      try {
        const freshCookies = await chrome.cookies.getAll({ domain: provider.cookieDomain });
        const freshMap = Object.fromEntries(freshCookies.map(c => [c.name, c.value]));
        for (const name of provider.sessionIndicators) {
          if (freshMap[name]) credential.cookies[name] = freshMap[name];
        }
      } catch {
        bridgeLog.warn('Failed to refresh cookies', { requestId, providerId });
      }

      // Build tool prompt and assemble final prompt via the provider's tool strategy
      const providerStrategy = getToolStrategy(providerId);
      let toolPrompt = '';
      if (opts.tools && opts.tools.length > 0) {
        const toolDefs = opts.tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters as Record<string, unknown>,
        }));
        toolPrompt = providerStrategy.buildToolPrompt(toolDefs);
      }

      const conversationId = getConversationId(cacheKey);
      const { systemPrompt: finalSystemPrompt, messages: finalMessages } =
        providerStrategy.buildPrompt({
          systemPrompt: opts.systemPrompt,
          toolPrompt,
          messages: opts.messages,
          conversationId,
        });

      // Build the provider-specific request (may include setupRequest for two-step flows)
      const { url, init, setupRequest, urlTemplate, binaryProtocol, binaryEncodeBody } =
        provider.buildRequest({
          messages: finalMessages,
          systemPrompt: finalSystemPrompt,
          credential,
          conversationId,
        });

      // Find or create a tab at the provider domain
      const providerOrigin = new URL(provider.loginUrl).origin;
      const tabs = await chrome.tabs.query({ url: `${provider.loginUrl}/*` });
      let tabId: number;
      if (tabs.length > 0 && tabs[0].id) {
        tabId = tabs[0].id;
      } else {
        const newTab = await chrome.tabs.create({
          url: provider.loginUrl,
          active: false,
        });
        if (!newTab.id) {
          emitError('Failed to create provider tab');
          return;
        }
        tabId = newTab.id;
        // Wait for tab to load (with 30s timeout to avoid hanging)
        const TAB_LOAD_TIMEOUT_MS = 30_000;
        await new Promise<void>((resolve, reject) => {
          const loadTimeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            reject(
              new Error(
                `Provider tab did not finish loading within ${TAB_LOAD_TIMEOUT_MS / 1000}s`,
              ),
            );
          }, TAB_LOAD_TIMEOUT_MS);
          const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
            if (id === tabId && info.status === 'complete') {
              clearTimeout(loadTimeout);
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
        });
      }

      // Inject relay script (ISOLATED world) first — pass origin for validation and timeout
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: installRelay,
        args: [requestId, providerOrigin, WEB_LLM_TIMEOUT_MS + 30_000],
      });

      // Inject and execute fetch in MAIN world
      const fetchRequest: ContentFetchRequest = {
        type: 'WEB_LLM_FETCH',
        requestId,
        url,
        init,
        setupRequest,
        urlTemplate,
        binaryProtocol,
        binaryEncodeBody,
      };

      if (binaryProtocol) {
        bridgeLog.debug('Using binary protocol', {
          requestId,
          protocol: binaryProtocol,
          encodeBody: binaryEncodeBody,
        });
      }

      stream.push({ type: 'start', partial });
      stream.push({ type: 'text_start', contentIndex: 0, partial });

      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: mainWorldFetch,
        args: [fetchRequest],
      });

      bridgeLog.debug('Web generation request sent', {
        requestId,
        provider: providerId,
        tabId,
      });
    } catch (err) {
      emitError(err instanceof Error ? err.message : String(err));
    }
  })();

  return stream;
};
