/**
 * Doubao SSE stream adapter — handles the Samantha API response format
 * and fallback SSE formats.
 *
 * The MAIN world handler (content-fetch-main.ts) unwraps Doubao's
 * Samantha API wrapper and forwards the inner event_data JSON as
 * standard SSE `data: {...}` events. That inner JSON is what arrives
 * here as `parsed`.
 *
 * Samantha event_data format:
 *   {"message":{"content":"{\"text\":\"Hello\"}","content_type":2001},"is_finish":false}
 *   content_type 2001 = regular text
 *   content_type 2008 = also regular text (seed model output — NOT thinking/reasoning)
 *   content_type 2002 = suggestions (ignored)
 *
 * Fallback SSE formats (CHUNK_DELTA, STREAM_CHUNK, STREAM_MSG_NOTIFY):
 *   {"text":"Hello"}
 *   {"patch_op":[{"patch_value":{"tts_content":"Hello"}}]}
 *   {"content":{"content_block":[{"content":{"text_block":{"text":"Hello"}}}]}}
 *
 * Synthetic conversation_id event (injected by MAIN world handler):
 *   {"type":"doubao:conversation_id","conversation_id":"..."}
 */

import type { SseStreamAdapter } from '../sse-stream-adapter';

/**
 * Content types that carry text output from Doubao.
 *   2001 = regular text
 *   2008 = seed model text (also regular text, NOT thinking/reasoning)
 *   2030 = "reading" mode output (Doubao reads a page then emits text/tool calls)
 *   2071 = "deep thinking" mode output (Doubao thinks then emits text/tool calls)
 */
const TEXT_CONTENT_TYPES = new Set([2001, 2008, 2030, 2071]);

const createDoubaoStreamAdapter = (): SseStreamAdapter => ({
  processEvent({ parsed }) {
    const obj = parsed as Record<string, unknown>;

    // ── Synthetic conversation_id event (passthrough for extractConversationId) ──
    if (obj.type === 'doubao:conversation_id') {
      return null;
    }

    // ── Samantha format: event_data with message.content ──
    const message = obj.message as { content?: string; content_type?: number } | undefined;

    if (message?.content !== undefined && message.content_type !== undefined) {
      // Skip non-text types (2002 = suggestions, others = metadata)
      if (!TEXT_CONTENT_TYPES.has(message.content_type)) return null;
      // Skip finished messages (content is typically "{}" at this point)
      if (obj.is_finish === true) return null;

      let text = '';
      try {
        const content = JSON.parse(message.content) as { text?: string };
        text = content.text ?? '';
      } catch {
        // content may be a plain string
        text = typeof message.content === 'string' ? message.content : '';
      }
      if (!text) return null;

      return { feedText: text };
    }

    // ── Fallback: CHUNK_DELTA format {"text":"..."} ──
    if (typeof obj.text === 'string' && obj.text) {
      return { feedText: obj.text };
    }

    // ── Fallback: STREAM_CHUNK format {"patch_op":[...]} ──
    const patchOp = obj.patch_op as Array<{ patch_value?: { tts_content?: string } }> | undefined;
    if (patchOp && Array.isArray(patchOp)) {
      const parts: string[] = [];
      for (const patch of patchOp) {
        if (patch.patch_value?.tts_content) {
          parts.push(patch.patch_value.tts_content);
        }
      }
      if (parts.length === 0) return null;
      return { feedText: parts.join('') };
    }

    // ── Fallback: STREAM_MSG_NOTIFY format {"content":{"content_block":[...]}} ──
    const contentObj = obj.content as
      | { content_block?: Array<{ content?: { text_block?: { text?: string } } }> }
      | undefined;
    if (contentObj?.content_block && Array.isArray(contentObj.content_block)) {
      const parts: string[] = [];
      for (const block of contentObj.content_block) {
        if (block.content?.text_block?.text) {
          parts.push(block.content.text_block.text);
        }
      }
      if (parts.length === 0) return null;
      return { feedText: parts.join('') };
    }

    return null;
  },

  flush: () => null,

  shouldAbort: () => false,
});

export { createDoubaoStreamAdapter };
