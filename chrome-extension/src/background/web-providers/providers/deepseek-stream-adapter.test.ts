/**
 * Tests for deepseek-stream-adapter.ts — DeepSeek SSE stream processing.
 */
import { describe, it, expect } from 'vitest';
import { createDeepSeekStreamAdapter } from './deepseek-stream-adapter';

// ── Test Helpers ─────────────────────────────────

/** JSON-patch style content event: {"p":["content"],"v":"text"} */
const contentEvent = (v: string) => ({ p: ['content'], v });

/** JSON-patch style reasoning event: {"p":["reasoning"],"v":"text"} */
const reasoningEvent = (v: string) => ({ p: ['reasoning'], v });

/** Explicit type-based thinking event: {"type":"thinking","content":"..."} */
const thinkingTypeEvent = (content: string) => ({ type: 'thinking', content });

/** Explicit type-based text event: {"type":"text","content":"..."} */
const textTypeEvent = (content: string) => ({ type: 'text', content });

/** OpenAI-compatible choices event */
const choicesEvent = (content?: string, reasoning?: string) => ({
  choices: [{ delta: { content, reasoning_content: reasoning } }],
});

/** Search result event */
const searchEvent = (query: string) => ({ type: 'search_result', v: { query } });

/** Nested fragments event (initial response) */
const fragmentsEvent = (frags: Array<{ type: string; content: string }>) => ({
  v: { response: { fragments: frags } },
});

/** Conversation metadata event */
const metadataEvent = (msgId: string) => ({ response_message_id: msgId });

/** Bare text delta (no path) — shorthand: {"v":"text"} */
const bareDelta = (v: string) => ({ v });

/** Fragment content delta via JSON-patch: {"p":"response/fragments/-1/content","o":"APPEND","v":"text"} */
const fragmentContentDelta = (v: string) => ({
  p: 'response/fragments/-1/content',
  o: 'APPEND',
  v,
});

/** New fragment append via JSON-patch: {"p":"response/fragments","o":"APPEND","v":[{...}]} */
const fragmentAppend = (frags: Array<{ type: string; content: string }>) => ({
  p: 'response/fragments',
  o: 'APPEND',
  v: frags,
});

// ── Tests ────────────────────────────────────────

describe('createDeepSeekStreamAdapter', () => {
  describe('basic delta passthrough (JSON-patch style)', () => {
    it('passes content delta through', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(adapter.processEvent({ parsed: contentEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
    });

    it('returns null for empty events', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(adapter.processEvent({ parsed: {}, delta: null })).toBeNull();
    });

    it('returns null for metadata-only events', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(adapter.processEvent({ parsed: metadataEvent('msg-123'), delta: null })).toBeNull();
    });

    it('handles explicit text type events', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(adapter.processEvent({ parsed: textTypeEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
    });
  });

  describe('thinking/reasoning content', () => {
    it('wraps first reasoning delta in <think> tag (JSON-patch style)', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(adapter.processEvent({ parsed: reasoningEvent('Let me'), delta: null })).toEqual({
        feedText: '<think>Let me',
      });
    });

    it('passes subsequent reasoning deltas through without tag', () => {
      const adapter = createDeepSeekStreamAdapter();
      adapter.processEvent({ parsed: reasoningEvent('Let me'), delta: null });
      expect(adapter.processEvent({ parsed: reasoningEvent(' think'), delta: null })).toEqual({
        feedText: ' think',
      });
    });

    it('handles explicit thinking type events', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(
        adapter.processEvent({ parsed: thinkingTypeEvent('reasoning'), delta: null }),
      ).toEqual({
        feedText: '<think>reasoning',
      });
    });

    it('closes think block when transitioning to content', () => {
      const adapter = createDeepSeekStreamAdapter();
      adapter.processEvent({ parsed: reasoningEvent('reasoning'), delta: null });
      const result = adapter.processEvent({ parsed: contentEvent('answer'), delta: null });
      expect(result).toEqual({ feedText: '</think>answer' });
    });

    it('closes think block when transitioning to text type', () => {
      const adapter = createDeepSeekStreamAdapter();
      adapter.processEvent({ parsed: reasoningEvent('reasoning'), delta: null });
      const result = adapter.processEvent({ parsed: textTypeEvent('answer'), delta: null });
      expect(result).toEqual({ feedText: '</think>answer' });
    });
  });

  describe('junk token filtering', () => {
    it('filters <｜end▁of▁thinking｜> token completely', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(
        adapter.processEvent({ parsed: contentEvent('<｜end▁of▁thinking｜>'), delta: null }),
      ).toBeNull();
    });

    it('filters <|endoftext|> token completely', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(
        adapter.processEvent({ parsed: contentEvent('<|endoftext|>'), delta: null }),
      ).toBeNull();
    });

    it('strips junk tokens from within content', () => {
      const adapter = createDeepSeekStreamAdapter();
      const result = adapter.processEvent({
        parsed: contentEvent('Hello<｜end▁of▁thinking｜> world'),
        delta: null,
      });
      expect(result).toEqual({ feedText: 'Hello world' });
    });

    it('filters junk tokens in reasoning content', () => {
      const adapter = createDeepSeekStreamAdapter();
      // Start thinking
      adapter.processEvent({ parsed: reasoningEvent('start'), delta: null });
      // Junk-only reasoning event
      expect(
        adapter.processEvent({ parsed: reasoningEvent('<｜end▁of▁thinking｜>'), delta: null }),
      ).toBeNull();
    });
  });

  describe('search results', () => {
    it('emits search status message', () => {
      const adapter = createDeepSeekStreamAdapter();
      const result = adapter.processEvent({ parsed: searchEvent('test query'), delta: null });
      expect(result).toEqual({ feedText: '\n> [Searching: test query...]\n' });
    });

    it('returns null for search events without query', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(
        adapter.processEvent({
          parsed: { type: 'search_result', v: {} },
          delta: null,
        }),
      ).toBeNull();
    });
  });

  describe('nested fragments', () => {
    it('handles mixed thinking and text fragments', () => {
      const adapter = createDeepSeekStreamAdapter();
      const result = adapter.processEvent({
        parsed: fragmentsEvent([
          { type: 'THINKING', content: 'hmm' },
          { type: 'text', content: 'answer' },
        ]),
        delta: null,
      });
      expect(result).toEqual({ feedText: '<think>hmm</think>answer' });
    });

    it('handles text-only fragments', () => {
      const adapter = createDeepSeekStreamAdapter();
      const result = adapter.processEvent({
        parsed: fragmentsEvent([{ type: 'text', content: 'just text' }]),
        delta: null,
      });
      expect(result).toEqual({ feedText: 'just text' });
    });

    it('handles reasoning-type fragments', () => {
      const adapter = createDeepSeekStreamAdapter();
      const result = adapter.processEvent({
        parsed: fragmentsEvent([{ type: 'reasoning', content: 'thinking...' }]),
        delta: null,
      });
      expect(result).toEqual({ feedText: '<think>thinking...' });
    });
  });

  describe('OpenAI-compatible choices fallback', () => {
    it('handles content delta', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(adapter.processEvent({ parsed: choicesEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
    });

    it('handles reasoning_content delta', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(
        adapter.processEvent({ parsed: choicesEvent(undefined, 'reasoning'), delta: null }),
      ).toEqual({
        feedText: '<think>reasoning',
      });
    });

    it('handles both reasoning and content in same event', () => {
      const adapter = createDeepSeekStreamAdapter();
      const result = adapter.processEvent({
        parsed: choicesEvent('text', 'reasoning'),
        delta: null,
      });
      // reasoning opens <think>, content closes it
      expect(result).toEqual({ feedText: '<think>reasoning</think>text' });
    });
  });

  describe('flush behavior', () => {
    it('closes unclosed think block on flush', () => {
      const adapter = createDeepSeekStreamAdapter();
      adapter.processEvent({ parsed: reasoningEvent('incomplete'), delta: null });
      expect(adapter.flush()).toEqual({ feedText: '</think>' });
    });

    it('returns null on flush when no think was started', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(adapter.flush()).toBeNull();
    });

    it('returns null on flush after think was properly closed', () => {
      const adapter = createDeepSeekStreamAdapter();
      adapter.processEvent({ parsed: reasoningEvent('thinking'), delta: null });
      adapter.processEvent({ parsed: contentEvent('answer'), delta: null });
      expect(adapter.flush()).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('shouldAbort always returns false', () => {
      const adapter = createDeepSeekStreamAdapter();
      expect(adapter.shouldAbort()).toBe(false);
    });

    it('handles mixed formats in sequence', () => {
      const adapter = createDeepSeekStreamAdapter();
      // Start with reasoning (JSON-patch)
      const r1 = adapter.processEvent({ parsed: reasoningEvent('think'), delta: null });
      expect(r1).toEqual({ feedText: '<think>think' });
      // Transition to content (JSON-patch)
      const r2 = adapter.processEvent({ parsed: contentEvent('answer'), delta: null });
      expect(r2).toEqual({ feedText: '</think>answer' });
      // More content via choices format
      const r3 = adapter.processEvent({ parsed: choicesEvent(' more'), delta: null });
      expect(r3).toEqual({ feedText: ' more' });
    });

    it('handles string search result value', () => {
      const adapter = createDeepSeekStreamAdapter();
      const result = adapter.processEvent({
        parsed: { type: 'search_result', v: 'direct query string' },
        delta: null,
      });
      expect(result).toEqual({ feedText: '\n> [Searching: direct query string...]\n' });
    });
  });

  describe('bare deltas during thinking (real DeepSeek SSE flow)', () => {
    it('bare deltas do not close think block when inThinking', () => {
      const adapter = createDeepSeekStreamAdapter();
      // Initial THINK fragment opens thinking
      const r1 = adapter.processEvent({
        parsed: fragmentsEvent([{ type: 'THINK', content: 'We' }]),
        delta: null,
      });
      expect(r1).toEqual({ feedText: '<think>We' });

      // Bare deltas continue thinking — should NOT emit </think>
      const r2 = adapter.processEvent({ parsed: bareDelta("'ll"), delta: null });
      expect(r2).toEqual({ feedText: "'ll" });

      const r3 = adapter.processEvent({ parsed: bareDelta(' use'), delta: null });
      expect(r3).toEqual({ feedText: ' use' });

      const r4 = adapter.processEvent({ parsed: bareDelta(' the'), delta: null });
      expect(r4).toEqual({ feedText: ' the' });

      // Flush should close the unclosed think block
      expect(adapter.flush()).toEqual({ feedText: '</think>' });
    });

    it('full THINK→RESPONSE transition with bare deltas matches real SSE flow', () => {
      const adapter = createDeepSeekStreamAdapter();
      const results: string[] = [];
      const proc = (parsed: unknown) => {
        const r = adapter.processEvent({ parsed, delta: null });
        if (r) results.push(r.feedText);
      };

      // Step 1: Initial THINK fragment
      proc(fragmentsEvent([{ type: 'THINK', content: 'We' }]));

      // Step 2: Bare deltas (continuation of THINK fragment)
      proc(bareDelta("'ll"));
      proc(bareDelta(' use'));
      proc(bareDelta(' the'));
      proc(bareDelta(' web_search'));
      proc(bareDelta(' tool.'));

      // Step 3: RESPONSE fragment append (transition to text)
      proc(fragmentAppend([{ type: 'RESPONSE', content: "I'll" }]));

      // Step 4: More bare deltas (now text, not thinking)
      proc(bareDelta(' search'));
      proc(bareDelta(' for'));

      // Flush (thinking already closed, should be null)
      const flush = adapter.flush();
      expect(flush).toBeNull();

      expect(results.join('')).toBe(
        "<think>We'll use the web_search tool.</think>I'll search for",
      );
    });

    it('fragment content deltas during thinking pass through correctly', () => {
      const adapter = createDeepSeekStreamAdapter();
      // Start thinking via initial fragment
      adapter.processEvent({
        parsed: fragmentsEvent([{ type: 'THINK', content: 'Start' }]),
        delta: null,
      });

      // Fragment content delta (has explicit path) — should pass through
      const r = adapter.processEvent({
        parsed: fragmentContentDelta(' more thinking'),
        delta: null,
      });
      expect(r).toEqual({ feedText: ' more thinking' });
    });

    it('bare deltas after RESPONSE fragment are text, not thinking', () => {
      const adapter = createDeepSeekStreamAdapter();
      // THINK fragment
      adapter.processEvent({
        parsed: fragmentsEvent([{ type: 'THINK', content: 'hmm' }]),
        delta: null,
      });
      // RESPONSE fragment closes thinking
      const r1 = adapter.processEvent({
        parsed: fragmentAppend([{ type: 'RESPONSE', content: 'Answer' }]),
        delta: null,
      });
      expect(r1).toEqual({ feedText: '</think>Answer' });

      // Bare deltas should now be text (inThinking = false)
      const r2 = adapter.processEvent({ parsed: bareDelta(' is here'), delta: null });
      expect(r2).toEqual({ feedText: ' is here' });
    });
  });
});
