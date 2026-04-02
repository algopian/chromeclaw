/**
 * Rakuten AI SSE stream adapter — processes WebSocket messages converted to SSE events.
 *
 * The MAIN world handler (handleRakuten in content-fetch-main.ts) converts WebSocket
 * messages into typed SSE events:
 *
 *   data: {"type":"rakuten:conversation","data":{...}}  — AI response chunks
 *   data: {"type":"rakuten:ack","action":"..."}          — Server acknowledgements (filtered)
 *   data: {"type":"rakuten:error","error":{...}}         — Errors (thrown as exceptions)
 *   data: {"type":"rakuten:thread_id","thread_id":"..."}  — Thread ID (filtered, handled by strategy)
 *
 * Rakuten AI response content types:
 *   - TEXT         → Regular text output (both USER_INPUT and DEEP_THINK modes)
 *   - SUMMARY_TEXT → Chain-of-thought reasoning (DEEP_THINK mode only)
 *
 * The adapter wraps SUMMARY_TEXT content in <think>...</think> tags and manages
 * the transition from thinking to text output.
 */

import type { SseStreamAdapter } from '../sse-stream-adapter';

const createRakutenStreamAdapter = (): SseStreamAdapter => {
  let inThinking = false;

  return {
    processEvent({ parsed }) {
      const obj = parsed as Record<string, unknown>;
      const eventType = obj.type as string | undefined;

      // Filter out ACK and thread_id events — handled by bridge/strategy
      if (eventType === 'rakuten:ack' || eventType === 'rakuten:thread_id') return null;

      // Handle error events by throwing — bridge catches and surfaces as stream error
      if (eventType === 'rakuten:error') {
        const error = obj.error as { code?: string; message?: string } | undefined;
        throw new Error(error?.message ?? 'Rakuten AI error');
      }

      // Only process conversation events
      if (eventType !== 'rakuten:conversation') return null;

      const data = obj.data as Record<string, unknown> | undefined;
      if (!data) return null;

      // Terminal statuses are handled by the MAIN world handler (WEB_LLM_DONE/WEB_LLM_ERROR)
      // TOOL_CALL = Rakuten's internal tool invocation ID (e.g. web search) — not user-visible
      // EVENT = progress events for internal tools (e.g. "web-search.start") — not user-visible
      const status = data.chatResponseStatus as string;
      if (status === 'DONE' || status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') return null;
      if (status === 'TOOL_CALL') return null;

      // EVENT messages carry progress info (e.g. web-search.start) — not text content
      const responseType = data.chatResponseType as string;
      if (responseType === 'EVENT') return null;

      const contents = data.contents as
        | Array<{ contentType: string; textData?: { text?: string } }>
        | undefined;
      if (!contents?.length) return null;

      const parts: string[] = [];
      for (const content of contents) {
        const text = content.textData?.text ?? '';
        if (!text) continue;

        if (content.contentType === 'SUMMARY_TEXT') {
          // Reasoning/chain-of-thought content → wrap in <think> tags
          if (!inThinking) {
            inThinking = true;
            parts.push('<think>');
          }
          parts.push(text);
        } else {
          // TEXT or any other content type → regular output
          if (inThinking) {
            inThinking = false;
            parts.push('</think>');
          }
          parts.push(text);
        }
      }

      return parts.length > 0 ? { feedText: parts.join('') } : null;
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

    onFinish({ hasToolCalls, fullText, thinkingContent }) {
      // Detect empty responses (no text, no thinking, and no tool calls)
      if (!hasToolCalls && !fullText && !thinkingContent) {
        return { error: 'Empty response from Rakuten AI' };
      }
      return null;
    },
  };
};

export { createRakutenStreamAdapter };
