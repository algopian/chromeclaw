/**
 * Gemini SSE stream adapter — handles cumulative text deduplication
 * and thinking content extraction.
 *
 * Gemini quirks:
 * 1. Response uses length-prefixed JSON chunks (not SSE), but content-fetch-main.ts
 *    converts these to SSE format before they reach the adapter.
 * 2. Each chunk contains the FULL accumulated text, not a delta.
 *    We track the previous text and compute the actual delta (like GLM).
 * 3. Text is deeply nested: outer[0][2] → parse inner JSON → inner[4][0][1]
 *
 * Actual response structure (from network capture):
 *   Outer: [["wrb.fr", null, "<inner_json_string>"]]
 *   Inner: [null, [conv_id, resp_id], null, null,
 *           [[candidate_id, [text_segments], null, ...metadata]],
 *           [geo_data], ...]
 *   Text:  inner[4][0][1] = ["Hello, Kyle. How can I help you today?"]
 *   Meta:  inner[1] = ["c_62b578147ba7dae2", "r_1ae5a46c89a9f484"]
 */

import type { SseStreamAdapter } from './sse-stream-adapter';

/**
 * Parse the inner JSON from a Gemini response chunk.
 * Outer structure: [["wrb.fr", null, "<inner_json_string>"]]
 * Returns the parsed inner array, or null if the chunk doesn't contain response data.
 */
const parseGeminiInner = (parsed: unknown): unknown[] | null => {
  try {
    const arr = parsed as unknown[];
    if (!Array.isArray(arr) || !arr[0] || !Array.isArray(arr[0])) return null;

    const inner = arr[0][2];
    if (typeof inner !== 'string') return null;

    const innerParsed = JSON.parse(inner);
    if (!Array.isArray(innerParsed)) return null;
    return innerParsed;
  } catch {
    return null;
  }
};

/**
 * Extract text from a Gemini response chunk.
 * Text location: inner[4][0][1] — array of text segments to join.
 *
 * inner[4] = candidates array
 * inner[4][0] = first candidate: [candidate_id, [text_segments], ...metadata]
 * inner[4][0][0] = candidate ID string (e.g. "rc_d2402728d8be91a2")
 * inner[4][0][1] = text segments array (e.g. ["Hello, Kyle."])
 */
const extractGeminiText = (parsed: unknown): string | null => {
  const inner = parseGeminiInner(parsed);
  if (!inner) return null;

  try {
    const candidates = inner[4];
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    const firstCandidate = candidates[0];
    if (!Array.isArray(firstCandidate)) return null;

    const textArr = firstCandidate[1];
    if (Array.isArray(textArr) && textArr.length > 0) {
      return textArr.join('');
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Extract conversation metadata from a Gemini response chunk.
 * Location: inner[1] = [conversationId, responseId]
 */
const extractGeminiConversationMeta = (
  parsed: unknown,
): { conversationId?: string; responseId?: string } | null => {
  const inner = parseGeminiInner(parsed);
  if (!inner) return null;

  const meta = inner[1];
  if (!Array.isArray(meta)) return null;

  return {
    conversationId: typeof meta[0] === 'string' ? meta[0] : undefined,
    responseId: typeof meta[1] === 'string' ? meta[1] : undefined,
  };
};

const createGeminiStreamAdapter = (): SseStreamAdapter => {
  let prevText = '';
  /** Length of bare "think\n..." prefix to skip (Gemini native CoT leak). */
  let thinkPrefixLen = 0;
  /** Whether we've finished detecting the think prefix. */
  let prefixResolved = false;
  /** Whether a complete </tool_call> was seen — signals bridge to abort early. */
  let hasCompleteToolCall = false;

  return {
    processEvent({ parsed }) {
      // Handle text content (cumulative — each chunk has full text so far)
      const fullText = extractGeminiText(parsed);
      if (fullText === null) return null;

      if (fullText.length <= prevText.length) return null;

      // Gemini sometimes prefixes cumulative text with bare "think\n" (its native
      // chain-of-thought without XML tags), followed later by proper <think>...</think>.
      // Suppress the bare prefix so only the XML-tagged thinking reaches the parser.
      if (!prefixResolved) {
        if (fullText.startsWith('think\n')) {
          const tagIdx = fullText.indexOf('<think>');
          if (tagIdx < 0) {
            // Still in bare thinking prefix — suppress output
            prevText = fullText;
            return null;
          }
          // Found <think> tag — skip everything before it
          thinkPrefixLen = tagIdx;
        }
        prefixResolved = true;
      }

      // Compute delta from the effective text (after skipping bare think prefix)
      const effectiveFull = fullText.slice(thinkPrefixLen);
      const effectivePrev = prevText.length > thinkPrefixLen
        ? prevText.slice(thinkPrefixLen)
        : '';

      prevText = fullText;

      if (effectiveFull.length <= effectivePrev.length) return null;

      const textDelta = effectiveFull.slice(effectivePrev.length);

      // Detect complete tool calls so shouldAbort can signal the bridge
      if (textDelta.includes('</tool_call>')) {
        hasCompleteToolCall = true;
      }

      return { feedText: textDelta };
    },

    flush: () => null,

    // Abort the stream once a tool call is fully received, so the bridge
    // can execute the tool without waiting for Gemini's trailing metadata chunks.
    shouldAbort: () => hasCompleteToolCall,
  };
};

export { createGeminiStreamAdapter, extractGeminiText, extractGeminiConversationMeta };
