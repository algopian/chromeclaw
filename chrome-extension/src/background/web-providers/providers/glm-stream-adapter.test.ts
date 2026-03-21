/**
 * Tests for glm-stream-adapter.ts — GLM-specific SSE stream processing.
 */
import { describe, it, expect } from 'vitest';
import { createGlmStreamAdapter } from './glm-stream-adapter';

/** Helper to build a GLM SSE parsed object with text content. */
const textEvent = (text: string) => ({
  parts: [{ content: [{ type: 'text', text }] }],
});

/** Helper to build a GLM SSE parsed object with think content. */
const thinkEvent = (think: string) => ({
  parts: [{ content: [{ type: 'think', think }] }],
});

describe('createGlmStreamAdapter', () => {
  describe('cumulative text deduplication', () => {
    it('computes delta from cumulative text', () => {
      const adapter = createGlmStreamAdapter();
      expect(adapter.processEvent({ parsed: textEvent('Hello'), delta: 'Hello' })).toEqual({
        feedText: 'Hello',
      });
      expect(adapter.processEvent({ parsed: textEvent('Hello world'), delta: 'Hello world' })).toEqual({
        feedText: ' world',
      });
      expect(adapter.processEvent({ parsed: textEvent('Hello world!'), delta: 'Hello world!' })).toEqual({
        feedText: '!',
      });
    });

    it('returns null when text has not grown', () => {
      const adapter = createGlmStreamAdapter();
      adapter.processEvent({ parsed: textEvent('Hello'), delta: 'Hello' });
      // Same text again — no new delta
      expect(adapter.processEvent({ parsed: textEvent('Hello'), delta: 'Hello' })).toBeNull();
    });
  });

  describe('think content handling', () => {
    it('wraps think deltas in <think> tags', () => {
      const adapter = createGlmStreamAdapter();
      expect(adapter.processEvent({ parsed: thinkEvent('Let me'), delta: null })).toEqual({
        feedText: '<think>Let me',
      });
      expect(adapter.processEvent({ parsed: thinkEvent('Let me think'), delta: null })).toEqual({
        feedText: ' think',
      });
    });

    it('closes think block when transitioning to text', () => {
      const adapter = createGlmStreamAdapter();
      adapter.processEvent({ parsed: thinkEvent('reasoning'), delta: null });
      const result = adapter.processEvent({ parsed: textEvent('answer'), delta: 'answer' });
      expect(result).toEqual({ feedText: '</think>answer' });
    });

    it('closes think block on flush', () => {
      const adapter = createGlmStreamAdapter();
      adapter.processEvent({ parsed: thinkEvent('incomplete'), delta: null });
      expect(adapter.flush()).toEqual({ feedText: '</think>' });
    });

    it('flush returns null when no think was started', () => {
      const adapter = createGlmStreamAdapter();
      expect(adapter.flush()).toBeNull();
    });
  });

  describe('non-standard closing tag normalization', () => {
    it('normalizes </tool_call的工具结果> to </tool_call>', () => {
      const adapter = createGlmStreamAdapter();
      const text = '<tool_call id="a1" name="web_search">{"query":"test"}</tool_call的工具结果>';
      const result = adapter.processEvent({ parsed: textEvent(text), delta: text });
      expect(result!.feedText).toContain('</tool_call>');
      expect(result!.feedText).not.toContain('的工具结果');
    });

    it('normalizes </tool_call〉 (fullwidth bracket) to </tool_call>', () => {
      const adapter = createGlmStreamAdapter();
      const text = '<tool_call id="a1" name="web_search">{"query":"test"}\n</tool_call〉';
      const result = adapter.processEvent({ parsed: textEvent(text), delta: text });
      expect(result!.feedText).toContain('</tool_call>');
      expect(result!.feedText).not.toContain('〉');
    });

    it('preserves standard </tool_call> as-is', () => {
      const adapter = createGlmStreamAdapter();
      const text = '<tool_call id="a1" name="web_search">{"query":"test"}</tool_call>';
      const result = adapter.processEvent({ parsed: textEvent(text), delta: text });
      expect(result!.feedText).toContain('</tool_call>');
    });
  });

  describe('error detection', () => {
    it('throws on error frame', () => {
      const adapter = createGlmStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: { error: { message: 'Rate limit exceeded' } },
          delta: null,
        }),
      ).toThrow('Rate limit exceeded');
    });

    it('throws generic message when error has no message', () => {
      const adapter = createGlmStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: { error: {} },
          delta: null,
        }),
      ).toThrow('Unknown GLM error');
    });
  });

  describe('edge cases', () => {
    it('returns null for empty parts', () => {
      const adapter = createGlmStreamAdapter();
      expect(adapter.processEvent({ parsed: { parts: [] }, delta: null })).toBeNull();
    });

    it('returns null for init event with no content', () => {
      const adapter = createGlmStreamAdapter();
      expect(
        adapter.processEvent({
          parsed: { parts: [], status: 'init' },
          delta: null,
        }),
      ).toBeNull();
    });

    it('shouldAbort always returns false', () => {
      const adapter = createGlmStreamAdapter();
      expect(adapter.shouldAbort()).toBe(false);
    });
  });
});
