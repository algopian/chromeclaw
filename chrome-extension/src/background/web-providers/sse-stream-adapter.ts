/**
 * SSE stream adapter interface — allows provider-specific SSE processing
 * (e.g. Qwen phase tracking, native function_call interception) to be
 * encapsulated independently of the bridge.
 */

import { createClaudeStreamAdapter } from './claude-stream-adapter';
import { createGeminiStreamAdapter } from './gemini-stream-adapter';
import { createGlmStreamAdapter } from './glm-stream-adapter';
import { createKimiStreamAdapter } from './kimi-stream-adapter';
import { createQwenStreamAdapter } from './qwen-stream-adapter';
import type { WebProviderId } from './types';

interface SseStreamAdapter {
  /** Process a single SSE event. Return feedText to pass to the XML parser, or null to skip. */
  processEvent(input: { parsed: unknown; delta: string | null }): { feedText: string } | null;
  /** Flush any remaining state (e.g. unclosed think block). */
  flush(): { feedText: string } | null;
  /**
   * Whether the bridge should abort the SSE stream early.
   *
   * Returns true when the provider attempted native tool calls that failed
   * (e.g. Qwen's "Tool X does not exists" responses). Everything Qwen
   * generates after that point is based on the wrong assumption that tools
   * are unavailable, so the bridge should stop processing, let the agent
   * loop execute the real tools, and retry with actual results.
   */
  shouldAbort(): boolean;
}

const createDefaultAdapter = (): SseStreamAdapter => ({
  processEvent: ({ delta }) => (delta ? { feedText: delta } : null),
  flush: () => null,
  shouldAbort: () => false,
});

const getSseStreamAdapter = (providerId: WebProviderId): SseStreamAdapter => {
  switch (providerId) {
    case 'claude-web':
      return createClaudeStreamAdapter();
    case 'qwen-web':
    case 'qwen-cn-web':
      return createQwenStreamAdapter();
    case 'kimi-web':
      return createKimiStreamAdapter();
    case 'glm-web':
    case 'glm-intl-web':
      return createGlmStreamAdapter();
    case 'gemini-web':
      return createGeminiStreamAdapter();
    default:
      return createDefaultAdapter();
  }
};

export { getSseStreamAdapter, createDefaultAdapter };
export type { SseStreamAdapter };
