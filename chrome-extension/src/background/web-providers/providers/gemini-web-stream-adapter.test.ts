/**
 * Tests for gemini-stream-adapter.ts — Gemini-specific stream processing.
 */
import { describe, it, expect } from 'vitest';
import {
  createGeminiStreamAdapter,
  extractGeminiText,
} from './gemini-web-stream-adapter';

/**
 * Helper to build a Gemini response chunk matching the actual response structure.
 *
 * Actual format from network capture:
 *   Outer: [["wrb.fr", null, "<inner_json_string>"]]
 *   Inner: [null, [conv_id, resp_id], null, null,
 *           [[candidate_id, [text_segments], null, ...metadata]],
 *           [geo_data], ...]
 */
const textChunk = (text: string, convId = 'c_abc123', respId = 'r_def456') => {
  const inner = JSON.stringify([
    null,
    [convId, respId],
    null,
    null,
    [['rc_candidate1', [text], null, null, null, null, true, null, [2], 'en']],
  ]);
  return [['wrb.fr', null, inner]];
};

/** Chunk with no candidates (e.g. init/metadata chunk). */
const metaChunk = (convId?: string, respId?: string) => {
  const meta = convId || respId ? [convId ?? null, respId ?? null] : [null, respId ?? null];
  const inner = JSON.stringify([
    null,
    meta,
    { '18': respId, '44': false },
  ]);
  return [['wrb.fr', null, inner]];
};

describe('extractGeminiText', () => {
  it('extracts text from valid chunk', () => {
    expect(extractGeminiText(textChunk('Hello world'))).toBe('Hello world');
  });

  it('joins multiple text segments', () => {
    const inner = JSON.stringify([
      null, ['c1', 'r1'], null, null,
      [['rc_1', ['Hello', ' ', 'world']]],
    ]);
    const chunk = [['wrb.fr', null, inner]];
    expect(extractGeminiText(chunk)).toBe('Hello world');
  });

  it('returns null for invalid structure', () => {
    expect(extractGeminiText(null)).toBeNull();
    expect(extractGeminiText([])).toBeNull();
    expect(extractGeminiText([null])).toBeNull();
    expect(extractGeminiText('not an array')).toBeNull();
  });

  it('returns null for chunk with no candidates', () => {
    expect(extractGeminiText(metaChunk(undefined, 'r_123'))).toBeNull();
  });

  it('returns null for chunk with empty text array', () => {
    const inner = JSON.stringify([null, null, null, null, [['rc_1', []]]]);
    const chunk = [['wrb.fr', null, inner]];
    expect(extractGeminiText(chunk)).toBeNull();
  });

  it('returns null when inner is not a JSON string', () => {
    const chunk = [['wrb.fr', null, 12345]];
    expect(extractGeminiText(chunk)).toBeNull();
  });

  it('strips markdown auto-linked URLs', () => {
    expect(extractGeminiText(textChunk(
      'Visit [https://example.com](https://example.com) for details',
    ))).toBe('Visit https://example.com for details');
  });

  it('strips markdown URLs with Google redirect in link target', () => {
    expect(extractGeminiText(textChunk(
      '[https://news.ycombinator.com](https://www.google.com/search?q=https://news.ycombinator.com)',
    ))).toBe('https://news.ycombinator.com');
  });

  it('strips markdown URLs inside tool call JSON', () => {
    // Gemini text segments contain literal <> (after JSON unescape of \u003c/\u003e),
    // and the backslash-stripping regex handles \< → <. Here we test the markdown
    // stripping on text that already has literal angle brackets (post-JSON-parse).
    const text = '<tool_call id="open" name="browser">{"url":"[https://example.com](https://example.com)"}</tool_call>';
    expect(extractGeminiText(textChunk(text))).toBe(
      '<tool_call id="open" name="browser">{"url":"https://example.com"}</tool_call>',
    );
  });
});

describe('createGeminiStreamAdapter', () => {
  describe('cumulative text deduplication', () => {
    it('computes delta from cumulative text', () => {
      const adapter = createGeminiStreamAdapter();
      expect(adapter.processEvent({ parsed: textChunk('Hello'), delta: 'Hello' })).toEqual({
        feedText: 'Hello',
      });
      expect(adapter.processEvent({ parsed: textChunk('Hello world'), delta: 'Hello world' })).toEqual({
        feedText: ' world',
      });
      expect(adapter.processEvent({ parsed: textChunk('Hello world!'), delta: 'Hello world!' })).toEqual({
        feedText: '!',
      });
    });

    it('returns null when text has not grown', () => {
      const adapter = createGeminiStreamAdapter();
      adapter.processEvent({ parsed: textChunk('Hello'), delta: 'Hello' });
      // Same text again — no new delta
      expect(adapter.processEvent({ parsed: textChunk('Hello'), delta: 'Hello' })).toBeNull();
    });

    it('returns null for metadata chunks with no text', () => {
      const adapter = createGeminiStreamAdapter();
      expect(adapter.processEvent({ parsed: metaChunk(undefined, 'r_123'), delta: null })).toBeNull();
    });
  });

  describe('bare think prefix suppression', () => {
    it('suppresses bare "think\\n" prefix until <think> tag appears', () => {
      const adapter = createGeminiStreamAdapter();
      // First chunk: bare "think\n" reasoning (no XML tags)
      expect(adapter.processEvent({
        parsed: textChunk('think\nThe user said hi.\nI should greet them.'),
        delta: 'think\nThe user said hi.\nI should greet them.',
      })).toBeNull();
      // Second chunk: cumulative text now includes <think> tag
      expect(adapter.processEvent({
        parsed: textChunk('think\nThe user said hi.\nI should greet them.\n<think>\nGreeting user.\n</think>Hello!'),
        delta: 'think\nThe user said hi.\nI should greet them.\n<think>\nGreeting user.\n</think>Hello!',
      })).toEqual({
        feedText: '<think>\nGreeting user.\n</think>Hello!',
      });
    });

    it('resolves prefix when bare think leads directly to <tool_call> (no <think> tag)', () => {
      const adapter = createGeminiStreamAdapter();
      // Bare think prefix with reasoning — suppressed
      expect(adapter.processEvent({
        parsed: textChunk('think\nThe user is asking for weather.\nI should use web_search.'),
        delta: null,
      })).toBeNull();
      // More bare thinking + tool_call starts appearing (still no <think> tag)
      const fullText = 'think\nThe user is asking for weather.\nI should use web_search.\n<tool_call id="a1b2" name="web_search">{"query":"weather"}';
      const result = adapter.processEvent({
        parsed: textChunk(fullText),
        delta: null,
      });
      expect(result).toEqual({
        feedText: '<tool_call id="a1b2" name="web_search">{"query":"weather"}',
      });
    });

    it('resolves prefix when bare think leads directly to </tool_call> completion', () => {
      const adapter = createGeminiStreamAdapter();
      // Full bare think + complete tool call in one chunk
      const fullText = 'think\nReasoning here.\n<tool_call id="t1" name="search">{"q":"test"}</tool_call>';
      const result = adapter.processEvent({
        parsed: textChunk(fullText),
        delta: null,
      });
      expect(result).toEqual({
        feedText: '<tool_call id="t1" name="search">{"q":"test"}</tool_call>',
      });
      expect(adapter.shouldAbort()).toBe(false);
    });

    it('does not suppress text that does not start with "think\\n"', () => {
      const adapter = createGeminiStreamAdapter();
      expect(adapter.processEvent({
        parsed: textChunk('Hello world'),
        delta: 'Hello world',
      })).toEqual({ feedText: 'Hello world' });
    });

    it('suppresses partial "think" prefix until full "think\\n" is confirmed', () => {
      const adapter = createGeminiStreamAdapter();
      // First chunk: just "think" (no newline yet)
      expect(adapter.processEvent({
        parsed: textChunk('think'),
        delta: null,
      })).toBeNull();
      // Second chunk: grows to "think\n<think>" — bare prefix confirmed + XML tag found
      expect(adapter.processEvent({
        parsed: textChunk('think\n<think>\nreasoning\n</think>Hello'),
        delta: null,
      })).toEqual({ feedText: '<think>\nreasoning\n</think>Hello' });
    });

    it('suppresses partial "thi" prefix until resolved', () => {
      const adapter = createGeminiStreamAdapter();
      // Partial prefix that could grow into "think\n"
      expect(adapter.processEvent({
        parsed: textChunk('thi'),
        delta: null,
      })).toBeNull();
      // Grows into "think\n<tool_call...>"
      const fullText = 'think\n<tool_call id="t1" name="search">{"q":"x"}</tool_call>';
      expect(adapter.processEvent({
        parsed: textChunk(fullText),
        delta: null,
      })).toEqual({ feedText: '<tool_call id="t1" name="search">{"q":"x"}</tool_call>' });
    });

    it('emits immediately when partial prefix diverges from "think\\n"', () => {
      const adapter = createGeminiStreamAdapter();
      // "the" is NOT a prefix of "think\n" — emits immediately
      expect(adapter.processEvent({
        parsed: textChunk('the answer is 42'),
        delta: null,
      })).toEqual({ feedText: 'the answer is 42' });
    });

    it('resolves prefix for text starting with "t" followed by non-think content', () => {
      const adapter = createGeminiStreamAdapter();
      // "to" is not a prefix of "think\n"
      expect(adapter.processEvent({
        parsed: textChunk('to'),
        delta: null,
      })).toEqual({ feedText: 'to' });
    });

    it('emits cumulative deltas correctly after prefix is resolved', () => {
      const adapter = createGeminiStreamAdapter();
      // Bare think prefix — suppressed
      adapter.processEvent({
        parsed: textChunk('think\nreasoning here'),
        delta: 'think\nreasoning here',
      });
      // <think> tag appears
      adapter.processEvent({
        parsed: textChunk('think\nreasoning here\n<think>\nSummary\n</think>Hi'),
        delta: 'think\nreasoning here\n<think>\nSummary\n</think>Hi',
      });
      // More cumulative text
      expect(adapter.processEvent({
        parsed: textChunk('think\nreasoning here\n<think>\nSummary\n</think>Hi there!'),
        delta: 'think\nreasoning here\n<think>\nSummary\n</think>Hi there!',
      })).toEqual({ feedText: ' there!' });
    });
  });

  describe('markdown link stripping in cumulative text', () => {
    it('emits correct deltas when Gemini rewrites URLs between chunks', () => {
      const adapter = createGeminiStreamAdapter();

      // Chunk 1: tool_call opening
      expect(adapter.processEvent({
        parsed: textChunk('<tool_call id="o1" name="browser">{"url":"'),
        delta: null,
      })).toEqual({ feedText: '<tool_call id="o1" name="browser">{"url":"' });

      // Chunk 2: URL appears as markdown link with Google redirect (longer)
      // After stripping: bare URL is shorter, so cumulative text still grows
      expect(adapter.processEvent({
        parsed: textChunk('<tool_call id="o1" name="browser">{"url":"[https://news.ycombin](https://www.google.com/search?q=https://news.ycombin)'),
        delta: null,
      })).toEqual({ feedText: 'https://news.ycombin' });

      // Chunk 3: Gemini rewrites URL to direct link (shorter markdown, but
      // stripped URL is longer because domain is now complete) + closing tag
      expect(adapter.processEvent({
        parsed: textChunk('<tool_call id="o1" name="browser">{"url":"[https://news.ycombinator.com](https://news.ycombinator.com)"}</tool_call>'),
        delta: null,
      })).toEqual({ feedText: 'ator.com"}</tool_call>' });
    });
  });

  describe('edge cases', () => {
    it('returns null for invalid parsed data', () => {
      const adapter = createGeminiStreamAdapter();
      expect(adapter.processEvent({ parsed: null, delta: null })).toBeNull();
      expect(adapter.processEvent({ parsed: [], delta: null })).toBeNull();
      expect(adapter.processEvent({ parsed: 'not valid', delta: null })).toBeNull();
    });

    it('shouldAbort returns false when no tool call seen', () => {
      const adapter = createGeminiStreamAdapter();
      expect(adapter.shouldAbort()).toBe(false);
      adapter.processEvent({ parsed: textChunk('Hello'), delta: 'Hello' });
      expect(adapter.shouldAbort()).toBe(false);
    });

    it('shouldAbort always returns false (never abort early for Gemini)', () => {
      const adapter = createGeminiStreamAdapter();
      adapter.processEvent({
        parsed: textChunk('<tool_call id="a1" name="web_search">{"query":"test"}</tool_call>'),
        delta: '<tool_call id="a1" name="web_search">{"query":"test"}</tool_call>',
      });
      expect(adapter.shouldAbort()).toBe(false);
    });

    it('flush returns null (no state to flush)', () => {
      const adapter = createGeminiStreamAdapter();
      expect(adapter.flush()).toBeNull();
    });

    it('handles multiple chunks interleaved with metadata', () => {
      const adapter = createGeminiStreamAdapter();
      // Init metadata chunk
      expect(adapter.processEvent({ parsed: metaChunk(undefined, 'r_1'), delta: null })).toBeNull();
      // First text chunk
      expect(adapter.processEvent({ parsed: textChunk('Hello'), delta: 'Hello' })).toEqual({
        feedText: 'Hello',
      });
      // Another metadata chunk
      expect(adapter.processEvent({ parsed: metaChunk('c_1', 'r_1'), delta: null })).toBeNull();
      // Second text chunk (cumulative)
      expect(adapter.processEvent({ parsed: textChunk('Hello, Kyle.'), delta: 'Hello, Kyle.' })).toEqual({
        feedText: ', Kyle.',
      });
    });
  });

  describe('onFinish', () => {
    it('promotes thinking-only response to text', () => {
      const adapter = createGeminiStreamAdapter();
      const result = adapter.onFinish!({
        hasToolCalls: false,
        fullText: '',
        thinkingContent: 'This is the actual response.',
      });
      expect(result).toEqual({ promotedText: 'This is the actual response.' });
    });

    it('does not promote when text is already present', () => {
      const adapter = createGeminiStreamAdapter();
      const result = adapter.onFinish!({
        hasToolCalls: false,
        fullText: 'Some visible text.',
        thinkingContent: 'Some reasoning.',
      });
      expect(result).toBeNull();
    });

    it('does not promote when tool calls are present', () => {
      const adapter = createGeminiStreamAdapter();
      const result = adapter.onFinish!({
        hasToolCalls: true,
        fullText: '',
        thinkingContent: 'Reasoning before tool call.',
      });
      expect(result).toBeNull();
    });

    it('returns error on completely empty response', () => {
      const adapter = createGeminiStreamAdapter();
      const result = adapter.onFinish!({
        hasToolCalls: false,
        fullText: '',
        thinkingContent: undefined,
      });
      expect(result).toEqual({ error: 'Gemini returned an empty response' });
    });

    it('returns null when tool calls are present but no text', () => {
      const adapter = createGeminiStreamAdapter();
      const result = adapter.onFinish!({
        hasToolCalls: true,
        fullText: '',
        thinkingContent: undefined,
      });
      expect(result).toBeNull();
    });
  });

  describe('suppressAfterToolCalls', () => {
    it('is configured to suppress both text and malformed', () => {
      const adapter = createGeminiStreamAdapter();
      expect(adapter.suppressAfterToolCalls).toEqual({ text: true, malformed: true });
    });
  });
});
