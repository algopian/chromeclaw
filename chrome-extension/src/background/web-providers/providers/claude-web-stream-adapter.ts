/**
 * Claude SSE stream adapter — handles Claude's structured event protocol.
 *
 * Claude quirks:
 * 1. SSE events use typed messages (`content_block_start`, `content_block_delta`,
 *    `content_block_stop`, `message_delta`, etc.) instead of plain text deltas.
 * 2. Thinking content arrives as `thinking_delta` events within a `thinking`
 *    content block. We wrap these in `<think>...</think>` tags for the XML parser.
 * 3. Text content arrives as `text_delta` events within a `text` content block.
 * 4. Claude's web API has built-in native tools (web_search, view, etc.) that are
 *    always active. When the model uses native tool calling, we receive `tool_use`
 *    content blocks with `input_json_delta` streaming, followed by `tool_result`
 *    blocks (usually `is_error: true` since claude.ai can't execute them properly).
 *    We CONVERT native tool_use blocks into XML `<tool_call>` format so ChromeClaw
 *    can execute them, then signal abort so the subsequent text (which is based on
 *    the failed native result) gets discarded.
 * 5. `tool_result` blocks from claude.ai's native execution are ignored entirely.
 * 6. Error frames contain an `error` object with a `message` field.
 */

import type { SseStreamAdapter } from '../sse-stream-adapter';
import { escapeXml } from '../tool-prompt';

const createClaudeStreamAdapter = (): SseStreamAdapter => {
  let inThinking = false;
  /** Active tool_use block state — accumulates JSON args across input_json_delta events. */
  let toolUse: { id: string; name: string; json: string } | null = null;
  /** Set when we encounter a tool_result block — ignore all its deltas. */
  let inToolResult = false;
  /** Set after we've emitted at least one native tool call — signals the bridge to abort. */
  let hadNativeToolCall = false;

  return {
    processEvent({ parsed }) {
      const obj = parsed as Record<string, unknown>;
      const type = obj.type as string | undefined;

      // Error detection
      if (obj.error) {
        const err = obj.error as Record<string, unknown>;
        throw new Error((err.message ?? 'Unknown Claude error') as string);
      }

      if (type === 'content_block_start') {
        const block = obj.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'thinking') {
          inThinking = true;
          return { feedText: '<think>' };
        }
        if (block?.type === 'tool_use') {
          toolUse = {
            id: (block.id as string) ?? crypto.randomUUID().slice(0, 8),
            name: (block.name as string) ?? 'unknown',
            json: '',
          };
          return null;
        }
        if (block?.type === 'tool_result') {
          inToolResult = true;
          return null;
        }
        return null;
      }

      if (type === 'content_block_stop') {
        if (inToolResult) {
          inToolResult = false;
          return null;
        }
        if (inThinking) {
          inThinking = false;
          return { feedText: '</think>' };
        }
        // Emit accumulated tool_use as XML <tool_call>
        if (toolUse) {
          const { id, name, json } = toolUse;
          const callId = id.slice(0, 8);
          toolUse = null;
          hadNativeToolCall = true;
          return { feedText: `<tool_call id="${escapeXml(callId)}" name="${escapeXml(name)}">${json || '{}'}</tool_call>` };
        }
        return null;
      }

      if (type === 'content_block_delta') {
        // Skip all deltas inside tool_result blocks
        if (inToolResult) return null;

        const delta = obj.delta as Record<string, unknown> | undefined;
        if (!delta) return null;

        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          return { feedText: delta.thinking };
        }
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          return { feedText: delta.text };
        }
        // Accumulate tool_use JSON arguments
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && toolUse) {
          toolUse.json += delta.partial_json;
          return null;
        }
        return null;
      }

      return null;
    },

    flush() {
      const parts: string[] = [];
      if (inThinking) {
        inThinking = false;
        parts.push('</think>');
      }
      // Flush any incomplete tool_use block
      if (toolUse) {
        const { id, name, json } = toolUse;
        const callId = id.slice(0, 8);
        toolUse = null;
        hadNativeToolCall = true;
        parts.push(`<tool_call id="${escapeXml(callId)}" name="${escapeXml(name)}">${json || '{}'}</tool_call>`);
      }
      return parts.length > 0 ? { feedText: parts.join('') } : null;
    },

    /**
     * Abort after native tool calls — the text Claude generates after a failed
     * native tool_result is based on the wrong assumption that tools are broken.
     * By aborting, the bridge finishes with toolUse reason, the agent loop
     * executes the real tools, and sends results back for the next turn.
     */
    shouldAbort: () => hadNativeToolCall,
  };
};

export { createClaudeStreamAdapter };
