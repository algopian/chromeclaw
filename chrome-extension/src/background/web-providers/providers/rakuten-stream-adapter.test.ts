/**
 * Tests for rakuten-stream-adapter.ts — Rakuten AI WebSocket message processing.
 *
 * The MAIN world handler converts WebSocket messages into typed SSE events:
 *   - rakuten:conversation — AI response chunks (TEXT / SUMMARY_TEXT content)
 *   - rakuten:ack — Server acknowledgements (filtered out)
 *   - rakuten:error — Error messages (thrown as exceptions)
 *   - rakuten:thread_id — Thread ID for conversation caching (filtered out)
 */
import { describe, it, expect } from 'vitest';
import { createRakutenStreamAdapter } from './rakuten-stream-adapter';

// ── Test Helpers ─────────────────────────────────

/** TEXT content (fast mode). */
const textEvent = (text: string) => ({
  type: 'rakuten:conversation',
  data: {
    chatResponseStatus: 'APPEND',
    contents: [{ contentType: 'TEXT', textData: { text } }],
  },
});

/** SUMMARY_TEXT content (deep think reasoning). */
const thinkingEvent = (text: string) => ({
  type: 'rakuten:conversation',
  data: {
    chatResponseStatus: 'APPEND',
    contents: [{ contentType: 'SUMMARY_TEXT', textData: { text } }],
  },
});

/** Mixed content (SUMMARY_TEXT + TEXT in same chunk). */
const mixedEvent = (summary: string, answer: string) => ({
  type: 'rakuten:conversation',
  data: {
    chatResponseStatus: 'APPEND',
    contents: [
      { contentType: 'SUMMARY_TEXT', textData: { text: summary } },
      { contentType: 'TEXT', textData: { text: answer } },
    ],
  },
});

/** COMPLETED event (end of stream). */
const completedEvent = () => ({
  type: 'rakuten:conversation',
  data: { chatResponseStatus: 'COMPLETED', contents: [] },
});

/** FAILED event. */
const failedEvent = () => ({
  type: 'rakuten:conversation',
  data: { chatResponseStatus: 'FAILED', contents: [] },
});

/** CANCELLED event. */
const cancelledEvent = () => ({
  type: 'rakuten:conversation',
  data: { chatResponseStatus: 'CANCELLED', contents: [] },
});

/** ACK event (should be filtered out). */
const ackEvent = (action: string) => ({
  type: 'rakuten:ack',
  action,
});

/** Error event. */
const errorEvent = (code: string, message: string) => ({
  type: 'rakuten:error',
  error: { code, message },
});

/** Thread ID event (for conversation caching). */
const threadIdEvent = (threadId: string) => ({
  type: 'rakuten:thread_id',
  thread_id: threadId,
});

/** Event with empty contents. */
const emptyContentsEvent = () => ({
  type: 'rakuten:conversation',
  data: { chatResponseStatus: 'APPEND', contents: [] },
});

/** Event with content that has empty text. */
const emptyTextEvent = () => ({
  type: 'rakuten:conversation',
  data: {
    chatResponseStatus: 'APPEND',
    contents: [{ contentType: 'TEXT', textData: { text: '' } }],
  },
});

// ── Tests ────────────────────────────────────────

describe('createRakutenStreamAdapter', () => {
  describe('text passthrough (fast mode)', () => {
    it('passes TEXT content through', () => {
      const adapter = createRakutenStreamAdapter();
      expect(adapter.processEvent({ parsed: textEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
    });

    it('passes multiple text chunks through independently', () => {
      const adapter = createRakutenStreamAdapter();
      expect(adapter.processEvent({ parsed: textEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
      expect(adapter.processEvent({ parsed: textEvent(' world'), delta: null })).toEqual({
        feedText: ' world',
      });
      expect(adapter.processEvent({ parsed: textEvent('!'), delta: null })).toEqual({
        feedText: '!',
      });
    });
  });

  describe('ACK filtering', () => {
    it('filters USER_INPUT_ACK', () => {
      const adapter = createRakutenStreamAdapter();
      expect(adapter.processEvent({ parsed: ackEvent('USER_INPUT_ACK'), delta: null })).toBeNull();
    });

    it('filters MESSAGE_RECEIVED_ACK', () => {
      const adapter = createRakutenStreamAdapter();
      expect(
        adapter.processEvent({ parsed: ackEvent('MESSAGE_RECEIVED_ACK'), delta: null }),
      ).toBeNull();
    });

    it('filters AI_MESSAGE_SAVED_ACK', () => {
      const adapter = createRakutenStreamAdapter();
      expect(
        adapter.processEvent({ parsed: ackEvent('AI_MESSAGE_SAVED_ACK'), delta: null }),
      ).toBeNull();
    });
  });

  describe('thread ID events', () => {
    it('filters thread_id events (handled by tool strategy)', () => {
      const adapter = createRakutenStreamAdapter();
      expect(
        adapter.processEvent({ parsed: threadIdEvent('69cd5aa14d6601a4fe952603'), delta: null }),
      ).toBeNull();
    });
  });

  describe('terminal status events', () => {
    it('returns null for COMPLETED events', () => {
      const adapter = createRakutenStreamAdapter();
      expect(adapter.processEvent({ parsed: completedEvent(), delta: null })).toBeNull();
    });

    it('returns null for FAILED events', () => {
      const adapter = createRakutenStreamAdapter();
      expect(adapter.processEvent({ parsed: failedEvent(), delta: null })).toBeNull();
    });

    it('returns null for CANCELLED events', () => {
      const adapter = createRakutenStreamAdapter();
      expect(adapter.processEvent({ parsed: cancelledEvent(), delta: null })).toBeNull();
    });
  });

  describe('thinking/reasoning mode (DEEP_THINK)', () => {
    it('wraps first SUMMARY_TEXT in <think> tag', () => {
      const adapter = createRakutenStreamAdapter();
      expect(adapter.processEvent({ parsed: thinkingEvent('Reasoning...'), delta: null })).toEqual({
        feedText: '<think>Reasoning...',
      });
    });

    it('passes subsequent SUMMARY_TEXT through without extra tag', () => {
      const adapter = createRakutenStreamAdapter();
      adapter.processEvent({ parsed: thinkingEvent('Step 1'), delta: null });
      expect(
        adapter.processEvent({ parsed: thinkingEvent(' then step 2'), delta: null }),
      ).toEqual({
        feedText: ' then step 2',
      });
    });

    it('closes think block when transitioning to TEXT', () => {
      const adapter = createRakutenStreamAdapter();
      adapter.processEvent({ parsed: thinkingEvent('Reasoning'), delta: null });
      const result = adapter.processEvent({ parsed: textEvent('Answer'), delta: null });
      expect(result).toEqual({ feedText: '</think>Answer' });
    });

    it('handles multiple thinking chunks then answer', () => {
      const adapter = createRakutenStreamAdapter();
      const results: string[] = [];
      const proc = (parsed: unknown) => {
        const r = adapter.processEvent({ parsed, delta: null });
        if (r) results.push(r.feedText);
      };

      proc(thinkingEvent('Let me think'));
      proc(thinkingEvent(' about this'));
      proc(thinkingEvent(' carefully'));
      proc(textEvent('The answer is 42'));

      expect(results.join('')).toBe(
        '<think>Let me think about this carefully</think>The answer is 42',
      );
    });
  });

  describe('mixed content events', () => {
    it('handles SUMMARY_TEXT + TEXT in single event', () => {
      const adapter = createRakutenStreamAdapter();
      const result = adapter.processEvent({
        parsed: mixedEvent('Reasoning here', 'Answer here'),
        delta: null,
      });
      expect(result).toEqual({ feedText: '<think>Reasoning here</think>Answer here' });
    });
  });

  describe('error handling', () => {
    it('throws on error events with message', () => {
      const adapter = createRakutenStreamAdapter();
      expect(() =>
        adapter.processEvent({ parsed: errorEvent('4290100', 'Rate limit exceeded'), delta: null }),
      ).toThrow('Rate limit exceeded');
    });

    it('throws generic message when error has no message', () => {
      const adapter = createRakutenStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: { type: 'rakuten:error', error: {} },
          delta: null,
        }),
      ).toThrow('Rakuten AI error');
    });

    it('throws generic message when error object is missing', () => {
      const adapter = createRakutenStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: { type: 'rakuten:error' },
          delta: null,
        }),
      ).toThrow('Rakuten AI error');
    });
  });

  describe('edge cases', () => {
    it('returns null for empty contents array', () => {
      const adapter = createRakutenStreamAdapter();
      expect(adapter.processEvent({ parsed: emptyContentsEvent(), delta: null })).toBeNull();
    });

    it('returns null for content with empty text', () => {
      const adapter = createRakutenStreamAdapter();
      expect(adapter.processEvent({ parsed: emptyTextEvent(), delta: null })).toBeNull();
    });

    it('returns null for unknown event types', () => {
      const adapter = createRakutenStreamAdapter();
      expect(
        adapter.processEvent({ parsed: { type: 'unknown:event' }, delta: null }),
      ).toBeNull();
    });

    it('returns null for events without type field', () => {
      const adapter = createRakutenStreamAdapter();
      expect(adapter.processEvent({ parsed: { data: 'something' }, delta: null })).toBeNull();
    });

    it('returns null for events with null data', () => {
      const adapter = createRakutenStreamAdapter();
      expect(
        adapter.processEvent({
          parsed: { type: 'rakuten:conversation', data: null },
          delta: null,
        }),
      ).toBeNull();
    });

    it('handles content without textData', () => {
      const adapter = createRakutenStreamAdapter();
      expect(
        adapter.processEvent({
          parsed: {
            type: 'rakuten:conversation',
            data: {
              chatResponseStatus: 'APPEND',
              contents: [{ contentType: 'TEXT' }],
            },
          },
          delta: null,
        }),
      ).toBeNull();
    });
  });

  describe('flush behavior', () => {
    it('closes unclosed think block on flush', () => {
      const adapter = createRakutenStreamAdapter();
      adapter.processEvent({ parsed: thinkingEvent('incomplete thought'), delta: null });
      expect(adapter.flush()).toEqual({ feedText: '</think>' });
    });

    it('returns null on flush when no think was started', () => {
      const adapter = createRakutenStreamAdapter();
      expect(adapter.flush()).toBeNull();
    });

    it('returns null on flush after think was properly closed', () => {
      const adapter = createRakutenStreamAdapter();
      adapter.processEvent({ parsed: thinkingEvent('thinking'), delta: null });
      adapter.processEvent({ parsed: textEvent('answer'), delta: null });
      expect(adapter.flush()).toBeNull();
    });

    it('returns null on flush after only text events', () => {
      const adapter = createRakutenStreamAdapter();
      adapter.processEvent({ parsed: textEvent('just text'), delta: null });
      expect(adapter.flush()).toBeNull();
    });
  });

  describe('shouldAbort', () => {
    it('always returns false', () => {
      const adapter = createRakutenStreamAdapter();
      expect(adapter.shouldAbort()).toBe(false);
    });

    it('still returns false after processing events', () => {
      const adapter = createRakutenStreamAdapter();
      adapter.processEvent({ parsed: textEvent('text'), delta: null });
      expect(adapter.shouldAbort()).toBe(false);
    });
  });

  describe('onFinish', () => {
    it('returns error for empty response (no text, no tool calls)', () => {
      const adapter = createRakutenStreamAdapter();
      const result = adapter.onFinish!({
        hasToolCalls: false,
        fullText: '',
        thinkingContent: undefined,
      });
      expect(result).toEqual({ error: 'Empty response from Rakuten AI' });
    });

    it('returns null for normal response with text', () => {
      const adapter = createRakutenStreamAdapter();
      const result = adapter.onFinish!({
        hasToolCalls: false,
        fullText: 'Hello world',
        thinkingContent: undefined,
      });
      expect(result).toBeNull();
    });

    it('returns null when tool calls present even with empty text', () => {
      const adapter = createRakutenStreamAdapter();
      const result = adapter.onFinish!({
        hasToolCalls: true,
        fullText: '',
        thinkingContent: undefined,
      });
      expect(result).toBeNull();
    });

    it('returns null when only thinking content is present (no answer text)', () => {
      const adapter = createRakutenStreamAdapter();
      const result = adapter.onFinish!({
        hasToolCalls: false,
        fullText: '',
        thinkingContent: 'some reasoning without answer',
      });
      expect(result).toBeNull();
    });

    it('returns null for response with thinking content', () => {
      const adapter = createRakutenStreamAdapter();
      const result = adapter.onFinish!({
        hasToolCalls: false,
        fullText: 'answer',
        thinkingContent: 'reasoning',
      });
      expect(result).toBeNull();
    });
  });

  describe('full flow scenarios', () => {
    it('fast think: multiple text chunks', () => {
      const adapter = createRakutenStreamAdapter();
      const results: string[] = [];
      const proc = (parsed: unknown) => {
        const r = adapter.processEvent({ parsed, delta: null });
        if (r) results.push(r.feedText);
      };

      proc(textEvent('10 + 10'));
      proc(textEvent(' = '));
      proc(textEvent('**20**'));
      proc(completedEvent());

      expect(results.join('')).toBe('10 + 10 = **20**');
      expect(adapter.flush()).toBeNull();
    });

    it('deep think: SUMMARY_TEXT chunks then TEXT chunks', () => {
      const adapter = createRakutenStreamAdapter();
      const results: string[] = [];
      const proc = (parsed: unknown) => {
        const r = adapter.processEvent({ parsed, delta: null });
        if (r) results.push(r.feedText);
      };

      // Thinking phase
      proc(thinkingEvent('**Providing a simple answer**'));
      proc(thinkingEvent('\n\nI want to be clear here'));
      // Answer phase
      proc(textEvent('2 × 2 = 4.'));
      proc(completedEvent());

      expect(results.join('')).toBe(
        '<think>**Providing a simple answer**\n\nI want to be clear here</think>2 × 2 = 4.',
      );
      expect(adapter.flush()).toBeNull();
    });

    it('full flow with ACKs interleaved', () => {
      const adapter = createRakutenStreamAdapter();
      const results: string[] = [];
      const proc = (parsed: unknown) => {
        const r = adapter.processEvent({ parsed, delta: null });
        if (r) results.push(r.feedText);
      };

      proc(ackEvent('USER_INPUT_ACK'));
      proc(ackEvent('MESSAGE_RECEIVED_ACK'));
      proc(threadIdEvent('thread-123'));
      proc(textEvent('Hello'));
      proc(textEvent(' there'));
      proc(ackEvent('AI_MESSAGE_SAVED_ACK'));
      proc(completedEvent());

      expect(results.join('')).toBe('Hello there');
    });

    it('independent adapter instances do not share state', () => {
      const a = createRakutenStreamAdapter();
      const b = createRakutenStreamAdapter();

      // Start thinking in adapter `a`
      a.processEvent({ parsed: thinkingEvent('thinking in a'), delta: null });

      // Adapter `b` should not be in thinking state
      expect(b.flush()).toBeNull();
      expect(a.flush()).toEqual({ feedText: '</think>' });
    });
  });
});
