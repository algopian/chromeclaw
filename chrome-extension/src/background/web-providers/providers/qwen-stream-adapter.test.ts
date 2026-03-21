/**
 * Tests for qwen-stream-adapter.ts — Qwen/DeepSeek SSE stream adapter.
 * Pure unit tests — no chrome mocking, no SSE streams needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createQwenStreamAdapter } from './qwen-stream-adapter';

// Mock crypto.randomUUID for deterministic tool IDs
vi.stubGlobal('crypto', { randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });

/** Helper to build a Qwen-style SSE payload. */
const makePayload = (opts: {
  phase?: string;
  content?: string;
  function_call?: { name: string; arguments: string };
  function_id?: string;
  role?: string;
}) => ({
  choices: [
    {
      delta: {
        ...(opts.phase !== undefined ? { phase: opts.phase } : {}),
        ...(opts.content !== undefined ? { content: opts.content } : {}),
        ...(opts.function_call ? { function_call: opts.function_call } : {}),
        ...(opts.function_id ? { function_id: opts.function_id } : {}),
        ...(opts.role ? { role: opts.role } : {}),
      },
    },
  ],
});

describe('createQwenStreamAdapter', () => {
  let adapter: ReturnType<typeof createQwenStreamAdapter>;

  beforeEach(() => {
    adapter = createQwenStreamAdapter();
  });

  describe('think phase transitions', () => {
    it('injects <think> when entering think phase', () => {
      const result = adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'reasoning...' }),
        delta: 'reasoning...',
      });
      expect(result).toEqual({ feedText: '<think>reasoning...' });
    });

    it('injects </think> when exiting think phase to answer', () => {
      // Enter think
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'hmm' }),
        delta: 'hmm',
      });
      // Exit to answer
      const result = adapter.processEvent({
        parsed: makePayload({ phase: 'answer', content: 'The answer is' }),
        delta: 'The answer is',
      });
      expect(result).toEqual({ feedText: '</think>The answer is' });
    });

    it('does not inject tags when phase stays the same', () => {
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'a' }),
        delta: 'a',
      });
      const result = adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'b' }),
        delta: 'b',
      });
      expect(result).toEqual({ feedText: 'b' });
    });
  });

  describe('empty delta with phase change', () => {
    it('injects </think> on empty delta transitioning from think', () => {
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'x' }),
        delta: 'x',
      });
      const result = adapter.processEvent({
        parsed: makePayload({ phase: 'answer' }),
        delta: null,
      });
      expect(result).toEqual({ feedText: '</think>' });
    });

    it('returns null for empty delta with no phase change', () => {
      const result = adapter.processEvent({
        parsed: makePayload({}),
        delta: null,
      });
      expect(result).toBeNull();
    });
  });

  describe('native function_call interception', () => {
    it('accumulates function_call and returns null', () => {
      const result = adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_search', arguments: '{"query":"test"}' },
        }),
        delta: null,
      });
      expect(result).toBeNull();
    });

    it('converts pending function_call to XML on function response', () => {
      // Accumulate function_call
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_search', arguments: '{"query":"test"}' },
        }),
        delta: null,
      });
      // Function response
      const result = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(result).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="web_search">{"query":"test"}</tool_call>',
      });
    });

    it('closes think block before injecting XML tool call', () => {
      // Enter think phase
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'let me search' }),
        delta: 'let me search',
      });
      // function_call arrives (still in think phase)
      adapter.processEvent({
        parsed: makePayload({
          phase: 'think',
          function_call: { name: 'web_search', arguments: '{"q":"x"}' },
        }),
        delta: null,
      });
      // Function response
      const result = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(result).toEqual({
        feedText: '</think><tool_call id="aaaaaaaa" name="web_search">{"q":"x"}</tool_call>',
      });
    });

    it('closes think block on function_call with phase change', () => {
      // Enter think
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'hmm' }),
        delta: 'hmm',
      });
      // function_call with phase change from think to something else
      const result = adapter.processEvent({
        parsed: makePayload({
          phase: 'function_call',
          function_call: { name: 'calc', arguments: '{}' },
        }),
        delta: null,
      });
      expect(result).toEqual({ feedText: '</think>' });
    });
  });

  describe('multi-round flow', () => {
    it('handles think → function_call → response → answer', () => {
      const results: Array<{ feedText: string } | null> = [];

      // Think phase
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think', content: 'I need to search' }),
          delta: 'I need to search',
        }),
      );

      // function_call
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'function_call',
            function_call: { name: 'search', arguments: '{"q":"weather"}' },
          }),
          delta: null,
        }),
      );

      // Function response
      results.push(
        adapter.processEvent({
          parsed: makePayload({ role: 'function' }),
          delta: null,
        }),
      );

      // Answer phase
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'answer', content: 'It is sunny' }),
          delta: 'It is sunny',
        }),
      );

      expect(results).toEqual([
        { feedText: '<think>I need to search' },
        { feedText: '</think>' }, // close think on phase change
        { feedText: '<tool_call id="aaaaaaaa" name="search">{"q":"weather"}</tool_call>' },
        { feedText: 'It is sunny' },
      ]);
    });
  });

  describe('flush', () => {
    it('closes open think block', () => {
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'still thinking' }),
        delta: 'still thinking',
      });
      expect(adapter.flush()).toEqual({ feedText: '</think>' });
    });

    it('returns null when no open think block', () => {
      expect(adapter.flush()).toBeNull();
    });

    it('returns null after think block already closed', () => {
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'x' }),
        delta: 'x',
      });
      adapter.processEvent({
        parsed: makePayload({ phase: 'answer', content: 'y' }),
        delta: 'y',
      });
      expect(adapter.flush()).toBeNull();
    });
  });

  describe('no-phase providers (pass-through)', () => {
    it('passes delta through when no phase field is present', () => {
      const result = adapter.processEvent({
        parsed: { choices: [{ delta: { content: 'hello' } }] },
        delta: 'hello',
      });
      expect(result).toEqual({ feedText: 'hello' });
    });
  });

  describe('malformed / edge-case payloads', () => {
    it('returns null for empty object with no delta', () => {
      const result = adapter.processEvent({ parsed: {}, delta: null });
      expect(result).toBeNull();
    });

    it('passes delta through when choices array is missing', () => {
      const result = adapter.processEvent({ parsed: {}, delta: 'text' });
      expect(result).toEqual({ feedText: 'text' });
    });

    it('passes delta through when choices array is empty', () => {
      const result = adapter.processEvent({
        parsed: { choices: [] },
        delta: 'text',
      });
      expect(result).toEqual({ feedText: 'text' });
    });

    it('passes delta through when delta field is missing from choice', () => {
      const result = adapter.processEvent({
        parsed: { choices: [{}] },
        delta: 'text',
      });
      expect(result).toEqual({ feedText: 'text' });
    });

    it('passes delta through when parsed is a primitive (non-object)', () => {
      const result = adapter.processEvent({ parsed: 'not-json-object', delta: 'text' });
      expect(result).toEqual({ feedText: 'text' });
    });
  });

  describe('re-entering think phase', () => {
    it('injects <think> when re-entering think from answer', () => {
      // Enter think
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'first thought' }),
        delta: 'first thought',
      });
      // Exit to answer
      adapter.processEvent({
        parsed: makePayload({ phase: 'answer', content: 'reply' }),
        delta: 'reply',
      });
      // Re-enter think
      const result = adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'second thought' }),
        delta: 'second thought',
      });
      expect(result).toEqual({ feedText: '<think>second thought' });
    });
  });

  describe('function_call edge cases', () => {
    it('function_call with no phase change returns null (no prefix)', () => {
      // No prior phase set — function_call arrives without phase field
      const result = adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'tool', arguments: '{}' },
        }),
        delta: null,
      });
      expect(result).toBeNull();
    });

    it('function_call with same phase as current returns null', () => {
      // Set phase to "function_call"
      adapter.processEvent({
        parsed: makePayload({ phase: 'function_call' }),
        delta: null,
      });
      // Another function_call with same phase
      const result = adapter.processEvent({
        parsed: makePayload({
          phase: 'function_call',
          function_call: { name: 'search', arguments: '{"q":"a"}' },
        }),
        delta: null,
      });
      expect(result).toBeNull();
    });

    it('later function_call without function_id overwrites earlier pending one', () => {
      // First function_call (no function_id — uses default key)
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'first_tool', arguments: '{"a":1}' },
        }),
        delta: null,
      });
      // Second function_call overwrites (same default key)
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'second_tool', arguments: '{"b":2}' },
        }),
        delta: null,
      });
      // Function response — should use second_tool
      const result = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(result).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="second_tool">{"b":2}</tool_call>',
      });
    });

    it('function response without pending function_call falls through', () => {
      // role=function but no prior function_call accumulated
      const result = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(result).toBeNull();
    });

    it('function response when not in think phase omits </think> prefix', () => {
      // Set phase to answer (not think)
      adapter.processEvent({
        parsed: makePayload({ phase: 'answer', content: 'x' }),
        delta: 'x',
      });
      // function_call
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'calc', arguments: '{"x":1}' },
        }),
        delta: null,
      });
      // Function response — no </think> prefix needed
      const result = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(result).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="calc">{"x":1}</tool_call>',
      });
    });

    it('clears pendingFunctionCall after conversion so next response falls through', () => {
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'tool', arguments: '{}' },
        }),
        delta: null,
      });
      // Convert
      adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      // Another function response — no pending call, should fall through
      const result = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(result).toBeNull();
    });
  });

  describe('empty delta phase transitions (non-think)', () => {
    it('returns null when empty delta transitions from non-think phase', () => {
      // Set phase to "answer"
      adapter.processEvent({
        parsed: makePayload({ phase: 'answer', content: 'x' }),
        delta: 'x',
      });
      // Phase changes to something else with empty delta — no </think> needed
      const result = adapter.processEvent({
        parsed: makePayload({ phase: 'done' }),
        delta: null,
      });
      expect(result).toBeNull();
    });

    it('returns null on empty delta when phase is same as current', () => {
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'x' }),
        delta: 'x',
      });
      const result = adapter.processEvent({
        parsed: makePayload({ phase: 'think' }),
        delta: null,
      });
      expect(result).toBeNull();
    });
  });

  describe('multi-round: think → answer → think → function_call → response → answer', () => {
    it('handles complex multi-round flow correctly', () => {
      const results: Array<{ feedText: string } | null> = [];

      // Round 1: think
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think', content: 'Let me think' }),
          delta: 'Let me think',
        }),
      );

      // Round 1: answer
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'answer', content: 'Actually...' }),
          delta: 'Actually...',
        }),
      );

      // Round 2: think again
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think', content: 'wait' }),
          delta: 'wait',
        }),
      );

      // Round 2: function_call (from think phase)
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'function_call',
            function_call: { name: 'web_search', arguments: '{"q":"info"}' },
          }),
          delta: null,
        }),
      );

      // Round 2: function response
      results.push(
        adapter.processEvent({
          parsed: makePayload({ role: 'function' }),
          delta: null,
        }),
      );

      // Round 2: answer
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'answer', content: 'Here it is' }),
          delta: 'Here it is',
        }),
      );

      expect(results).toEqual([
        { feedText: '<think>Let me think' },
        { feedText: '</think>Actually...' },
        { feedText: '<think>wait' },
        { feedText: '</think>' },
        { feedText: '<tool_call id="aaaaaaaa" name="web_search">{"q":"info"}</tool_call>' },
        { feedText: 'Here it is' },
      ]);
    });
  });

  describe('parallel function_calls with function_id', () => {
    it('matches function responses to correct pending calls by function_id', () => {
      // Two parallel function_calls with different function_ids
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_search', arguments: '{"q":"first"}' },
          function_id: 'call_aaa',
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_fetch', arguments: '{"url":"http://x"}' },
          function_id: 'call_bbb',
        }),
        delta: null,
      });

      // Response for first call (call_aaa)
      const result1 = adapter.processEvent({
        parsed: makePayload({ role: 'function', function_id: 'call_aaa' }),
        delta: null,
      });
      expect(result1).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="web_search">{"q":"first"}</tool_call>',
      });

      // Response for second call (call_bbb)
      const result2 = adapter.processEvent({
        parsed: makePayload({ role: 'function', function_id: 'call_bbb' }),
        delta: null,
      });
      expect(result2).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="web_fetch">{"url":"http://x"}</tool_call>',
      });
    });

    it('suppresses "Tool X does not exists" text from unmatched function responses', () => {
      // Only one function_call registered
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_search', arguments: '{"q":"test"}' },
          function_id: 'call_aaa',
        }),
        delta: null,
      });

      // Consume it
      adapter.processEvent({
        parsed: makePayload({ role: 'function', function_id: 'call_aaa' }),
        delta: null,
      });

      // Second function response with no matching pending call
      // — this is the bug scenario where "Tool web_fetch does not exists" would leak
      const result = adapter.processEvent({
        parsed: makePayload({ role: 'function', function_id: 'call_bbb' }),
        delta: 'Tool web_fetch does not exists.',
      });
      expect(result).toBeNull();
    });

    it('handles incremental argument streaming with same function_id', () => {
      // Qwen streams args incrementally — each event has full accumulated args
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_search', arguments: '' },
          function_id: 'call_aaa',
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_search', arguments: '{"query": "edge' },
          function_id: 'call_aaa',
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_search', arguments: '{"query": "edgejs browser"}' },
          function_id: 'call_aaa',
        }),
        delta: null,
      });

      // Response — should use final accumulated args
      const result = adapter.processEvent({
        parsed: makePayload({ role: 'function', function_id: 'call_aaa' }),
        delta: null,
      });
      expect(result).toEqual({
        feedText:
          '<tool_call id="aaaaaaaa" name="web_search">{"query": "edgejs browser"}</tool_call>',
      });
    });

    it('handles two parallel searches where both get responses', () => {
      // This reproduces the exact Qwen pattern from the bug log
      const results: Array<{ feedText: string } | null> = [];

      // Think phase
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think', content: 'Let me search' }),
          delta: 'Let me search',
        }),
      );

      // Think finished, first search starts
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'web_search',
            function_call: { name: 'web_search', arguments: '{"query":"edgejs browser"}' },
            function_id: 'round_0_call_aaa',
          }),
          delta: null,
        }),
      );

      // Second search starts (parallel)
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'web_search',
            function_call: { name: 'web_search', arguments: '{"query":"wasmer sdk tutorial"}' },
            function_id: 'round_0_call_bbb',
          }),
          delta: null,
        }),
      );

      // Response for first search
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            role: 'function',
            phase: 'web_search',
            function_id: 'round_0_call_aaa',
          }),
          delta: null,
        }),
      );

      // Response for second search
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            role: 'function',
            phase: 'web_search',
            function_id: 'round_0_call_bbb',
          }),
          delta: null,
        }),
      );

      expect(results).toEqual([
        { feedText: '<think>Let me search' },
        { feedText: '</think>' }, // close think on phase change to web_search
        null, // second call same phase, no prefix
        {
          feedText:
            '<tool_call id="aaaaaaaa" name="web_search">{"query":"edgejs browser"}</tool_call>',
        },
        {
          feedText:
            '<tool_call id="aaaaaaaa" name="web_search">{"query":"wasmer sdk tutorial"}</tool_call>',
        },
      ]);
    });

    it('function response with non-empty error content is suppressed when no pending match', () => {
      // Qwen's "Tool X does not exists." response has content in the delta
      // that parseSseDelta would extract. The adapter must suppress it.
      const result = adapter.processEvent({
        parsed: makePayload({
          role: 'function',
          content: 'Tool browser does not exists.',
          function_id: 'call_unknown',
        }),
        delta: 'Tool browser does not exists.',
      });
      expect(result).toBeNull();
    });
  });

  describe('REGRESSION: sequential no-function_id calls (6x read overwrite)', () => {
    // Qwen sends 6 sequential `read` function_calls without function_id.
    // Each new call resets arguments to "". Without the queue fix, only the
    // last call survives — the other 5 are silently lost.

    it('queues completed calls when a new call resets arguments to empty', () => {
      // Simulate 3 sequential read calls without function_id
      // Call 1: read SOUL.md — args stream incrementally
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '' },
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '{"path": "SOUL.md"}' },
        }),
        delta: null,
      });

      // Call 2 starts: args reset to "" — this triggers queueing of call 1
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '' },
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '{"path": "MEMORY.md"}' },
        }),
        delta: null,
      });

      // Call 3 starts: args reset to "" — queues call 2
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '' },
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '{"path": "USER.md"}' },
        }),
        delta: null,
      });

      // 3 function responses arrive — should dequeue in FIFO order
      const r1 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: 'Tool read does not exists.',
      });
      expect(r1).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="read">{"path": "SOUL.md"}</tool_call>',
      });

      const r2 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: 'Tool read does not exists.',
      });
      expect(r2).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="read">{"path": "MEMORY.md"}</tool_call>',
      });

      // Third response consumes the in-progress pending entry (not queued)
      const r3 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: 'Tool read does not exists.',
      });
      expect(r3).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="read">{"path": "USER.md"}</tool_call>',
      });
    });

    it('reproduces: 6 sequential read calls without function_id from log', () => {
      const files = ['SOUL.md', 'MEMORY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'IDENTITY.md'];

      // Simulate 6 calls, each streaming args from "" to final
      for (const file of files) {
        adapter.processEvent({
          parsed: makePayload({
            phase: 'answer',
            function_call: { name: 'read', arguments: '' },
          }),
          delta: null,
        });
        adapter.processEvent({
          parsed: makePayload({
            phase: 'answer',
            function_call: { name: 'read', arguments: `{"path": "${file}"}` },
          }),
          delta: null,
        });
      }

      // 6 function responses arrive — all should produce tool_calls in order
      const results: Array<{ feedText: string } | null> = [];
      for (let i = 0; i < 6; i++) {
        results.push(
          adapter.processEvent({
            parsed: makePayload({ role: 'function' }),
            delta: 'Tool read does not exists.',
          }),
        );
      }

      // All 6 should produce correct tool_calls in order
      for (let i = 0; i < files.length; i++) {
        expect(results[i]).toEqual({
          feedText: `<tool_call id="aaaaaaaa" name="read">{"path": "${files[i]}"}</tool_call>`,
        });
      }
    });

    it('does not queue when first call starts with empty args (initial accumulation)', () => {
      // Very first call starts with empty args — no existing entry to queue
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '' },
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '{"path": "X.md"}' },
        }),
        delta: null,
      });

      // Single response — should use the pending entry directly
      const r = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(r).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="read">{"path": "X.md"}</tool_call>',
      });
    });

    it('queue is not used for calls with function_id', () => {
      // Calls with function_id should not interact with the default queue
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '{"path": "A.md"}' },
          function_id: 'call_a',
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '{"path": "B.md"}' },
          function_id: 'call_b',
        }),
        delta: null,
      });

      // Responses by function_id — should match correctly
      const r1 = adapter.processEvent({
        parsed: makePayload({ role: 'function', function_id: 'call_b' }),
        delta: null,
      });
      expect(r1).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="read">{"path": "B.md"}</tool_call>',
      });
      const r2 = adapter.processEvent({
        parsed: makePayload({ role: 'function', function_id: 'call_a' }),
        delta: null,
      });
      expect(r2).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="read">{"path": "A.md"}</tool_call>',
      });
    });

    it('extra responses after queue and pending are exhausted are suppressed', () => {
      // One call, queue empty
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '{"path": "X.md"}' },
        }),
        delta: null,
      });
      // Consume it
      adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      // Extra response — no pending, no queue → suppressed
      const r = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: 'Tool read does not exists.',
      });
      expect(r).toBeNull();
    });
  });

  describe('REGRESSION: parallel function_call text leak (bug-codex)', () => {
    // These tests reproduce the exact patterns from the production bug log
    // where "Tool web_fetch does not exists." leaked into visible text output.

    it('suppresses error text when function response arrives with non-empty delta but no pending match', () => {
      // This is the core regression: role="function" with content="Tool web_fetch does not exists."
      // and no matching pending call should NOT emit the error as visible text.
      const result = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: 'Tool web_fetch does not exists.',
      });
      expect(result).toBeNull();
    });

    it('reproduces: think → search(aaa) → search(bbb) → response(aaa) → response(bbb) with both converted', () => {
      // From the log: Qwen fires two web_search calls with different function_ids,
      // then both responses arrive. Previously the second response had no pending
      // match and its content leaked as text.
      const results: Array<{ feedText: string } | null> = [];

      // Think
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think', content: 'Let me search' }),
          delta: 'Let me search',
        }),
      );
      // Think finished
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think' }),
          delta: null,
        }),
      );

      // First search call — args stream incrementally
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'web_search',
            function_call: { name: 'web_search', arguments: '' },
            function_id: 'round_0_call_840bf70d',
          }),
          delta: null,
        }),
      );
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'web_search',
            function_call: {
              name: 'web_search',
              arguments: '{"query": "edgejs wasmerio GitHub how to use browser"}',
            },
            function_id: 'round_0_call_840bf70d',
          }),
          delta: null,
        }),
      );

      // Second search call starts (parallel, different function_id)
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'web_search',
            function_call: { name: 'web_search', arguments: '' },
            function_id: 'round_0_call_19500797',
          }),
          delta: null,
        }),
      );
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'web_search',
            function_call: {
              name: 'web_search',
              arguments: '{"query": "Wasmer JS SDK @wasmer/sdk browser example tutorial"}',
            },
            function_id: 'round_0_call_19500797',
          }),
          delta: null,
        }),
      );

      // Response for first search (role=function, empty content)
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            role: 'function',
            phase: 'web_search',
            function_id: 'round_0_call_840bf70d',
          }),
          delta: null,
        }),
      );

      // Response for second search (role=function, empty content)
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            role: 'function',
            phase: 'web_search',
            function_id: 'round_0_call_19500797',
          }),
          delta: null,
        }),
      );

      // Both searches should produce tool_calls, not text leaks
      expect(results).toEqual([
        { feedText: '<think>Let me search' },
        null, // think phase same, empty delta
        { feedText: '</think>' }, // phase change think → web_search
        null, // same function_id, just updating args
        null, // second call, same phase
        null, // same function_id, just updating args
        {
          feedText:
            '<tool_call id="aaaaaaaa" name="web_search">{"query": "edgejs wasmerio GitHub how to use browser"}</tool_call>',
        },
        {
          feedText:
            '<tool_call id="aaaaaaaa" name="web_search">{"query": "Wasmer JS SDK @wasmer/sdk browser example tutorial"}</tool_call>',
        },
      ]);
    });

    it('reproduces: native browser call fails then think resumes without text leak', () => {
      // From the log: Qwen calls native "browser" tool → gets "Tool browser does not exists."
      // → then continues thinking. The error must not appear as text.
      const results: Array<{ feedText: string } | null> = [];

      // Think
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think', content: 'Let me use browser' }),
          delta: 'Let me use browser',
        }),
      );
      // Think finished
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think' }),
          delta: null,
        }),
      );

      // function_call for "browser" (phase changes to "answer")
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'answer',
            function_call: {
              name: 'browser',
              arguments: '{"action": "open", "url": "https://github.com/wasmerio/edgejs"}',
            },
            function_id: 'call_browser_1',
          }),
          delta: null,
        }),
      );

      // Function response with error content
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            role: 'function',
            content: 'Tool browser does not exists.',
            phase: 'answer',
            function_id: 'call_browser_1',
          }),
          delta: 'Tool browser does not exists.',
        }),
      );

      // Think resumes after the failed tool
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think', content: 'browser tool unavailable' }),
          delta: 'browser tool unavailable',
        }),
      );

      expect(results).toEqual([
        { feedText: '<think>Let me use browser' },
        null,
        { feedText: '</think>' }, // think → answer phase change
        {
          feedText:
            '<tool_call id="aaaaaaaa" name="browser">{"action": "open", "url": "https://github.com/wasmerio/edgejs"}</tool_call>',
        },
        { feedText: '<think>browser tool unavailable' },
      ]);
    });

    it('reproduces: three parallel tools — search succeeds, browser and fetch fail', () => {
      // Qwen fires three native tools in parallel. search has a real Qwen
      // implementation, but browser and fetch don't.
      const results: Array<{ feedText: string } | null> = [];

      // Three parallel function_calls
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_search', arguments: '{"q":"test"}' },
          function_id: 'call_search',
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'browser', arguments: '{"action":"open"}' },
          function_id: 'call_browser',
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_fetch', arguments: '{"url":"http://x"}' },
          function_id: 'call_fetch',
        }),
        delta: null,
      });

      // Responses arrive (possibly out of order)
      results.push(
        adapter.processEvent({
          parsed: makePayload({ role: 'function', function_id: 'call_browser' }),
          delta: 'Tool browser does not exists.',
        }),
      );
      results.push(
        adapter.processEvent({
          parsed: makePayload({ role: 'function', function_id: 'call_search' }),
          delta: null,
        }),
      );
      results.push(
        adapter.processEvent({
          parsed: makePayload({ role: 'function', function_id: 'call_fetch' }),
          delta: 'Tool web_fetch does not exists.',
        }),
      );

      // All three should produce tool_calls, none should leak error text
      expect(results).toEqual([
        {
          feedText:
            '<tool_call id="aaaaaaaa" name="browser">{"action":"open"}</tool_call>',
        },
        {
          feedText: '<tool_call id="aaaaaaaa" name="web_search">{"q":"test"}</tool_call>',
        },
        {
          feedText:
            '<tool_call id="aaaaaaaa" name="web_fetch">{"url":"http://x"}</tool_call>',
        },
      ]);
    });

    it('does not leak text when function response has role=function but parseSseDelta returns error string', () => {
      // The exact mechanism of the original bug: parseSseDelta extracts
      // content="Tool web_fetch does not exists." as delta, but since
      // role="function" the adapter must intercept it, NOT pass to text output.
      // With no pending call, it must return null.
      const result = adapter.processEvent({
        parsed: makePayload({
          role: 'function',
          content: 'Tool web_fetch does not exists.',
        }),
        delta: 'Tool web_fetch does not exists.',
      });
      expect(result).toBeNull();
    });

    it('mixed function_ids and no-id calls do not interfere', () => {
      // A call with function_id and a call without should not collide
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_search', arguments: '{"q":"a"}' },
          function_id: 'call_aaa',
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_fetch', arguments: '{"url":"b"}' },
          // no function_id — uses default key
        }),
        delta: null,
      });

      // Response for the no-id call (default key)
      const r1 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(r1).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="web_fetch">{"url":"b"}</tool_call>',
      });

      // Response for the id-ed call
      const r2 = adapter.processEvent({
        parsed: makePayload({ role: 'function', function_id: 'call_aaa' }),
        delta: null,
      });
      expect(r2).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="web_search">{"q":"a"}</tool_call>',
      });
    });

    it('subsequent text delta after suppressed function response is emitted normally', () => {
      // After the adapter suppresses an unmatched function response,
      // the next normal text delta must still pass through.
      adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: 'Tool X does not exists.',
      });

      const result = adapter.processEvent({
        parsed: makePayload({ phase: 'answer', content: 'Here is the answer' }),
        delta: 'Here is the answer',
      });
      expect(result).toEqual({ feedText: 'Here is the answer' });
    });
  });

  describe('REGRESSION: multi-round no-fn_id tool calls from log (list→read×6→memory_search→browser)', () => {
    // Reproduces the exact pattern from 18:21 production log where Qwen
    // makes multiple tool-calling rounds, each without function_id, separated
    // by think phases. The sequential queue must work correctly across rounds.

    it('reproduces: think → list → fail → think → read×6 → fail×6 → think → answer', () => {
      const results: Array<{ feedText: string } | null> = [];

      // --- Round 0: Think ---
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think', content: 'Let me list files' }),
          delta: 'Let me list files',
        }),
      );

      // --- Round 1: single `list` call (no fn_id) ---
      // think → answer phase change with function_call
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'answer',
            function_call: { name: 'list', arguments: '' },
          }),
          delta: null,
        }),
      );
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'answer',
            function_call: { name: 'list', arguments: '{}' },
          }),
          delta: null,
        }),
      );
      // list response
      results.push(
        adapter.processEvent({
          parsed: makePayload({ role: 'function' }),
          delta: 'Tool list does not exists.',
        }),
      );

      // --- Think again ---
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think', content: 'list unavailable, try read' }),
          delta: 'list unavailable, try read',
        }),
      );

      // --- Round 2: 6 sequential `read` calls (no fn_id) ---
      // think → answer phase change with first read
      const files = ['SOUL.md', 'MEMORY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'IDENTITY.md'];
      for (let i = 0; i < files.length; i++) {
        results.push(
          adapter.processEvent({
            parsed: makePayload({
              phase: 'answer',
              function_call: { name: 'read', arguments: '' },
            }),
            delta: null,
          }),
        );
        results.push(
          adapter.processEvent({
            parsed: makePayload({
              phase: 'answer',
              function_call: { name: 'read', arguments: `{"path": "${files[i]}"}` },
            }),
            delta: null,
          }),
        );
      }

      // 6 read responses — first from log has "Tool read does not exists."
      for (let i = 0; i < 6; i++) {
        results.push(
          adapter.processEvent({
            parsed: makePayload({ role: 'function' }),
            delta: 'Tool read does not exists.',
          }),
        );
      }

      // --- Think again ---
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think', content: 'read also unavailable' }),
          delta: 'read also unavailable',
        }),
      );

      // --- Round 3: single `memory_search` call (no fn_id) ---
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'answer',
            function_call: { name: 'memory_search', arguments: '' },
          }),
          delta: null,
        }),
      );
      results.push(
        adapter.processEvent({
          parsed: makePayload({
            phase: 'answer',
            function_call: { name: 'memory_search', arguments: '{"query": "all files"}' },
          }),
          delta: null,
        }),
      );
      results.push(
        adapter.processEvent({
          parsed: makePayload({ role: 'function' }),
          delta: 'Tool memory_search does not exists.',
        }),
      );

      // --- Think again ---
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'think', content: 'giving up on tools' }),
          delta: 'giving up on tools',
        }),
      );

      // --- Final answer ---
      results.push(
        adapter.processEvent({
          parsed: makePayload({ phase: 'answer', content: 'Here are the files' }),
          delta: 'Here are the files',
        }),
      );

      // Verify key assertions:
      // 1. list tool_call produced
      expect(results[3]).toEqual({
        feedText: '<tool_call id="aaaaaaaa" name="list">{}</tool_call>',
      });

      // 2. All 6 read tool_calls produced in order
      const readResults = results.filter(
        r => r !== null && r.feedText.includes('name="read"'),
      );
      expect(readResults).toHaveLength(6);
      for (let i = 0; i < files.length; i++) {
        expect(readResults[i]).toEqual({
          feedText: `<tool_call id="aaaaaaaa" name="read">{"path": "${files[i]}"}</tool_call>`,
        });
      }

      // 3. memory_search tool_call produced
      const memoryResults = results.filter(
        r => r !== null && r.feedText.includes('name="memory_search"'),
      );
      expect(memoryResults).toHaveLength(1);
      expect(memoryResults[0]).toEqual({
        feedText:
          '<tool_call id="aaaaaaaa" name="memory_search">{"query": "all files"}</tool_call>',
      });

      // 4. No "Tool X does not exists" text leaked into output
      const allText = results
        .filter((r): r is { feedText: string } => r !== null)
        .map(r => r.feedText)
        .join('');
      expect(allText).not.toContain('does not exists');

      // 5. Final answer arrived
      const last = results[results.length - 1];
      expect(last).toEqual({ feedText: '</think>Here are the files' });
    });

    it('handles duplicate "Tool X does not exists" responses for unmatched reads', () => {
      // From the log: after the last read is converted, 5 more
      // "Tool read does not exists." responses arrive with the same content.
      // All must be suppressed.

      // Single read call
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '{"path": "X.md"}' },
        }),
        delta: null,
      });

      // Consume it
      adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: 'Tool read does not exists.',
      });

      // 5 duplicate responses — all suppressed
      for (let i = 0; i < 5; i++) {
        const r = adapter.processEvent({
          parsed: makePayload({ role: 'function' }),
          delta: 'Tool read does not exists.',
        });
        expect(r).toBeNull();
      }
    });

    it('queue drains correctly then falls back to pending entry for last response', () => {
      // 3 calls queued (2 in queue + 1 pending), then exactly 3 responses
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'read', arguments: '' } }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'read', arguments: '{"path":"A"}' } }),
        delta: null,
      });
      // Second call — queues A
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'read', arguments: '' } }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'read', arguments: '{"path":"B"}' } }),
        delta: null,
      });
      // Third call — queues B
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'read', arguments: '' } }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'read', arguments: '{"path":"C"}' } }),
        delta: null,
      });

      // Response 1: dequeues A (from queue)
      const r1 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(r1!.feedText).toContain('"path":"A"');

      // Response 2: dequeues B (from queue)
      const r2 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(r2!.feedText).toContain('"path":"B"');

      // Response 3: uses pending entry C (queue empty, falls to map)
      const r3 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(r3!.feedText).toContain('"path":"C"');

      // Response 4: nothing left → suppressed
      const r4 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: 'Tool read does not exists.',
      });
      expect(r4).toBeNull();
    });

    it('queue resets naturally between tool rounds separated by think phases', () => {
      // Round 1: single call, single response → drains completely
      adapter.processEvent({
        parsed: makePayload({
          phase: 'answer',
          function_call: { name: 'list', arguments: '{}' },
        }),
        delta: null,
      });
      const r1 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(r1!.feedText).toContain('name="list"');

      // Think interlude
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'trying read next' }),
        delta: 'trying read next',
      });

      // Round 2: two sequential calls, two responses
      adapter.processEvent({
        parsed: makePayload({
          phase: 'answer',
          function_call: { name: 'read', arguments: '' },
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          phase: 'answer',
          function_call: { name: 'read', arguments: '{"path":"A.md"}' },
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          phase: 'answer',
          function_call: { name: 'read', arguments: '' },
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          phase: 'answer',
          function_call: { name: 'read', arguments: '{"path":"B.md"}' },
        }),
        delta: null,
      });

      const r2 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(r2!.feedText).toContain('"path":"A.md"');

      const r3 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(r3!.feedText).toContain('"path":"B.md"');
    });

    it('sequential calls with different tool names are queued correctly', () => {
      // list, then read, then memory_search — all without function_id
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'list', arguments: '' } }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'list', arguments: '{}' } }),
        delta: null,
      });
      // read starts — queues list
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'read', arguments: '' } }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'read', arguments: '{"path":"X"}' } }),
        delta: null,
      });
      // memory_search starts — queues read
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'memory_search', arguments: '' } }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'memory_search', arguments: '{"query":"all"}' },
        }),
        delta: null,
      });

      // 3 responses — FIFO: list, read, memory_search
      const r1 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(r1!.feedText).toContain('name="list"');

      const r2 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(r2!.feedText).toContain('name="read"');

      const r3 = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(r3!.feedText).toContain('name="memory_search"');
    });

    it('does not queue when non-empty args overwrite non-empty args (mid-stream update)', () => {
      // When args go from non-empty to different non-empty (normal incremental
      // streaming within one call), do NOT queue — just overwrite.
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '{"pat' },
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '{"path": "SOUL.md"}' },
        }),
        delta: null,
      });

      // Only one response needed — no spurious queue entry
      const r = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: null,
      });
      expect(r!.feedText).toContain('SOUL.md');

      // No leftover in queue
      const extra = adapter.processEvent({
        parsed: makePayload({ role: 'function' }),
        delta: 'leftover',
      });
      expect(extra).toBeNull();
    });
  });

  describe('shouldAbort — native tool failure detection', () => {
    it('returns false initially', () => {
      expect(adapter.shouldAbort()).toBe(false);
    });

    it('returns false after normal text and thinking', () => {
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'thinking' }),
        delta: 'thinking',
      });
      adapter.processEvent({
        parsed: makePayload({ phase: 'answer', content: 'answer' }),
        delta: 'answer',
      });
      expect(adapter.shouldAbort()).toBe(false);
    });

    it('returns true after "Tool X does not exists" in function response content', () => {
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'list', arguments: '{}' },
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({ role: 'function', content: 'Tool list does not exists.' }),
        delta: 'Tool list does not exists.',
      });
      expect(adapter.shouldAbort()).toBe(true);
    });

    it('returns true for case-insensitive match (e.g. "Does Not Exist")', () => {
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'list', arguments: '{}' },
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({ role: 'function', content: 'Tool list Does Not Exist.' }),
        delta: 'Tool list Does Not Exist.',
      });
      expect(adapter.shouldAbort()).toBe(true);
    });

    it('returns false when function response has no "does not exist" content', () => {
      // Qwen's own web_search — tool_result in extra, empty content
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'web_search', arguments: '{"q":"test"}' },
          function_id: 'call_aaa',
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({ role: 'function', content: '', function_id: 'call_aaa' }),
        delta: null,
      });
      expect(adapter.shouldAbort()).toBe(false);
    });

    it('stays true once set (latched)', () => {
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'browser', arguments: '{}' },
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({ role: 'function', content: 'Tool browser does not exists.' }),
        delta: 'Tool browser does not exists.',
      });
      expect(adapter.shouldAbort()).toBe(true);

      // Process more events — should still be true
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'continuing' }),
        delta: 'continuing',
      });
      expect(adapter.shouldAbort()).toBe(true);
    });

    it('returns false for unmatched function response (no pending call)', () => {
      // Unmatched response — suppressed, but no tool was actually converted
      adapter.processEvent({
        parsed: makePayload({ role: 'function', content: 'Tool X does not exists.' }),
        delta: 'Tool X does not exists.',
      });
      // No pending call was matched, so nativeToolFailed should NOT be set
      expect(adapter.shouldAbort()).toBe(false);
    });

    it('detects failure across sequential no-fn_id calls', () => {
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'read', arguments: '' } }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '{"path": "SOUL.md"}' },
        }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({ function_call: { name: 'read', arguments: '' } }),
        delta: null,
      });
      adapter.processEvent({
        parsed: makePayload({
          function_call: { name: 'read', arguments: '{"path": "MEMORY.md"}' },
        }),
        delta: null,
      });

      // Not aborted yet — no responses received
      expect(adapter.shouldAbort()).toBe(false);

      // First response with "does not exist"
      adapter.processEvent({
        parsed: makePayload({ role: 'function', content: 'Tool read does not exists.' }),
        delta: 'Tool read does not exists.',
      });
      expect(adapter.shouldAbort()).toBe(true);
    });
  });

  describe('flush after function_call state', () => {
    it('returns null when last phase was function_call (not think)', () => {
      adapter.processEvent({
        parsed: makePayload({
          phase: 'function_call',
          function_call: { name: 'tool', arguments: '{}' },
        }),
        delta: null,
      });
      expect(adapter.flush()).toBeNull();
    });

    it('flush is idempotent — second call returns null', () => {
      adapter.processEvent({
        parsed: makePayload({ phase: 'think', content: 'x' }),
        delta: 'x',
      });
      expect(adapter.flush()).toEqual({ feedText: '</think>' });
      expect(adapter.flush()).toBeNull();
    });
  });
});
