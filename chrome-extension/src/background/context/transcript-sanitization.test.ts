import { describe, it, expect } from 'vitest';
import { sanitizeTranscript } from './transcript-sanitization';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ChatModel } from '@extension/shared';

// ── Helpers ──────────────────────────────────────────────

const makeAssistant = (content: Array<Record<string, unknown>>): AgentMessage =>
  ({
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt-4o',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }) as AgentMessage;

const makeModel = (overrides: Partial<ChatModel> = {}): ChatModel => ({
  id: 'test-model',
  name: 'Test Model',
  provider: 'openai',
  ...overrides,
});

const thinkingBlock = { type: 'thinking', thinking: 'hmm' };
const thinkingWithSig = {
  type: 'thinking',
  thinking: 'hmm',
  thinkingSignature: '{"id":"rs_1","type":"reasoning"}',
};
const textBlock = { type: 'text', text: 'answer' };

// ── sanitizeTranscript ───────────────────────────────────

describe('sanitizeTranscript', () => {
  it('applies Gap 1+2 for OpenAI Responses API model', () => {
    const messages = [
      makeAssistant([
        thinkingWithSig, // standalone reasoning at end → should be dropped
      ]),
    ];
    const model = makeModel({ api: 'openai-responses' });
    const result = sanitizeTranscript(messages, model);
    // Standalone reasoning dropped → empty message dropped entirely
    expect(result).toHaveLength(0);
  });

  it('applies Gap 1+2 for OpenAI Codex Responses API model', () => {
    const messages = [
      makeAssistant([thinkingWithSig]),
    ];
    const model = makeModel({ api: 'openai-codex-responses' });
    const result = sanitizeTranscript(messages, model);
    expect(result).toHaveLength(0);
  });

  it('keeps thinking with following text for Responses API', () => {
    const messages = [
      makeAssistant([thinkingWithSig, textBlock]),
    ];
    const model = makeModel({ api: 'openai-responses' });
    const result = sanitizeTranscript(messages, model);
    expect(result).toHaveLength(1);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(2);
    expect(content[0]!.type).toBe('thinking');
  });

  it('returns messages unchanged for Anthropic provider', () => {
    const messages = [
      makeAssistant([thinkingBlock, textBlock]),
    ];
    const model = makeModel({ provider: 'anthropic' });
    const result = sanitizeTranscript(messages, model);
    expect(result).toBe(messages);
  });

  it('drops thinking blocks for Google provider', () => {
    const messages = [
      makeAssistant([thinkingBlock, textBlock]),
    ];
    const model = makeModel({ provider: 'google' });
    const result = sanitizeTranscript(messages, model);
    expect(result).toHaveLength(1);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
  });

  it('drops thinking blocks for OpenRouter provider', () => {
    const messages = [
      makeAssistant([thinkingBlock, textBlock]),
    ];
    const model = makeModel({ provider: 'openrouter' });
    const result = sanitizeTranscript(messages, model);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
  });

  it('drops thinking blocks for custom provider', () => {
    const messages = [
      makeAssistant([thinkingBlock, textBlock]),
    ];
    const model = makeModel({ provider: 'custom' });
    const result = sanitizeTranscript(messages, model);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
  });

  it('drops thinking blocks for local provider', () => {
    const messages = [
      makeAssistant([thinkingBlock, textBlock]),
    ];
    const model = makeModel({ provider: 'local' });
    const result = sanitizeTranscript(messages, model);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
  });

  it('drops thinking blocks for OpenAI completions API', () => {
    const messages = [
      makeAssistant([thinkingBlock, textBlock]),
    ];
    const model = makeModel({ provider: 'openai', api: 'openai-completions' });
    const result = sanitizeTranscript(messages, model);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
  });

  it('no-ops when there are no thinking blocks', () => {
    const messages = [
      makeAssistant([textBlock]),
    ];
    const model = makeModel({ provider: 'google' });
    const result = sanitizeTranscript(messages, model);
    // dropThinkingBlocks returns original ref when nothing changed
    expect(result).toBe(messages);
  });
});
