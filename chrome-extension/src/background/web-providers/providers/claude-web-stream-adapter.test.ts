/**
 * Tests for claude-stream-adapter.ts — Claude-specific SSE stream processing.
 */
import { describe, it, expect, vi } from 'vitest';
import { createClaudeStreamAdapter } from './claude-web-stream-adapter';

// Mock crypto.randomUUID for deterministic fallback tool IDs
vi.stubGlobal('crypto', { randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });

describe('createClaudeStreamAdapter', () => {
  describe('text_delta extraction', () => {
    it('extracts text from text_delta events', () => {
      const adapter = createClaudeStreamAdapter();
      const result = adapter.processEvent({
        parsed: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        delta: null,
      });
      expect(result).toEqual({ feedText: 'Hello' });
    });

    it('handles multiple text deltas sequentially', () => {
      const adapter = createClaudeStreamAdapter();
      expect(
        adapter.processEvent({
          parsed: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
          delta: null,
        }),
      ).toEqual({ feedText: 'Hello' });
      expect(
        adapter.processEvent({
          parsed: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
          delta: null,
        }),
      ).toEqual({ feedText: ' world' });
    });
  });

  describe('thinking content handling', () => {
    it('emits <think> on thinking content_block_start', () => {
      const adapter = createClaudeStreamAdapter();
      const result = adapter.processEvent({
        parsed: { type: 'content_block_start', content_block: { type: 'thinking' } },
        delta: null,
      });
      expect(result).toEqual({ feedText: '<think>' });
    });

    it('extracts thinking text from thinking_delta events', () => {
      const adapter = createClaudeStreamAdapter();
      adapter.processEvent({
        parsed: { type: 'content_block_start', content_block: { type: 'thinking' } },
        delta: null,
      });
      const result = adapter.processEvent({
        parsed: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me think...' } },
        delta: null,
      });
      expect(result).toEqual({ feedText: 'Let me think...' });
    });

    it('emits </think> on content_block_stop when in thinking', () => {
      const adapter = createClaudeStreamAdapter();
      adapter.processEvent({
        parsed: { type: 'content_block_start', content_block: { type: 'thinking' } },
        delta: null,
      });
      const result = adapter.processEvent({
        parsed: { type: 'content_block_stop' },
        delta: null,
      });
      expect(result).toEqual({ feedText: '</think>' });
    });

    it('handles full thinking → text lifecycle', () => {
      const adapter = createClaudeStreamAdapter();
      const results: (string | null)[] = [];

      results.push(
        adapter.processEvent({
          parsed: { type: 'content_block_start', content_block: { type: 'thinking' } },
          delta: null,
        })?.feedText ?? null,
      );
      results.push(
        adapter.processEvent({
          parsed: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'reasoning' } },
          delta: null,
        })?.feedText ?? null,
      );
      results.push(
        adapter.processEvent({
          parsed: { type: 'content_block_stop' },
          delta: null,
        })?.feedText ?? null,
      );
      results.push(
        adapter.processEvent({
          parsed: { type: 'content_block_start', content_block: { type: 'text' } },
          delta: null,
        })?.feedText ?? null,
      );
      results.push(
        adapter.processEvent({
          parsed: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
          delta: null,
        })?.feedText ?? null,
      );

      expect(results).toEqual(['<think>', 'reasoning', '</think>', null, 'answer']);
    });
  });

  describe('native tool_use → XML conversion', () => {
    it('converts tool_use block to XML tool_call on content_block_stop', () => {
      const adapter = createClaudeStreamAdapter();
      adapter.processEvent({
        parsed: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'toolu_01ABC', name: 'web_search' },
        },
        delta: null,
      });
      adapter.processEvent({
        parsed: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"query":' } },
        delta: null,
      });
      adapter.processEvent({
        parsed: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"test"}' } },
        delta: null,
      });
      const result = adapter.processEvent({ parsed: { type: 'content_block_stop' }, delta: null });
      expect(result).toEqual({
        feedText: '<tool_call id="toolu_01" name="web_search">{"query":"test"}</tool_call>',
      });
    });

    it('uses fallback ID when tool_use has no id', () => {
      const adapter = createClaudeStreamAdapter();
      adapter.processEvent({
        parsed: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'read' } },
        delta: null,
      });
      const result = adapter.processEvent({ parsed: { type: 'content_block_stop' }, delta: null });
      expect(result).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="read">{}</tool_call>',
      });
    });

    it('signals shouldAbort after emitting native tool call', () => {
      const adapter = createClaudeStreamAdapter();
      expect(adapter.shouldAbort()).toBe(false);

      adapter.processEvent({
        parsed: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'toolu_01', name: 'web_search' },
        },
        delta: null,
      });
      adapter.processEvent({
        parsed: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } },
        delta: null,
      });
      adapter.processEvent({ parsed: { type: 'content_block_stop' }, delta: null });

      expect(adapter.shouldAbort()).toBe(true);
    });

    it('flushes incomplete tool_use block', () => {
      const adapter = createClaudeStreamAdapter();
      adapter.processEvent({
        parsed: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'toolu_flush', name: 'search' },
        },
        delta: null,
      });
      adapter.processEvent({
        parsed: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
        delta: null,
      });
      const result = adapter.flush();
      expect(result).toEqual({
        feedText: '<tool_call id="toolu_fl" name="search">{"x":1}</tool_call>',
      });
      expect(adapter.shouldAbort()).toBe(true);
    });
  });

  describe('tool_result block suppression', () => {
    it('ignores tool_result blocks entirely', () => {
      const adapter = createClaudeStreamAdapter();
      expect(
        adapter.processEvent({
          parsed: {
            type: 'content_block_start',
            content_block: { type: 'tool_result', tool_use_id: 'toolu_01', is_error: true },
          },
          delta: null,
        }),
      ).toBeNull();
      expect(
        adapter.processEvent({
          parsed: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '[]' } },
          delta: null,
        }),
      ).toBeNull();
      expect(
        adapter.processEvent({ parsed: { type: 'content_block_stop' }, delta: null }),
      ).toBeNull();
    });

    it('handles full tool_use → tool_result → text sequence', () => {
      const adapter = createClaudeStreamAdapter();
      // tool_use → converted to XML
      adapter.processEvent({
        parsed: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_01', name: 'web_search' } },
        delta: null,
      });
      adapter.processEvent({
        parsed: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"q":"sf"}' } },
        delta: null,
      });
      const toolResult = adapter.processEvent({ parsed: { type: 'content_block_stop' }, delta: null });
      expect(toolResult?.feedText).toContain('<tool_call');
      expect(adapter.shouldAbort()).toBe(true);

      // tool_result → ignored
      adapter.processEvent({
        parsed: { type: 'content_block_start', content_block: { type: 'tool_result', tool_use_id: 'toolu_01', is_error: true } },
        delta: null,
      });
      adapter.processEvent({ parsed: { type: 'content_block_stop' }, delta: null });

      // text → still processes (bridge will abort based on shouldAbort before this matters)
      adapter.processEvent({
        parsed: { type: 'content_block_start', content_block: { type: 'text' } },
        delta: null,
      });
      const textResult = adapter.processEvent({
        parsed: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'tool failed' } },
        delta: null,
      });
      expect(textResult).toEqual({ feedText: 'tool failed' });
    });
  });

  describe('flush', () => {
    it('closes unclosed thinking block', () => {
      const adapter = createClaudeStreamAdapter();
      adapter.processEvent({
        parsed: { type: 'content_block_start', content_block: { type: 'thinking' } },
        delta: null,
      });
      expect(adapter.flush()).toEqual({ feedText: '</think>' });
    });

    it('returns null when nothing to flush', () => {
      const adapter = createClaudeStreamAdapter();
      expect(adapter.flush()).toBeNull();
    });
  });

  describe('error detection', () => {
    it('throws on error frame', () => {
      const adapter = createClaudeStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: { error: { message: 'Rate limit exceeded' } },
          delta: null,
        }),
      ).toThrow('Rate limit exceeded');
    });

    it('throws generic message when error has no message', () => {
      const adapter = createClaudeStreamAdapter();
      expect(() =>
        adapter.processEvent({ parsed: { error: {} }, delta: null }),
      ).toThrow('Unknown Claude error');
    });
  });

  describe('ignored event types', () => {
    for (const eventType of ['message_start', 'message_stop', 'message_delta', 'ping']) {
      it(`returns null for ${eventType}`, () => {
        const adapter = createClaudeStreamAdapter();
        expect(
          adapter.processEvent({ parsed: { type: eventType }, delta: null }),
        ).toBeNull();
      });
    }
  });

  describe('edge cases', () => {
    it('returns null for content_block_delta with no delta', () => {
      const adapter = createClaudeStreamAdapter();
      expect(
        adapter.processEvent({ parsed: { type: 'content_block_delta' }, delta: null }),
      ).toBeNull();
    });

    it('shouldAbort is false when no native tools were used', () => {
      const adapter = createClaudeStreamAdapter();
      adapter.processEvent({
        parsed: { type: 'content_block_start', content_block: { type: 'text' } },
        delta: null,
      });
      adapter.processEvent({
        parsed: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
        delta: null,
      });
      expect(adapter.shouldAbort()).toBe(false);
    });

    it('ignores input_json_delta when no tool_use block is active', () => {
      const adapter = createClaudeStreamAdapter();
      expect(
        adapter.processEvent({
          parsed: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } },
          delta: null,
        }),
      ).toBeNull();
    });
  });
});
