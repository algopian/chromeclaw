/**
 * Tests for chatgpt-stream-adapter.ts — ChatGPT SSE stream processing.
 */
import { describe, it, expect } from 'vitest';
import { createChatGPTStreamAdapter } from './chatgpt-stream-adapter';

// ── Test Helpers ─────────────────────────────────

/** Standard assistant message event with cumulative text */
const assistantEvent = (text: string, conversationId?: string) => ({
  message: {
    id: 'msg-001',
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: [text] },
    status: 'in_progress',
  },
  ...(conversationId ? { conversation_id: conversationId } : {}),
});

/** User message event (should be skipped) */
const userEvent = (text: string) => ({
  message: {
    id: 'msg-002',
    author: { role: 'user' },
    content: { content_type: 'text', parts: [text] },
  },
});

/** System message event (should be skipped) */
const systemEvent = () => ({
  message: {
    id: 'msg-003',
    author: { role: 'system' },
    content: { content_type: 'text', parts: ['system info'] },
  },
});

/** Event with no message field */
const emptyEvent = () => ({});

/** Event with message but no content */
const noContentEvent = () => ({
  message: {
    id: 'msg-004',
    author: { role: 'assistant' },
  },
});

/** Event with empty parts array */
const emptyPartsEvent = () => ({
  message: {
    id: 'msg-005',
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: [] },
  },
});

/** Synthetic conversation state event from MAIN world handler */
const conversationStateEvent = (compositeId: string) => ({
  type: 'chatgpt:conversation_state',
  conversation_id: compositeId,
});

// ── Tests ────────────────────────────────────────

describe('createChatGPTStreamAdapter', () => {
  describe('cumulative delta extraction', () => {
    it('extracts initial text as full delta', () => {
      const adapter = createChatGPTStreamAdapter();
      expect(adapter.processEvent({ parsed: assistantEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
    });

    it('computes incremental delta from cumulative text', () => {
      const adapter = createChatGPTStreamAdapter();

      // First event: "Hello"
      expect(adapter.processEvent({ parsed: assistantEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });

      // Second event: "Hello, how" — only " how" is new
      expect(adapter.processEvent({ parsed: assistantEvent('Hello, how'), delta: null })).toEqual({
        feedText: ', how',
      });

      // Third event: "Hello, how can I help?" — only " can I help?" is new
      expect(
        adapter.processEvent({
          parsed: assistantEvent('Hello, how can I help?'),
          delta: null,
        }),
      ).toEqual({ feedText: ' can I help?' });
    });

    it('returns null when cumulative text has not grown', () => {
      const adapter = createChatGPTStreamAdapter();

      adapter.processEvent({ parsed: assistantEvent('Hello'), delta: null });
      // Same text again — no delta
      expect(adapter.processEvent({ parsed: assistantEvent('Hello'), delta: null })).toBeNull();
    });

    it('handles text with special characters', () => {
      const adapter = createChatGPTStreamAdapter();

      expect(
        adapter.processEvent({
          parsed: assistantEvent('Hello <world> & "friends"'),
          delta: null,
        }),
      ).toEqual({ feedText: 'Hello <world> & "friends"' });

      expect(
        adapter.processEvent({
          parsed: assistantEvent('Hello <world> & "friends"\nnew line'),
          delta: null,
        }),
      ).toEqual({ feedText: '\nnew line' });
    });
  });

  describe('non-assistant message filtering', () => {
    it('skips user messages', () => {
      const adapter = createChatGPTStreamAdapter();
      expect(adapter.processEvent({ parsed: userEvent('test'), delta: null })).toBeNull();
    });

    it('skips system messages', () => {
      const adapter = createChatGPTStreamAdapter();
      expect(adapter.processEvent({ parsed: systemEvent(), delta: null })).toBeNull();
    });

    it('skips events with no message field', () => {
      const adapter = createChatGPTStreamAdapter();
      expect(adapter.processEvent({ parsed: emptyEvent(), delta: null })).toBeNull();
    });

    it('skips events with no content', () => {
      const adapter = createChatGPTStreamAdapter();
      expect(adapter.processEvent({ parsed: noContentEvent(), delta: null })).toBeNull();
    });

    it('skips events with empty parts array', () => {
      const adapter = createChatGPTStreamAdapter();
      expect(adapter.processEvent({ parsed: emptyPartsEvent(), delta: null })).toBeNull();
    });
  });

  describe('conversation state passthrough', () => {
    it('passes through synthetic conversation state events (no text extraction)', () => {
      const adapter = createChatGPTStreamAdapter();
      // The synthetic event has no message.content.parts, so it returns null
      // (it's meant for extractConversationId in the tool strategy, not for text)
      expect(
        adapter.processEvent({
          parsed: conversationStateEvent('conv-123|msg-456'),
          delta: null,
        }),
      ).toBeNull();
    });
  });

  describe('flush', () => {
    it('returns null on flush', () => {
      const adapter = createChatGPTStreamAdapter();
      adapter.processEvent({ parsed: assistantEvent('Some text'), delta: null });
      expect(adapter.flush()).toBeNull();
    });
  });

  describe('shouldAbort', () => {
    it('never aborts', () => {
      const adapter = createChatGPTStreamAdapter();
      expect(adapter.shouldAbort()).toBe(false);
    });
  });

  describe('onFinish', () => {
    it('returns error for empty response', () => {
      const adapter = createChatGPTStreamAdapter();
      const result = adapter.onFinish?.({
        hasToolCalls: false,
        fullText: '',
        thinkingContent: undefined,
      });
      expect(result).toEqual({
        error: 'Empty response from ChatGPT. Please verify your ChatGPT session is active and try again.',
      });
    });

    it('returns null for non-empty response', () => {
      const adapter = createChatGPTStreamAdapter();
      const result = adapter.onFinish?.({
        hasToolCalls: false,
        fullText: 'Hello!',
        thinkingContent: undefined,
      });
      expect(result).toBeNull();
    });

    it('returns null when tool calls are present even with empty text', () => {
      const adapter = createChatGPTStreamAdapter();
      const result = adapter.onFinish?.({
        hasToolCalls: true,
        fullText: '',
        thinkingContent: undefined,
      });
      // When tool calls are present, empty text is not an error — the model
      // may have produced only tool calls without any text output.
      expect(result).toBeNull();
    });

    it('surfaces ChatGPT error message (e.g. rate limit) instead of generic error', () => {
      const adapter = createChatGPTStreamAdapter();
      // Simulate a rate-limit error event: { message: null, error: "..." }
      const errorEvent = {
        message: null,
        conversation_id: 'conv-123',
        error: "You've hit your limit. Please try again later.",
        error_code: null,
      };
      adapter.processEvent({ parsed: errorEvent, delta: null });
      const result = adapter.onFinish?.({
        hasToolCalls: false,
        fullText: '',
        thinkingContent: undefined,
      });
      expect(result).toEqual({
        error: "ChatGPT: You've hit your limit. Please try again later.",
      });
    });
  });

  describe('entity stripping', () => {
    it('strips entity[] references from text', () => {
      const adapter = createChatGPTStreamAdapter();
      const text = '### entity["turn0business0","Cinemark Lincoln Square"]\nThis is the main theater.';
      expect(adapter.processEvent({ parsed: assistantEvent(text), delta: null })).toEqual({
        feedText: '### This is the main theater.',
      });
    });

    it('strips entity_metadata[] references from text', () => {
      const adapter = createChatGPTStreamAdapter();
      const text = 'entity_metadata["turn0business0","one-line","Cinemark Lincoln Square"]\nThis is the main theater.';
      expect(adapter.processEvent({ parsed: assistantEvent(text), delta: null })).toEqual({
        feedText: 'This is the main theater.',
      });
    });

    it('strips mixed entity and entity_metadata references', () => {
      const adapter = createChatGPTStreamAdapter();
      const text = [
        '## Theater in Bellevue',
        '### entity["turn0business0","Cinemark Lincoln Square"]',
        'entity_metadata["turn0business0","one-line","Cinemark Lincoln Square"]',
        'This is the main theater.',
      ].join('\n');
      expect(adapter.processEvent({ parsed: assistantEvent(text), delta: null })).toEqual({
        feedText: '## Theater in Bellevue\n### This is the main theater.',
      });
    });

    it('does not strip text without entity patterns', () => {
      const adapter = createChatGPTStreamAdapter();
      const text = 'Hello, this is a normal response.';
      expect(adapter.processEvent({ parsed: assistantEvent(text), delta: null })).toEqual({
        feedText: 'Hello, this is a normal response.',
      });
    });

    it('strips entity-only delta down to whitespace', () => {
      const adapter = createChatGPTStreamAdapter();
      // First event: normal text
      adapter.processEvent({ parsed: assistantEvent('Hello'), delta: null });
      // Second event adds only entity markup on a new line
      const text = 'Hello\nentity["turn0business0","Theater"]';
      // After stripping, only a newline remains — still valid whitespace output
      expect(adapter.processEvent({ parsed: assistantEvent(text), delta: null })).toEqual({
        feedText: '\n',
      });
    });

    it('collapses excess newlines after stripping', () => {
      const adapter = createChatGPTStreamAdapter();
      const text = 'Before\n\n\nentity["id","Name"]\n\n\nAfter';
      expect(adapter.processEvent({ parsed: assistantEvent(text), delta: null })).toEqual({
        feedText: 'Before\n\nAfter',
      });
    });
  });

  describe('text with object-style parts', () => {
    it('extracts text from object-style parts with text property', () => {
      const adapter = createChatGPTStreamAdapter();
      const event = {
        message: {
          id: 'msg-006',
          author: { role: 'assistant' },
          content: {
            content_type: 'text',
            parts: [{ text: 'Hello from object' }],
          },
        },
      };
      expect(adapter.processEvent({ parsed: event, delta: null })).toEqual({
        feedText: 'Hello from object',
      });
    });
  });
});
