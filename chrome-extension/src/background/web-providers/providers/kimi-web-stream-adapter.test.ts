/**
 * Tests for kimi-stream-adapter.ts — Kimi-specific SSE stream processing.
 */
import { describe, it, expect } from 'vitest';
import { createKimiStreamAdapter } from './kimi-web-stream-adapter';

describe('createKimiStreamAdapter', () => {
  describe('processEvent', () => {
    it('passes through regular text delta', () => {
      const adapter = createKimiStreamAdapter();
      const result = adapter.processEvent({
        parsed: { op: 'append', block: { text: { content: 'hello' } } },
        delta: 'hello',
      });
      expect(result).toEqual({ feedText: 'hello' });
    });

    it('returns null when delta is null', () => {
      const adapter = createKimiStreamAdapter();
      const result = adapter.processEvent({
        parsed: { op: 'set', block: { type: 'image' } },
        delta: null,
      });
      expect(result).toBeNull();
    });

    it('returns final delta on done frame', () => {
      const adapter = createKimiStreamAdapter();
      const result = adapter.processEvent({
        parsed: { done: true },
        delta: 'last bit',
      });
      expect(result).toEqual({ feedText: 'last bit' });
    });

    it('returns null on done frame with no delta', () => {
      const adapter = createKimiStreamAdapter();
      const result = adapter.processEvent({
        parsed: { done: true },
        delta: null,
      });
      expect(result).toBeNull();
    });

    it('throws on error frame', () => {
      const adapter = createKimiStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
          delta: null,
        }),
      ).toThrow('Too many requests');
    });

    it('throws with code when error has no message', () => {
      const adapter = createKimiStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: { error: { code: 'INTERNAL_ERROR' } },
          delta: null,
        }),
      ).toThrow('INTERNAL_ERROR');
    });

    it('throws generic message when error has neither code nor message', () => {
      const adapter = createKimiStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: { error: {} },
          delta: null,
        }),
      ).toThrow('Unknown Kimi error');
    });
  });

  describe('flush', () => {
    it('returns null', () => {
      const adapter = createKimiStreamAdapter();
      expect(adapter.flush()).toBeNull();
    });
  });

  describe('shouldAbort', () => {
    it('always returns false', () => {
      const adapter = createKimiStreamAdapter();
      expect(adapter.shouldAbort()).toBe(false);

      // Even after processing events
      adapter.processEvent({ parsed: { op: 'append' }, delta: 'text' });
      expect(adapter.shouldAbort()).toBe(false);
    });
  });
});
