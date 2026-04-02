/**
 * Tests for sse-stream-adapter.ts — adapter interface, default adapter, and factory routing.
 */
import { describe, it, expect, vi } from 'vitest';
import { createDefaultAdapter, getSseStreamAdapter } from './sse-stream-adapter';
import type { WebProviderId } from './types';

// Mock crypto.randomUUID (needed by qwen adapter returned from factory)
vi.stubGlobal('crypto', { randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });

describe('createDefaultAdapter', () => {
  it('returns feedText when delta is present', () => {
    const adapter = createDefaultAdapter();
    const result = adapter.processEvent({ parsed: {}, delta: 'hello' });
    expect(result).toEqual({ feedText: 'hello' });
  });

  it('returns null when delta is null', () => {
    const adapter = createDefaultAdapter();
    const result = adapter.processEvent({ parsed: {}, delta: null });
    expect(result).toBeNull();
  });

  it('returns null when delta is empty string', () => {
    const adapter = createDefaultAdapter();
    const result = adapter.processEvent({ parsed: {}, delta: '' });
    expect(result).toBeNull();
  });

  it('ignores parsed data entirely', () => {
    const adapter = createDefaultAdapter();
    const result = adapter.processEvent({
      parsed: { choices: [{ delta: { phase: 'think', content: 'ignored' } }] },
      delta: 'actual delta',
    });
    expect(result).toEqual({ feedText: 'actual delta' });
  });

  it('flush always returns null', () => {
    const adapter = createDefaultAdapter();
    expect(adapter.flush()).toBeNull();
    // Still null after processing events
    adapter.processEvent({ parsed: {}, delta: 'some text' });
    expect(adapter.flush()).toBeNull();
  });

  it('shouldAbort always returns false', () => {
    const adapter = createDefaultAdapter();
    expect(adapter.shouldAbort()).toBe(false);
    adapter.processEvent({ parsed: {}, delta: 'text' });
    expect(adapter.shouldAbort()).toBe(false);
  });
});

describe('getSseStreamAdapter', () => {
  it('returns a Qwen adapter for qwen-web', () => {
    const adapter = getSseStreamAdapter('qwen-web');
    // Qwen adapter injects <think> on think phase — default adapter would not
    const result = adapter.processEvent({
      parsed: { choices: [{ delta: { phase: 'think', content: 'hmm' } }] },
      delta: 'hmm',
    });
    expect(result).toEqual({ feedText: '<think>hmm' });
  });

  it('returns a Qwen adapter for qwen-cn-web', () => {
    const adapter = getSseStreamAdapter('qwen-cn-web');
    const result = adapter.processEvent({
      parsed: { choices: [{ delta: { phase: 'think', content: 'x' } }] },
      delta: 'x',
    });
    expect(result).toEqual({ feedText: '<think>x' });
  });

  it('returns a GLM adapter for glm-web', () => {
    const adapter = getSseStreamAdapter('glm-web');
    // GLM adapter throws on error frames — default adapter would not
    expect(() =>
      adapter.processEvent({
        parsed: { error: { message: 'GLM error' } },
        delta: null,
      }),
    ).toThrow('GLM error');
  });

  it('returns a GLM Intl adapter for glm-intl-web', () => {
    const adapter = getSseStreamAdapter('glm-intl-web');
    // GLM Intl adapter handles phase-based thinking/answer — wraps thinking in <think>
    const result = adapter.processEvent({
      parsed: { type: 'chat:completion', data: { delta_content: 'hello', phase: 'answer' } },
      delta: null,
    });
    expect(result).toEqual({ feedText: 'hello' });
  });

  it('returns a DeepSeek adapter for deepseek-web', () => {
    const adapter = getSseStreamAdapter('deepseek-web');
    // DeepSeek adapter handles JSON-patch style — wraps reasoning in <think>
    const result = adapter.processEvent({
      parsed: { p: ['reasoning'], v: 'hmm' },
      delta: null,
    });
    expect(result).toEqual({ feedText: '<think>hmm' });
  });

  it('returns a Claude adapter for claude-web', () => {
    const adapter = getSseStreamAdapter('claude-web');
    // Claude adapter extracts text from content_block_delta
    const result = adapter.processEvent({
      parsed: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
      delta: null,
    });
    expect(result).toEqual({ feedText: 'hello' });
  });

  it('returns a Gemini adapter for gemini-web', () => {
    const adapter = getSseStreamAdapter('gemini-web');
    const chunk = (text: string) => {
      const inner = JSON.stringify([null, ['c1', 'r1'], null, null, [['rc_1', [text]]]]);
      return [['wrb.fr', null, inner]];
    };
    expect(adapter.processEvent({ parsed: chunk('Hello'), delta: null })).toEqual({
      feedText: 'Hello',
    });
    expect(adapter.processEvent({ parsed: chunk('Hello world'), delta: null })).toEqual({
      feedText: ' world',
    });
  });

  it('returns a Rakuten adapter for rakuten-web', () => {
    const adapter = getSseStreamAdapter('rakuten-web');
    // Rakuten adapter handles typed conversation events with SUMMARY_TEXT thinking
    const result = adapter.processEvent({
      parsed: {
        type: 'rakuten:conversation',
        data: {
          chatResponseStatus: 'APPEND',
          contents: [{ contentType: 'SUMMARY_TEXT', textData: { text: 'thinking...' } }],
        },
      },
      delta: null,
    });
    expect(result).toEqual({ feedText: '<think>thinking...' });
  });

  it('returns independent adapter instances per call', () => {
    const a = getSseStreamAdapter('qwen-web');
    const b = getSseStreamAdapter('qwen-web');
    // Mutate state in `a`
    a.processEvent({
      parsed: { choices: [{ delta: { phase: 'think', content: 'x' } }] },
      delta: 'x',
    });
    // `b` should not be affected
    expect(b.flush()).toBeNull();
    expect(a.flush()).toEqual({ feedText: '</think>' });
  });
});
