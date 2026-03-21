/**
 * GLM SSE stream adapter — handles cumulative text deduplication,
 * Chinese closing tag normalization, and error detection.
 *
 * GLM quirks:
 * 1. Each SSE event contains the FULL accumulated text, not a delta.
 *    We track the previous text and compute the actual delta.
 * 2. GLM outputs `</tool_call的工具结果>` (Chinese) instead of `</tool_call>`.
 *    We normalize this to standard XML so the tag parser can match it.
 * 3. Think content comes in `type: "think"` frames with a `think` field
 *    (not `text`), and is also cumulative. We extract think deltas and
 *    wrap them in `<think>...</think>` tags for the XML parser.
 */

import type { SseStreamAdapter } from '../sse-stream-adapter';

/**
 * GLM uses non-standard closing tags for tool_call. Known variants:
 * - `</tool_call的工具结果>` — Chinese suffix ("tool result")
 * - `</tool_call〉` — fullwidth right angle bracket U+3009 instead of >
 * - `</tool_call＞` — fullwidth greater-than sign U+FF1E instead of >
 * We normalize all variants to standard `</tool_call>`.
 */
const GLM_TOOL_CALL_CLOSE_RE = /<\/tool_call[^>]*[>〉＞]/g;
const GLM_TOOL_CALL_CLOSE_STD = '</tool_call>';

const createGlmStreamAdapter = (): SseStreamAdapter => {
  let prevText = '';
  let prevThink = '';
  let thinkStarted = false;

  return {
    processEvent({ parsed }) {
      const obj = parsed as Record<string, unknown>;

      // Detect error frames
      if (obj.error) {
        const err = obj.error as Record<string, unknown>;
        const msg = (err.message ?? 'Unknown GLM error') as string;
        throw new Error(msg);
      }

      const parts = obj.parts as
        | Array<{ content?: Array<{ type?: string; text?: string; think?: string }> }>
        | undefined;
      if (!parts || parts.length === 0) return null;

      const content = parts[0]?.content?.[0];
      if (!content) return null;

      // Handle think content (cumulative)
      if (content.type === 'think' && typeof content.think === 'string') {
        const fullThink = content.think;
        if (fullThink.length <= prevThink.length) return null;
        const thinkDelta = fullThink.slice(prevThink.length);
        prevThink = fullThink;

        // Wrap in <think> tags for the XML parser
        if (!thinkStarted) {
          thinkStarted = true;
          return { feedText: `<think>${thinkDelta}` };
        }
        return { feedText: thinkDelta };
      }

      // Handle text content (cumulative)
      if (content.type === 'text' && typeof content.text === 'string') {
        let fullText = content.text;

        // Close think block if transitioning from think to text
        let prefix = '';
        if (thinkStarted) {
          thinkStarted = false;
          prefix = '</think>';
        }

        // Normalize non-standard closing tags to standard </tool_call>
        fullText = fullText.replace(GLM_TOOL_CALL_CLOSE_RE, GLM_TOOL_CALL_CLOSE_STD);

        if (fullText.length <= prevText.length) {
          return prefix ? { feedText: prefix } : null;
        }
        const textDelta = fullText.slice(prevText.length);
        prevText = fullText;
        return { feedText: prefix + textDelta };
      }

      return null;
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
  };
};

export { createGlmStreamAdapter };
