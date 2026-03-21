/**
 * Shared XML tag parser for extracting structured events from raw LLM text streams.
 * Handles <think>/<tool_call> blocks and special token stripping.
 * Tag matching is case-insensitive to handle models that emit <Tool_Call>, <THINK>, etc.
 *
 * Used by both local-llm-bridge (offscreen/transformers.js) and
 * web-llm-bridge (browser-session web providers).
 */

type ParsedEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_end' }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_call_malformed'; rawText: string };

// Pre-compiled case-insensitive regexes for tag matching
const THINK_OPEN_RE = /<think>/i;
const THINK_CLOSE_RE = /<\/think>/i;
const TOOL_CALL_OPEN_START_RE = /^<tool_call(?:\s[^>]*)?>/i;
const TOOL_CALL_OPEN_RE = /<tool_call(?:\s[^>]*)?>/i;
const TOOL_CALL_CLOSE_RE = /<\/tool_call>/i;
const TOOL_CALL_PREFIX_RE = /^<tool_call/i;
/** Matches hallucinated tool_response tags — these are fake and should be discarded. */
const TOOL_RESPONSE_OPEN_RE = /<tool_response(?:\s[^>]*)?>/i;
const TOOL_RESPONSE_CLOSE_RE = /<\/tool_response>/i;

/**
 * Create a stateful XML tag parser.
 * Feed chunks via `feed()`, then call `flush()` at end-of-stream to close any open blocks.
 */
const createXmlTagParser = (): {
  feed: (chunk: string) => ParsedEvent[];
  flush: () => ParsedEvent[];
} => {
  let state: 'text' | 'thinking' | 'tool_call' | 'tool_response' = 'text';
  let buffer = '';
  let toolCallBuffer = '';
  /** Tag-level attributes from `<tool_call id="..." name="...">`, if present. */
  let toolCallAttrs: { id?: string; name?: string } | undefined;

  const stripSpecialTokens = (text: string): string => text.replace(/<\|[^|]+\|>/g, '');

  const parseToolCallJson = (raw: string): ParsedEvent => {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

    try {
      const parsed = JSON.parse(cleaned);

      if (toolCallAttrs?.name) {
        // Attribute-based format: <tool_call id="..." name="...">{ args only }</tool_call>
        // The entire JSON body IS the arguments object.
        return {
          type: 'tool_call',
          id: toolCallAttrs.id ?? parsed.id ?? crypto.randomUUID(),
          name: toolCallAttrs.name,
          arguments: parsed,
        };
      }

      // Legacy format: <tool_call>{"name":"tool","arguments":{...}}</tool_call>
      const name = parsed.name ?? '';
      let args = parsed.arguments ?? {};
      if (typeof args === 'string') {
        args = JSON.parse(args);
      }

      return {
        type: 'tool_call',
        id: parsed.id ?? crypto.randomUUID(),
        name,
        arguments: args,
      };
    } catch {
      // Fallback: handle double-wrapped tool_call (e.g. Qwen generates bare <tool_call>
      // wrapping <tool_call id="..." name="...">JSON</tool_call>)
      const innerMatch = raw.match(
        /<tool_call\s+(?:id=(?:"([^"]*)"|'([^']*)'|([^\s>]+))\s+)?name=(?:"([^"]*)"|'([^']*)'|([^\s>]+))\s*>([\s\S]*?)(?:<\/tool_call>)?$/i,
      );
      if (innerMatch) {
        const innerId = innerMatch[1] ?? innerMatch[2] ?? innerMatch[3];
        const innerName = innerMatch[4] ?? innerMatch[5] ?? innerMatch[6];
        const innerBody = innerMatch[7];
        if (innerName && innerBody) {
          try {
            const innerParsed = JSON.parse(innerBody.trim());
            return {
              type: 'tool_call',
              id: innerId ?? innerParsed.id ?? crypto.randomUUID(),
              name: innerName,
              arguments: innerParsed,
            };
          } catch {
            /* inner JSON invalid — fall through to malformed */
          }
        }
      }
      return { type: 'tool_call_malformed', rawText: raw };
    }
  };

  /**
   * Try to parse tool_call tag with attributes: `<tool_call id="..." name="...">`.
   * Supports double-quoted, single-quoted, and unquoted attribute values.
   * Returns extracted id/name or undefined if no attributes found.
   */
  const parseToolCallAttributes = (openTag: string): { id?: string; name?: string } | undefined => {
    const attrRegex = /(\w+)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    const attrs: Record<string, string> = {};
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(openTag)) !== null) {
      attrs[match[1]] = match[2] ?? match[3] ?? match[4];
    }
    if (Object.keys(attrs).length === 0) return undefined;
    return { id: attrs.id, name: attrs.name };
  };

  /** Test whether `s` could be the start of a `<think>`, `<tool_call...>`, or `<tool_response...>` tag (case-insensitive). */
  const isPlausibleTagPrefix = (s: string): boolean =>
    s === '<' || /^<(?:th?i?n?k?|to?o?l?_?(?:c?a?l?l?|r?e?s?p?o?n?s?e?))/i.test(s);

  const feed = (chunk: string): ParsedEvent[] => {
    buffer += chunk;
    const events: ParsedEvent[] = [];

    while (buffer.length > 0) {
      if (state === 'text') {
        const thinkIdx = buffer.search(THINK_OPEN_RE);
        // Match both <tool_call> and <tool_call id="..." name="..."> (case-insensitive)
        const toolMatch =
          buffer.match(TOOL_CALL_OPEN_START_RE) ?? buffer.match(TOOL_CALL_OPEN_RE);
        const toolIdx = toolMatch ? buffer.indexOf(toolMatch[0]) : -1;
        // Detect hallucinated <tool_response> tags — consume and discard them
        const responseMatch = buffer.match(TOOL_RESPONSE_OPEN_RE);
        const responseIdx = responseMatch ? buffer.indexOf(responseMatch[0]) : -1;

        if (thinkIdx === 0) {
          state = 'thinking';
          buffer = buffer.slice(7); // len('<think>') — always 7 regardless of case
          events.push({ type: 'thinking_start' });
          continue;
        }
        if (toolIdx === 0 && toolMatch) {
          const fullOpenTag = toolMatch[0];
          toolCallAttrs = parseToolCallAttributes(fullOpenTag);
          state = 'tool_call';
          buffer = buffer.slice(fullOpenTag.length);
          toolCallBuffer = '';
          continue;
        }
        if (responseIdx === 0 && responseMatch) {
          // Enter discard state — skip everything until </tool_response>
          state = 'tool_response';
          buffer = buffer.slice(responseMatch[0].length);
          continue;
        }

        // Partial tag at buffer start — wait for more data.
        // For <think> (max 7 chars), 30 is plenty.
        // For <tool_call id="..." name="...">, attributes can push the opening
        // tag well past 30 chars, so we use a larger limit (200) when the buffer
        // looks like a plausible tool_call or tool_response tag that hasn't received its closing >.
        if (buffer.startsWith('<') && !toolMatch && !responseMatch) {
          const limit = TOOL_CALL_PREFIX_RE.test(buffer) || /^<tool_response/i.test(buffer) ? 200 : 30;
          if (isPlausibleTagPrefix(buffer) && buffer.length < limit) {
            break;
          }
        }

        // Emit text up to next tag or all remaining
        const nextTag = Math.min(
          thinkIdx >= 0 ? thinkIdx : Infinity,
          toolIdx >= 0 ? toolIdx : Infinity,
          responseIdx >= 0 ? responseIdx : Infinity,
        );

        if (nextTag === Infinity) {
          // No complete tag found. Before emitting all remaining text, check for
          // a partial tag at the END of the buffer (e.g. "...text<tool_" where
          // "<tool_call" is split across SSE chunks). Retain the potential tag
          // prefix so the next feed() can complete it.
          const lastLt = buffer.lastIndexOf('<');
          if (lastLt >= 0) {
            const suffix = buffer.slice(lastLt);
            if (isPlausibleTagPrefix(suffix)) {
              // Emit text before the partial tag, keep suffix in buffer
              if (lastLt > 0) {
                const cleaned = stripSpecialTokens(buffer.slice(0, lastLt));
                if (cleaned) events.push({ type: 'text', text: cleaned });
              }
              buffer = suffix;
              break; // wait for more data — buffer now starts with '<'
            }
          }
          // No partial tag — emit everything
          const cleaned = stripSpecialTokens(buffer);
          if (cleaned) events.push({ type: 'text', text: cleaned });
          buffer = '';
        } else {
          const textChunk = buffer.slice(0, nextTag);
          const cleaned = stripSpecialTokens(textChunk);
          if (cleaned) events.push({ type: 'text', text: cleaned });
          buffer = buffer.slice(nextTag);
        }
      } else if (state === 'thinking') {
        const end = buffer.search(THINK_CLOSE_RE);
        if (end >= 0) {
          const text = buffer.slice(0, end);
          if (text) {
            events.push({ type: 'thinking_delta', text });
          }
          events.push({ type: 'thinking_end' });
          buffer = buffer.slice(end + 8); // len('</think>') — always 8 regardless of case
          state = 'text';
        } else {
          // Stream incrementally
          if (buffer) {
            events.push({ type: 'thinking_delta', text: buffer });
          }
          buffer = '';
        }
      } else if (state === 'tool_call') {
        // Search in the combined toolCallBuffer + buffer so that a closing tag
        // split across feed() calls (e.g. "\n</" then "tool_call>") is detected.
        const combined = toolCallBuffer + buffer;
        const end = combined.search(TOOL_CALL_CLOSE_RE);
        if (end >= 0) {
          const body = combined.slice(0, end);
          const rest = combined.slice(end + 12); // len('</tool_call>') — always 12 regardless of case

          const event = parseToolCallJson(body);
          if (event.type === 'tool_call' && toolCallAttrs) {
            // Override with tag attributes if present
            if (toolCallAttrs.id) event.id = toolCallAttrs.id;
            if (toolCallAttrs.name) event.name = toolCallAttrs.name;
          }
          events.push(event);
          toolCallBuffer = '';
          toolCallAttrs = undefined;
          buffer = rest;
          state = 'text';
        } else {
          toolCallBuffer = combined;
          buffer = '';
        }
      } else if (state === 'tool_response') {
        // Discard everything until </tool_response> — this is hallucinated content
        const end = buffer.search(TOOL_RESPONSE_CLOSE_RE);
        if (end >= 0) {
          buffer = buffer.slice(end + 16); // len('</tool_response>') — always 16
          state = 'text';
        } else {
          buffer = ''; // discard and wait for more data
        }
      }
    }

    return events;
  };

  const flush = (): ParsedEvent[] => {
    const events: ParsedEvent[] = [];

    if (state === 'thinking') {
      if (buffer) {
        events.push({ type: 'thinking_delta', text: buffer });
        buffer = '';
      }
      events.push({ type: 'thinking_end' });
      state = 'text';
    } else if (state === 'tool_call') {
      toolCallBuffer += buffer;
      buffer = '';
      // Strip trailing incomplete closing tag (e.g. GLM sends "</tool_call" without ">")
      toolCallBuffer = toolCallBuffer.replace(/<\/tool_call[^>]*$/i, '');
      if (toolCallBuffer) {
        // Try parsing the buffer — some models (e.g. Qwen) omit the closing </tool_call> tag
        const event = parseToolCallJson(toolCallBuffer);
        events.push(event);
        if (event.type === 'tool_call' && toolCallAttrs) {
          if (toolCallAttrs.id) event.id = toolCallAttrs.id;
          if (toolCallAttrs.name) event.name = toolCallAttrs.name;
        }
        toolCallBuffer = '';
      }
      toolCallAttrs = undefined;
      state = 'text';
    } else if (state === 'tool_response') {
      // Discard any remaining hallucinated tool_response content
      buffer = '';
      state = 'text';
    } else if (buffer) {
      const cleaned = stripSpecialTokens(buffer);
      if (cleaned) {
        events.push({ type: 'text', text: cleaned });
      }
      buffer = '';
    }

    return events;
  };

  return { feed, flush };
};

export { createXmlTagParser };
export type { ParsedEvent };
