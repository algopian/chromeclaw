/**
 * Lightweight SSE (Server-Sent Events) line parser.
 * Parses raw text chunks into structured SSE events.
 */

interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Create a stateful SSE parser.
 * Feed raw text chunks via `feed()` — returns parsed events.
 */
const createSseParser = (): {
  feed: (chunk: string) => SseEvent[];
  flush: () => SseEvent[];
} => {
  let buffer = '';
  let currentEvent: string | undefined;
  let dataLines: string[] = [];

  const processLines = (events: SseEvent[]) => {
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
      buffer = buffer.slice(newlineIdx + 1);

      if (line === '') {
        // Empty line = end of event
        if (dataLines.length > 0) {
          events.push({
            event: currentEvent,
            data: dataLines.join('\n'),
          });
        }
        currentEvent = undefined;
        dataLines = [];
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5));
      } else if (line.startsWith('event: ')) {
        currentEvent = line.slice(7);
      } else if (line.startsWith('event:')) {
        currentEvent = line.slice(6);
      }
      // Ignore id:, retry:, and comment lines (starting with :)
    }
  };

  const feed = (chunk: string): SseEvent[] => {
    buffer += chunk;
    const events: SseEvent[] = [];
    processLines(events);
    return events;
  };

  /**
   * Flush any remaining buffered data as a final event.
   * Call at end-of-stream to drain data lines that lack a trailing blank line.
   */
  const flush = (): SseEvent[] => {
    const events: SseEvent[] = [];

    // Process any complete lines still in the buffer
    // (append \n to force processing of the last unterminated line)
    if (buffer) {
      buffer += '\n';
      processLines(events);
    }

    // Emit any accumulated data lines that weren't terminated by a blank line
    if (dataLines.length > 0) {
      events.push({
        event: currentEvent,
        data: dataLines.join('\n'),
      });
      currentEvent = undefined;
      dataLines = [];
    }

    return events;
  };

  return { feed, flush };
};

export { createSseParser };
export type { SseEvent };
