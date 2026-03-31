/**
 * GLM International SSE stream adapter — handles phase-based thinking/answer
 * content and wraps thinking in <think> tags for the XML parser.
 *
 * chat.z.ai SSE format:
 *   {"type":"chat:completion","data":{"delta_content":"...","phase":"thinking"}}
 *   {"type":"chat:completion","data":{"delta_content":"...","phase":"answer"}}
 *   {"type":"chat:completion","data":{"phase":"other","usage":{...}}}
 *
 * Key differences from GLM CN adapter:
 * - Incremental deltas (not cumulative) — no deduplication needed
 * - Phase field indicates thinking vs answer (not content type)
 * - Usage stats arrive in "other" phase with no delta_content
 *
 * GLM-Intl shares the same model family as GLM-CN and may produce the same
 * non-standard closing tags. We normalize per-chunk where possible; cross-chunk
 * cases (e.g. `</` in one delta, `tool_call >` in the next) are handled by
 * the shared xml-tag-parser's whitespace-tolerant regex.
 */

import type { SseStreamAdapter } from '../sse-stream-adapter';

/**
 * GLM uses non-standard closing tags for tool_call. Known variants:
 * - `</tool_call的工具结果>` — Chinese suffix ("tool result")
 * - `</tool_call〉` — fullwidth right angle bracket U+3009 instead of >
 * - `</tool_call＞` — fullwidth greater-than sign U+FF1E instead of >
 * - `</call'>` / `</call'>;` — truncated tag name (missing `tool_` prefix)
 * We normalize all variants to standard `</tool_call>`.
 */
const GLM_TOOL_CALL_CLOSE_RE = /<\/(?:tool_)?call[^>]*[>〉＞]/g;
const GLM_TOOL_CALL_CLOSE_STD = '</tool_call>';

const createGlmIntlStreamAdapter = (): SseStreamAdapter => {
  let thinkStarted = false;

  return {
    processEvent({ parsed }) {
      const obj = parsed as Record<string, unknown>;

      // Only process chat:completion events
      if (obj.type !== 'chat:completion') return null;

      const d = obj.data as Record<string, unknown> | undefined;
      if (!d) return null;

      // Detect error frames (e.g. MODEL_CONCURRENCY_LIMIT, rate limits)
      if (d.error) {
        const err = d.error as Record<string, unknown>;
        const detail = (err.detail ?? err.message ?? 'Unknown GLM error') as string;
        const code = err.code as string | undefined;
        throw new Error(code ? `${code}: ${detail}` : detail);
      }

      let delta = d.delta_content as string | undefined;
      const phase = d.phase as string | undefined;

      // Skip events without content (e.g., usage stats in "other" phase)
      if (!delta) return null;

      // Normalize non-standard closing tags within this chunk
      delta = delta.replace(GLM_TOOL_CALL_CLOSE_RE, GLM_TOOL_CALL_CLOSE_STD);

      // Transition: first thinking chunk → open <think> tag
      if (phase === 'thinking' && !thinkStarted) {
        thinkStarted = true;
        return { feedText: `<think>${delta}` };
      }

      // Transition: first answer chunk after thinking → close </think> tag
      if (phase === 'answer' && thinkStarted) {
        thinkStarted = false;
        return { feedText: `</think>${delta}` };
      }

      // Continuing in current mode
      return { feedText: delta };
    },

    flush() {
      // Close any unclosed think block
      if (thinkStarted) {
        thinkStarted = false;
        return { feedText: '</think>' };
      }
      return null;
    },

    shouldAbort: () => false,

    onFinish({ hasToolCalls, fullText }) {
      if (!hasToolCalls && !fullText) {
        return {
          error:
            'GLM returned an empty response. This usually means your account has been rate-limited or restricted. ' +
            'Please check your account status at chat.z.ai and try again.',
        };
      }
      return null;
    },
  };
};

export { createGlmIntlStreamAdapter };
