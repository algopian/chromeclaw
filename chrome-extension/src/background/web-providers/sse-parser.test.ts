/**
 * Tests for sse-parser.ts — SSE line parser.
 */
import { describe, it, expect } from 'vitest';
import { createSseParser } from './sse-parser';

describe('createSseParser', () => {
  it('parses a single SSE event', () => {
    const parser = createSseParser();
    const events = parser.feed('data: hello\n\n');
    expect(events).toEqual([{ event: undefined, data: 'hello' }]);
  });

  it('parses event with event: field', () => {
    const parser = createSseParser();
    const events = parser.feed('event: message\ndata: world\n\n');
    expect(events).toEqual([{ event: 'message', data: 'world' }]);
  });

  it('joins multi-line data fields', () => {
    const parser = createSseParser();
    const events = parser.feed('data: line1\ndata: line2\n\n');
    expect(events).toEqual([{ event: undefined, data: 'line1\nline2' }]);
  });

  it('handles incremental chunks', () => {
    const parser = createSseParser();
    const e1 = parser.feed('data: hel');
    expect(e1).toEqual([]); // incomplete line
    const e2 = parser.feed('lo\n\n');
    expect(e2).toEqual([{ event: undefined, data: 'hello' }]);
  });

  it('handles multiple events in one chunk', () => {
    const parser = createSseParser();
    const events = parser.feed('data: first\n\ndata: second\n\n');
    expect(events).toEqual([
      { event: undefined, data: 'first' },
      { event: undefined, data: 'second' },
    ]);
  });

  it('ignores comment and empty data lines', () => {
    const parser = createSseParser();
    const events = parser.feed(': comment\ndata: actual\n\n');
    expect(events).toEqual([{ event: undefined, data: 'actual' }]);
  });

  it('handles data: without space after colon', () => {
    const parser = createSseParser();
    const events = parser.feed('data:nospace\n\n');
    expect(events).toEqual([{ event: undefined, data: 'nospace' }]);
  });

  it('flush() drains unterminated data line', () => {
    const parser = createSseParser();
    const e1 = parser.feed('data: hello');
    expect(e1).toEqual([]); // no newline yet

    const e2 = parser.flush();
    expect(e2).toEqual([{ event: undefined, data: 'hello' }]);
  });

  it('flush() drains data line without trailing blank line', () => {
    const parser = createSseParser();
    const e1 = parser.feed('data: hello\n');
    expect(e1).toEqual([]); // line processed but no blank line to emit event

    const e2 = parser.flush();
    expect(e2).toEqual([{ event: undefined, data: 'hello' }]);
  });

  it('flush() returns empty when buffer is clean', () => {
    const parser = createSseParser();
    parser.feed('data: hello\n\n');
    const e = parser.flush();
    expect(e).toEqual([]);
  });

  it('flush() handles multiple buffered data lines', () => {
    const parser = createSseParser();
    parser.feed('data: line1\ndata: line2');
    const e = parser.flush();
    expect(e).toEqual([{ event: undefined, data: 'line1\nline2' }]);
  });
});
