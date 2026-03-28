/**
 * Tests for doubao-stream-adapter.ts — Doubao Samantha API SSE stream processing.
 */
import { describe, it, expect } from 'vitest';
import { createDoubaoStreamAdapter } from './doubao-stream-adapter';

// ── Test Helpers ─────────────────────────────────

/** Samantha format event: message with content_type 2001 (text) */
const samanthaTextEvent = (text: string) => ({
  message: {
    content: JSON.stringify({ text }),
    content_type: 2001,
  },
  is_finish: false,
});

/** Samantha format event: message with content_type 2008 (seed model text — also regular text) */
const samanthaSeedEvent = (text: string) => ({
  message: {
    content: JSON.stringify({ text }),
    content_type: 2008,
  },
  is_finish: false,
});

/** Samantha format event: message with content_type 2030 (reading mode output) */
const samanthaReadingEvent = (text: string) => ({
  message: {
    content: JSON.stringify({ text }),
    content_type: 2030,
  },
  is_finish: false,
});

/** Samantha format event: message with content_type 2071 (deep thinking mode output) */
const samanthaDeepThinkEvent = (text: string) => ({
  message: {
    content: JSON.stringify({ text }),
    content_type: 2071,
  },
  is_finish: false,
});

/** Samantha format event: finished */
const samanthaFinishEvent = () => ({
  message: {
    content: JSON.stringify({ text: '' }),
    content_type: 2001,
  },
  is_finish: true,
});

/** Samantha format event: suggestions (content_type 2002) */
const samanthaSuggestEvent = () => ({
  message: {
    content: JSON.stringify({ suggest: 'Try this' }),
    content_type: 2002,
  },
  is_finish: false,
});

/** CHUNK_DELTA fallback format */
const chunkDeltaEvent = (text: string) => ({ text });

/** STREAM_CHUNK fallback format */
const streamChunkEvent = (ttsContent: string) => ({
  patch_op: [{ patch_value: { tts_content: ttsContent } }],
});

/** STREAM_MSG_NOTIFY fallback format */
const streamMsgNotifyEvent = (text: string) => ({
  content: {
    content_block: [{ content: { text_block: { text } } }],
  },
});

/** Synthetic conversation_id event */
const conversationIdEvent = (id: string) => ({
  type: 'doubao:conversation_id',
  conversation_id: id,
});

// ── Tests ────────────────────────────────────────

describe('createDoubaoStreamAdapter', () => {
  describe('Samantha format — content_type 2001 (text)', () => {
    it('extracts text from content_type 2001', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: samanthaTextEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
    });

    it('returns null for finished messages', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: samanthaFinishEvent(), delta: null })).toBeNull();
    });

    it('returns null for empty text', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: samanthaTextEvent(''), delta: null })).toBeNull();
    });

    it('handles plain string content (non-JSON)', () => {
      const adapter = createDoubaoStreamAdapter();
      const event = {
        message: { content: 'plain text', content_type: 2001 },
        is_finish: false,
      };
      expect(adapter.processEvent({ parsed: event, delta: null })).toEqual({
        feedText: 'plain text',
      });
    });
  });

  describe('Samantha format — content_type 2008 (seed model text)', () => {
    it('extracts text from content_type 2008 as regular text (not thinking)', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: samanthaSeedEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
    });

    it('does NOT wrap 2008 content in think tags', () => {
      const adapter = createDoubaoStreamAdapter();
      const result = adapter.processEvent({ parsed: samanthaSeedEvent('reasoning'), delta: null });
      expect(result).toEqual({ feedText: 'reasoning' });
      expect(result?.feedText).not.toContain('<think>');
    });

    it('handles sequential 2008 events as plain text', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: samanthaSeedEvent('Part 1'), delta: null })).toEqual({
        feedText: 'Part 1',
      });
      expect(adapter.processEvent({ parsed: samanthaSeedEvent('Part 2'), delta: null })).toEqual({
        feedText: 'Part 2',
      });
    });

    it('handles transition from 2008 to 2001 as plain text', () => {
      const adapter = createDoubaoStreamAdapter();
      adapter.processEvent({ parsed: samanthaSeedEvent('Seed text'), delta: null });
      const result = adapter.processEvent({ parsed: samanthaTextEvent('Regular text'), delta: null });
      expect(result).toEqual({ feedText: 'Regular text' });
      expect(result?.feedText).not.toContain('</think>');
    });
  });

  describe('Samantha format — content_type 2002 (suggestions)', () => {
    it('returns null for suggestion events', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: samanthaSuggestEvent(), delta: null })).toBeNull();
    });
  });

  describe('Samantha format — content_type 2030 (reading mode)', () => {
    it('extracts text from content_type 2030', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: samanthaReadingEvent('tool call text'), delta: null })).toEqual({
        feedText: 'tool call text',
      });
    });

    it('returns null for empty content in 2030', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: samanthaReadingEvent(''), delta: null })).toBeNull();
    });
  });

  describe('Samantha format — content_type 2071 (deep thinking mode)', () => {
    it('extracts text from content_type 2071', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: samanthaDeepThinkEvent('thinking output'), delta: null })).toEqual({
        feedText: 'thinking output',
      });
    });

    it('returns null for empty content in 2071', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: samanthaDeepThinkEvent(''), delta: null })).toBeNull();
    });

    it('returns null for 2071 events with empty JSON content (meta_infos markers)', () => {
      const adapter = createDoubaoStreamAdapter();
      const event = {
        message: { content: '{}', content_type: 2071 },
        is_finish: false,
      };
      expect(adapter.processEvent({ parsed: event, delta: null })).toBeNull();
    });
  });

  describe('CHUNK_DELTA fallback format', () => {
    it('extracts text from CHUNK_DELTA format', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: chunkDeltaEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
    });

    it('returns null for empty text', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: chunkDeltaEvent(''), delta: null })).toBeNull();
    });
  });

  describe('STREAM_CHUNK fallback format', () => {
    it('extracts text from STREAM_CHUNK patch_op', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: streamChunkEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
    });

    it('returns null for empty patch_op', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: { patch_op: [] }, delta: null })).toBeNull();
    });

    it('concatenates multiple patch values', () => {
      const adapter = createDoubaoStreamAdapter();
      const event = {
        patch_op: [
          { patch_value: { tts_content: 'Hello ' } },
          { patch_value: { tts_content: 'world' } },
        ],
      };
      expect(adapter.processEvent({ parsed: event, delta: null })).toEqual({
        feedText: 'Hello world',
      });
    });
  });

  describe('STREAM_MSG_NOTIFY fallback format', () => {
    it('extracts text from content blocks', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: streamMsgNotifyEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
    });

    it('returns null for empty content blocks', () => {
      const adapter = createDoubaoStreamAdapter();
      const event = { content: { content_block: [] } };
      expect(adapter.processEvent({ parsed: event, delta: null })).toBeNull();
    });
  });

  describe('conversation_id event', () => {
    it('returns null for synthetic conversation_id event (passthrough)', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: conversationIdEvent('conv-123'), delta: null })).toBeNull();
    });
  });

  describe('unknown events', () => {
    it('returns null for empty objects', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: {}, delta: null })).toBeNull();
    });

    it('returns null for unrecognized event structure', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.processEvent({ parsed: { foo: 'bar' }, delta: null })).toBeNull();
    });
  });

  describe('flush', () => {
    it('returns null (no thinking state to close)', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.flush()).toBeNull();
    });
  });

  describe('shouldAbort', () => {
    it('always returns false', () => {
      const adapter = createDoubaoStreamAdapter();
      expect(adapter.shouldAbort()).toBe(false);
    });
  });

  describe('Samantha format — unsupported content_type', () => {
    it('returns null for non-text content types', () => {
      const adapter = createDoubaoStreamAdapter();
      const event = {
        message: { content: JSON.stringify({ text: 'ignored' }), content_type: 9999 },
        is_finish: false,
      };
      expect(adapter.processEvent({ parsed: event, delta: null })).toBeNull();
    });
  });
});
