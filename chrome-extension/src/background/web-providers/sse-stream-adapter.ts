/**
 * SSE stream adapter interface — allows provider-specific SSE processing
 * (e.g. Qwen phase tracking, native function_call interception) to be
 * encapsulated independently of the bridge.
 */

import { createClaudeStreamAdapter } from './providers/claude-web-stream-adapter';
import { createChatGPTStreamAdapter } from './providers/chatgpt-stream-adapter';
import { createDeepSeekStreamAdapter } from './providers/deepseek-stream-adapter';
import { createDoubaoStreamAdapter } from './providers/doubao-stream-adapter';
import { createGeminiStreamAdapter } from './providers/gemini-web-stream-adapter';
import { createGlmIntlStreamAdapter } from './providers/glm-intl-stream-adapter';
import { createGlmStreamAdapter } from './providers/glm-stream-adapter';
import { createKimiStreamAdapter } from './providers/kimi-web-stream-adapter';
import { createQwenStreamAdapter } from './providers/qwen-stream-adapter';
import { createRakutenStreamAdapter } from './providers/rakuten-stream-adapter';
import type { WebProviderId } from './types';

interface SseStreamAdapter {
  /** Process a single SSE event. Return feedText to pass to the XML parser, or null to skip. */
  processEvent(input: { parsed: unknown; delta: string | null }): { feedText: string } | null;
  /** Flush any remaining state (e.g. unclosed think block). */
  flush(): { feedText: string } | null;
  /**
   * Whether the bridge should abort the SSE stream early.
   *
   * Returns true when the provider attempted native tool calls that were
   * intercepted by the adapter (e.g. Qwen's built-in web_search) or that
   * failed (e.g. Qwen's "Tool X does not exists" responses). Everything
   * the provider generates after native tool calls is based on its own
   * results, not ours, so the bridge should stop processing and let the
   * agent loop execute the real tools with actual results.
   */
  shouldAbort(): boolean;
  /** Flush all pending native function calls as XML tool_calls. Used before aborting. */
  flushPendingCalls?(): { feedText: string } | null;

  /**
   * Per-provider suppression rules for post-tool-call content.
   * When true, the corresponding event type is discarded after a real tool_call is parsed.
   * Defaults to `{ text: true, malformed: true }` when unset.
   */
  suppressAfterToolCalls?: {
    text?: boolean;
    malformed?: boolean;
  };

  /**
   * Called at stream end, after adapter + XML parser flush.
   * Allows provider-specific finalization:
   * - Return `{ promotedText }` to replace empty text with the given content.
   * - Return `{ error }` to abort with an error (e.g. empty response from provider).
   * - Return null for no-op.
   */
  onFinish?(state: {
    hasToolCalls: boolean;
    fullText: string;
    thinkingContent: string | undefined;
  }): { promotedText: string } | { error: string } | null;
}

const createDefaultAdapter = (): SseStreamAdapter => ({
  processEvent: ({ delta }) => (delta ? { feedText: delta } : null),
  flush: () => null,
  shouldAbort: () => false,
});

const getSseStreamAdapter = (
  providerId: WebProviderId,
  opts?: {
    /** Tool names excluded from the prompt — Qwen adapter skips native interception for these. */
    excludeTools?: ReadonlySet<string>;
  },
): SseStreamAdapter => {
  switch (providerId) {
    case 'claude-web':
      return createClaudeStreamAdapter();
    case 'chatgpt-web':
      return createChatGPTStreamAdapter();
    case 'qwen-web':
    case 'qwen-cn-web':
      return createQwenStreamAdapter({ skipNativeTools: opts?.excludeTools });
    case 'kimi-web':
      return createKimiStreamAdapter();
    case 'glm-web':
      return createGlmStreamAdapter();
    case 'glm-intl-web':
      return createGlmIntlStreamAdapter();
    case 'deepseek-web':
      return createDeepSeekStreamAdapter();
    case 'doubao-web':
      return createDoubaoStreamAdapter();
    case 'gemini-web':
      return createGeminiStreamAdapter();
    case 'rakuten-web':
      return createRakutenStreamAdapter();
    default:
      return createDefaultAdapter();
  }
};

export { getSseStreamAdapter, createDefaultAdapter };
export type { SseStreamAdapter };
