/**
 * DeepSeek SSE stream adapter — handles JSON-patch style events,
 * reasoning/thinking content, and junk token filtering.
 *
 * chat.deepseek.com SSE format (JSON-patch style):
 *   {"v":{"response":{"fragments":[{"type":"THINK","content":"We",...}]}}}  — initial fragments
 *   {"p":"response/fragments/-1/content","o":"APPEND","v":" text"}         — fragment content delta
 *   {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE",...}]}  — new fragment (think→text transition)
 *   {"v":"bare text"}                                                       — shorthand text delta (no `p`)
 *   {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":4.7}           — metadata (ignored)
 *   {"p":"response","o":"BATCH","v":[...]}                                  — batch status (ignored)
 *
 * Fragment types: "THINK" = reasoning, "RESPONSE" = text output
 * The `p` field is a string path (not array) in the actual API.
 *
 * Key differences from other providers:
 * - Uses JSON-patch paths (string) instead of OpenAI `choices` format
 * - Fragment type transitions (THINK → RESPONSE) signal thinking boundaries
 * - Special junk tokens need filtering: `<｜end▁of▁thinking｜>`, `<|endoftext|>`
 */

import type { SseStreamAdapter } from '../sse-stream-adapter';

/** Junk tokens emitted by DeepSeek that should be silently stripped. */
const JUNK_TOKENS = new Set(['<｜end▁of▁thinking｜>', '<|endoftext|>']);

/** Strip junk tokens from a delta string. */
const stripJunk = (text: string): string => {
  if (JUNK_TOKENS.has(text)) return '';
  for (const junk of JUNK_TOKENS) {
    if (text.includes(junk)) {
      text = text.replaceAll(junk, '');
    }
  }
  return text;
};

const createDeepSeekStreamAdapter = (): SseStreamAdapter => {
  let inThinking = false;

  return {
    processEvent({ parsed }) {
      const obj = parsed as Record<string, unknown>;

      // --- Conversation continuity metadata (passthrough for extractConversationId) ---
      // The bridge's extractConversationId will pick up response_message_id

      // The `p` field can be either a JSON-patch path string (e.g. "response/fragments/-1/content")
      // or an array (e.g. ["content"]). Normalize to string for matching.
      const pRaw = obj.p as string | string[] | undefined;
      const pStr = Array.isArray(pRaw) ? pRaw.join('/') : pRaw;

      // --- Nested fragments (initial response + new fragment appends) ---
      // Must be checked BEFORE text/thinking handlers because these events carry
      // fragment type info (THINK vs RESPONSE) that determines the thinking state.

      // Initial response with fragments array
      const responseObj = (obj.v as Record<string, unknown>)?.response as
        | { fragments?: Array<{ type?: string; content?: string }> }
        | undefined;
      if (responseObj?.fragments && Array.isArray(responseObj.fragments)) {
        const parts: string[] = [];
        for (const frag of responseObj.fragments) {
          const content = stripJunk(frag.content ?? '');
          if (!content) continue;

          if (frag.type === 'THINK' || frag.type === 'THINKING' || frag.type === 'reasoning') {
            if (!inThinking) {
              inThinking = true;
              parts.push('<think>');
            }
            parts.push(content);
          } else {
            if (inThinking) {
              inThinking = false;
              parts.push('</think>');
            }
            parts.push(content);
          }
        }
        return parts.length > 0 ? { feedText: parts.join('') } : null;
      }

      // New fragment appended via JSON-patch: {"p":"response/fragments","o":"APPEND","v":[{...}]}
      if (pStr === 'response/fragments' && obj.o === 'APPEND' && Array.isArray(obj.v)) {
        const parts: string[] = [];
        for (const frag of obj.v as Array<{ type?: string; content?: string }>) {
          const content = stripJunk(frag.content ?? '');

          if (frag.type === 'THINK' || frag.type === 'THINKING' || frag.type === 'reasoning') {
            if (!inThinking) {
              inThinking = true;
              parts.push('<think>');
            }
            if (content) parts.push(content);
          } else if (frag.type === 'RESPONSE' || frag.type === 'TEXT' || frag.type === 'text') {
            if (inThinking) {
              inThinking = false;
              parts.push('</think>');
            }
            if (content) parts.push(content);
          } else {
            if (content) parts.push(content);
          }
        }
        return parts.length > 0 ? { feedText: parts.join('') } : null;
      }

      // --- Fragment content delta (JSON-patch APPEND/SET on fragment content) ---
      // e.g. {"p":"response/fragments/-1/content","o":"APPEND","v":" text"}
      // These are continuations of the CURRENT fragment — use inThinking state.
      if (
        pStr &&
        /^response\/fragments\/-?\d+\/content$/.test(pStr) &&
        typeof obj.v === 'string'
      ) {
        const delta = stripJunk(obj.v);
        if (!delta) return null;
        return { feedText: delta };
      }

      // --- Reasoning / thinking content (array-style path) ---
      if (pStr?.includes('reasoning') && typeof obj.v === 'string') {
        const delta = stripJunk(obj.v);
        if (!delta) return null;
        if (!inThinking) {
          inThinking = true;
          return { feedText: `<think>${delta}` };
        }
        return { feedText: delta };
      }

      if (obj.type === 'thinking' && typeof obj.v === 'string') {
        const delta = stripJunk(obj.v);
        if (!delta) return null;
        if (!inThinking) {
          inThinking = true;
          return { feedText: `<think>${delta}` };
        }
        return { feedText: delta };
      }

      if (obj.type === 'thinking' && typeof obj.content === 'string') {
        const delta = stripJunk(obj.content);
        if (!delta) return null;
        if (!inThinking) {
          inThinking = true;
          return { feedText: `<think>${delta}` };
        }
        return { feedText: delta };
      }

      // --- Search results (informational, inject as text) ---
      // Must be checked before generic text handler since search_result events
      // with string `v` would otherwise be caught by the `typeof obj.v === 'string'` check.
      if (obj.type === 'search_result' || pStr?.includes('search_results')) {
        const searchData = obj.v as Record<string, unknown> | string | undefined;
        const query =
          typeof searchData === 'string'
            ? searchData
            : (searchData as Record<string, string> | undefined)?.query;
        if (query) {
          const msg = `\n> [Searching: ${query}...]\n`;
          return { feedText: msg };
        }
        return null;
      }

      // --- Text content (JSON-patch style or bare delta) ---
      // Bare delta: {"v":"text"} with no `p` field — these are shorthand content deltas.
      // Path-based: {"p":["content"],"v":"text"} or {"p":"content","v":"text"}
      if (
        typeof obj.v === 'string' &&
        (!pStr || pStr === 'content' || pStr.includes('choices'))
      ) {
        const delta = stripJunk(obj.v);
        if (!delta) return null;

        // Bare deltas (no path) are continuations of the current fragment —
        // they should NOT trigger a thinking→text transition.
        // Only path-based events (p: "content", p: "...choices...") indicate
        // a real transition away from thinking.
        if (!pStr && inThinking) {
          return { feedText: delta };
        }

        // Transition from thinking to text (path-based event)
        if (inThinking) {
          inThinking = false;
          return { feedText: `</think>${delta}` };
        }
        return { feedText: delta };
      }

      if (obj.type === 'text' && typeof obj.content === 'string') {
        const delta = stripJunk(obj.content);
        if (!delta) return null;
        if (inThinking) {
          inThinking = false;
          return { feedText: `</think>${delta}` };
        }
        return { feedText: delta };
      }

      // --- OpenAI-compatible fallback (choices format) ---
      const choices = obj.choices as
        | Array<{ delta?: { content?: string; reasoning_content?: string } }>
        | undefined;
      if (choices?.[0]?.delta) {
        const delta = choices[0].delta;
        const parts: string[] = [];

        if (delta.reasoning_content) {
          const reasoning = stripJunk(delta.reasoning_content);
          if (reasoning) {
            if (!inThinking) {
              inThinking = true;
              parts.push('<think>');
            }
            parts.push(reasoning);
          }
        }

        if (delta.content) {
          const content = stripJunk(delta.content);
          if (content) {
            if (inThinking) {
              inThinking = false;
              parts.push('</think>');
            }
            parts.push(content);
          }
        }

        return parts.length > 0 ? { feedText: parts.join('') } : null;
      }

      return null;
    },

    flush() {
      // Close any unclosed think block
      if (inThinking) {
        inThinking = false;
        return { feedText: '</think>' };
      }
      return null;
    },

    shouldAbort: () => false,
  };
};

export { createDeepSeekStreamAdapter };
