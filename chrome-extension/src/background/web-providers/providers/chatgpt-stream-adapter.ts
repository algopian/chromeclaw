/**
 * ChatGPT SSE stream adapter — handles cumulative `message.content.parts[]` format.
 *
 * chatgpt.com SSE format:
 *   data: {"message":{"id":"msg-xxx","author":{"role":"assistant"},"content":{"content_type":"text","parts":["Hello, how"]},"status":"in_progress"},"conversation_id":"conv-xxx"}
 *   data: {"message":{"id":"msg-xxx","author":{"role":"assistant"},"content":{"content_type":"text","parts":["Hello, how can I help?"]},"status":"in_progress"},"conversation_id":"conv-xxx"}
 *   data: [DONE]
 *
 * Key differences from other providers:
 * - `parts[0]` is CUMULATIVE — each event contains the full text so far, not just the delta
 * - Must compute incremental delta by tracking accumulated content length
 * - Non-assistant messages (system, user, tool) should be skipped
 * - conversation_id and message.id are used for conversation continuity
 */

import type { SseStreamAdapter } from '../sse-stream-adapter';

const createChatGPTStreamAdapter = (): SseStreamAdapter => {
  let accumulatedLength = 0;

  return {
    processEvent({ parsed }) {
      const obj = parsed as Record<string, unknown>;

      // --- Conversation continuity metadata (passthrough for extractConversationId) ---
      // The bridge's extractConversationId will pick up conversation_id + message.id
      // via the chatgpt tool strategy.

      // Skip non-assistant messages
      const message = obj.message as Record<string, unknown> | undefined;
      if (!message) return null;

      const author = message.author as Record<string, string> | undefined;
      const role = author?.role;
      if (role && role !== 'assistant') return null;

      // Extract cumulative text from parts[0]
      const content = message.content as Record<string, unknown> | undefined;
      if (!content) return null;

      const parts = content.parts as unknown[] | undefined;
      if (!parts || parts.length === 0) return null;

      const rawPart = parts[0];
      const fullText =
        typeof rawPart === 'string'
          ? rawPart
          : typeof rawPart === 'object' && rawPart !== null && 'text' in rawPart
            ? (rawPart as { text?: string }).text ?? ''
            : '';

      if (!fullText) return null;

      // Compute incremental delta from cumulative text
      if (fullText.length <= accumulatedLength) return null;
      const delta = fullText.slice(accumulatedLength);
      accumulatedLength = fullText.length;

      return { feedText: delta };
    },

    flush() {
      return null;
    },

    shouldAbort: () => false,

    onFinish({ fullText, hasToolCalls }) {
      if (!fullText && !hasToolCalls) {
        return { error: 'Empty response from ChatGPT. Please verify your ChatGPT session is active and try again.' };
      }
      return null;
    },
  };
};

export { createChatGPTStreamAdapter };
