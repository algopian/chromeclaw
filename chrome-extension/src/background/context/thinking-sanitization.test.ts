import { describe, it, expect } from 'vitest';
import { dropThinkingBlocks } from './thinking-sanitization';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

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

const makeUser = (text = 'hello'): AgentMessage =>
  ({ role: 'user', content: text, timestamp: Date.now() }) as AgentMessage;

// ── dropThinkingBlocks ───────────────────────────────────

describe('dropThinkingBlocks', () => {
  it('strips thinking blocks and keeps text from assistant message', () => {
    const messages = [
      makeAssistant([
        { type: 'thinking', thinking: 'let me think' },
        { type: 'text', text: 'answer' },
      ]),
    ];
    const result = dropThinkingBlocks(messages);
    expect(result).toHaveLength(1);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
  });

  it('replaces with synthetic text block when only thinking remains', () => {
    const messages = [
      makeAssistant([
        { type: 'thinking', thinking: 'deep thought' },
      ]),
    ];
    const result = dropThinkingBlocks(messages);
    expect(result).toHaveLength(1);
    const content = (result[0] as { content: Array<{ type: string; text?: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
    expect(content[0]!.text).toBe('');
  });

  it('passes through non-assistant messages unchanged', () => {
    const user = makeUser('hi');
    const messages = [user];
    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages); // original reference
    expect(result[0]).toBe(user);
  });

  it('returns original array reference when no thinking blocks exist', () => {
    const messages = [
      makeAssistant([{ type: 'text', text: 'hello' }]),
      makeUser('hey'),
    ];
    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it('handles multiple messages with mixed thinking', () => {
    const user = makeUser('q1');
    const assistant1 = makeAssistant([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'a1' },
    ]);
    const assistant2 = makeAssistant([
      { type: 'text', text: 'a2' },
    ]);
    const messages = [user, assistant1, assistant2];
    const result = dropThinkingBlocks(messages);

    expect(result).not.toBe(messages); // changed
    expect(result).toHaveLength(3);

    const c1 = (result[1] as { content: Array<{ type: string }> }).content;
    expect(c1).toHaveLength(1);
    expect(c1[0]!.type).toBe('text');

    // assistant2 was unchanged, but array is new
    const c2 = (result[2] as { content: Array<{ type: string }> }).content;
    expect(c2).toHaveLength(1);
    expect(c2[0]!.type).toBe('text');
  });

  it('keeps toolCall blocks alongside thinking removal', () => {
    const messages = [
      makeAssistant([
        { type: 'thinking', thinking: 'planning' },
        { type: 'toolCall', id: 'tc-1', name: 'search', arguments: {} },
      ]),
    ];
    const result = dropThinkingBlocks(messages);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('toolCall');
  });
});
