/**
 * Tests for glm-intl-stream-adapter.ts — GLM International SSE stream processing.
 */
import { describe, it, expect } from 'vitest';
import { createGlmIntlStreamAdapter } from './glm-intl-stream-adapter';

/** Helper to build a GLM-Intl SSE parsed object with answer delta. */
const answerEvent = (delta: string) => ({
  type: 'chat:completion',
  data: { delta_content: delta, phase: 'answer' },
});

/** Helper to build a GLM-Intl SSE parsed object with thinking delta. */
const thinkEvent = (delta: string) => ({
  type: 'chat:completion',
  data: { delta_content: delta, phase: 'thinking' },
});

describe('createGlmIntlStreamAdapter', () => {
  describe('basic delta passthrough', () => {
    it('passes answer delta through', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(adapter.processEvent({ parsed: answerEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
    });

    it('returns null for non-chat:completion events', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(
        adapter.processEvent({
          parsed: { type: 'other', data: { delta_content: 'ignored' } },
          delta: null,
        }),
      ).toBeNull();
    });

    it('returns null for events without delta_content', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(
        adapter.processEvent({
          parsed: { type: 'chat:completion', data: { phase: 'other', usage: {} } },
          delta: null,
        }),
      ).toBeNull();
    });
  });

  describe('think content handling', () => {
    it('wraps first thinking delta in <think> tag', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(adapter.processEvent({ parsed: thinkEvent('Let me'), delta: null })).toEqual({
        feedText: '<think>Let me',
      });
    });

    it('passes subsequent thinking deltas through without tag', () => {
      const adapter = createGlmIntlStreamAdapter();
      adapter.processEvent({ parsed: thinkEvent('Let me'), delta: null });
      expect(adapter.processEvent({ parsed: thinkEvent(' think'), delta: null })).toEqual({
        feedText: ' think',
      });
    });

    it('closes think block when transitioning to answer', () => {
      const adapter = createGlmIntlStreamAdapter();
      adapter.processEvent({ parsed: thinkEvent('reasoning'), delta: null });
      const result = adapter.processEvent({ parsed: answerEvent('answer'), delta: null });
      expect(result).toEqual({ feedText: '</think>answer' });
    });

    it('closes think block on flush', () => {
      const adapter = createGlmIntlStreamAdapter();
      adapter.processEvent({ parsed: thinkEvent('incomplete'), delta: null });
      expect(adapter.flush()).toEqual({ feedText: '</think>' });
    });

    it('flush returns null when no think was started', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(adapter.flush()).toBeNull();
    });
  });

  describe('non-standard closing tag normalization', () => {
    it('normalizes </tool_call的工具结果> to </tool_call>', () => {
      const adapter = createGlmIntlStreamAdapter();
      const result = adapter.processEvent({
        parsed: answerEvent('{"query":"test"}</tool_call的工具结果>'),
        delta: null,
      });
      expect(result!.feedText).toContain('</tool_call>');
      expect(result!.feedText).not.toContain('的工具结果');
    });

    it('normalizes </tool_call〉 (fullwidth bracket) to </tool_call>', () => {
      const adapter = createGlmIntlStreamAdapter();
      const result = adapter.processEvent({
        parsed: answerEvent('{"query":"test"}\n</tool_call〉'),
        delta: null,
      });
      expect(result!.feedText).toContain('</tool_call>');
      expect(result!.feedText).not.toContain('〉');
    });

    it('normalizes </tool_call＞ (fullwidth greater-than U+FF1E) to </tool_call>', () => {
      const adapter = createGlmIntlStreamAdapter();
      const result = adapter.processEvent({
        parsed: answerEvent('{"query":"test"}\n</tool_call\uFF1E'),
        delta: null,
      });
      expect(result!.feedText).toContain('</tool_call>');
      expect(result!.feedText).not.toContain('\uFF1E');
    });

    it("normalizes </call'> (truncated tag name) to </tool_call>", () => {
      const adapter = createGlmIntlStreamAdapter();
      const result = adapter.processEvent({
        parsed: answerEvent('{"url": "https://example.com"}</call\'>'),
        delta: null,
      });
      expect(result!.feedText).toContain('</tool_call>');
      expect(result!.feedText).not.toContain("</call'>");
    });

    it('preserves standard </tool_call> as-is', () => {
      const adapter = createGlmIntlStreamAdapter();
      const result = adapter.processEvent({
        parsed: answerEvent('{"query":"test"}</tool_call>'),
        delta: null,
      });
      expect(result!.feedText).toContain('</tool_call>');
    });
  });

  describe('edge cases', () => {
    it('shouldAbort always returns false', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(adapter.shouldAbort()).toBe(false);
    });
  });

  describe('error detection', () => {
    it('throws on MODEL_CONCURRENCY_LIMIT error frame', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: {
            type: 'chat:completion',
            data: {
              content: '',
              done: true,
              error: {
                code: 'MODEL_CONCURRENCY_LIMIT',
                detail: 'Model is currently at capacity. Please try again later or switch to another model.',
                model_id: 'GLM-5-Turbo',
              },
            },
          },
          delta: null,
        }),
      ).toThrow('MODEL_CONCURRENCY_LIMIT: Model is currently at capacity. Please try again later or switch to another model.');
    });

    it('throws on error frame with detail but no code', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: {
            type: 'chat:completion',
            data: { error: { detail: 'Rate limit exceeded' } },
          },
          delta: null,
        }),
      ).toThrow('Rate limit exceeded');
    });

    it('throws on error frame with message fallback', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: {
            type: 'chat:completion',
            data: { error: { message: 'Something went wrong' } },
          },
          delta: null,
        }),
      ).toThrow('Something went wrong');
    });

    it('throws generic message when error has no detail or message', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: {
            type: 'chat:completion',
            data: { error: {} },
          },
          delta: null,
        }),
      ).toThrow('Unknown GLM error');
    });
  });

  describe('onFinish', () => {
    it('returns error when response is empty (no text, no tool calls)', () => {
      const adapter = createGlmIntlStreamAdapter();
      const result = adapter.onFinish!({ hasToolCalls: false, fullText: '', thinkingContent: undefined });
      expect(result).toEqual({
        error: expect.stringContaining('GLM returned an empty response'),
      });
      expect(result).toEqual({
        error: expect.stringContaining('chat.z.ai'),
      });
    });

    it('returns null when response has text', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(adapter.onFinish!({ hasToolCalls: false, fullText: 'Hello', thinkingContent: undefined })).toBeNull();
    });

    it('returns null when response has tool calls', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(adapter.onFinish!({ hasToolCalls: true, fullText: '', thinkingContent: undefined })).toBeNull();
    });
  });
});
