/**
 * SSE stream adapter interface — allows provider-specific SSE processing
 * (e.g. Qwen phase tracking, native function_call interception) to be
 * encapsulated independently of the bridge.
 *
 * Adapter instances are created per-request via the provider's plugin.
 */

import { getPlugin } from './plugin-registry';
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
  const plugin = getPlugin(providerId);
  return plugin?.createStreamAdapter?.(opts) ?? createDefaultAdapter();
};

export { getSseStreamAdapter, createDefaultAdapter };
export type { SseStreamAdapter };
