import { sanitizeHistory } from './history-sanitization';
import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@extension/shared';

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'msg-1',
  chatId: 'chat-1',
  role: 'user',
  parts: [{ type: 'text', text: 'Hello' }],
  createdAt: Date.now(),
  ...overrides,
});

describe('sanitizeHistory — Anthropic', () => {
  it('prepends synthetic user message if first message is assistant', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'Hi there' }] }),
      makeMessage({ id: 'm2', role: 'user' }),
    ];
    const result = sanitizeHistory(messages, 'anthropic');
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.id).toBe('__synthetic_user');
    expect(result.length).toBe(3);
  });

  it('merges consecutive user messages into one', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Part 1' }] }),
      makeMessage({ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'Part 2' }] }),
      makeMessage({ id: 'm3', role: 'assistant', parts: [{ type: 'text', text: 'Response' }] }),
    ];
    const result = sanitizeHistory(messages, 'anthropic');
    // First two user messages should be merged
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.parts).toHaveLength(2);
    expect(result).toHaveLength(2);
  });

  it('merges consecutive assistant messages into one', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({ id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Part A' }] }),
      makeMessage({ id: 'm3', role: 'assistant', parts: [{ type: 'text', text: 'Part B' }] }),
    ];
    const result = sanitizeHistory(messages, 'anthropic');
    expect(result).toHaveLength(2);
    expect(result[1]!.role).toBe('assistant');
    expect(result[1]!.parts).toHaveLength(2);
  });

  it('repairs missing tool-result with synthetic error', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'web_search',
            args: { city: 'SF' },
          },
        ],
      }),
    ];
    const result = sanitizeHistory(messages, 'anthropic');
    const assistantMsg = result.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    const toolResult = assistantMsg!.parts.find(p => p.type === 'tool-result');
    expect(toolResult).toBeDefined();
    expect((toolResult as { toolCallId: string }).toolCallId).toBe('tc-1');
  });

  it('passes through valid history unchanged', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({ id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Hi!' }] }),
      makeMessage({ id: 'm3', role: 'user', parts: [{ type: 'text', text: 'Bye' }] }),
    ];
    const result = sanitizeHistory(messages, 'anthropic');
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe('m1');
    expect(result[1]!.id).toBe('m2');
    expect(result[2]!.id).toBe('m3');
  });

  it('does not add synthetic result when tool-call already has matching result', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'web_search',
            args: { city: 'SF' },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'web_search',
            result: { temp: 72 },
          },
        ],
      }),
    ];
    const result = sanitizeHistory(messages, 'anthropic');
    const assistantMsg = result.find(m => m.role === 'assistant');
    const toolResults = assistantMsg!.parts.filter(p => p.type === 'tool-result');
    // Should only have the original result, no synthetic one
    expect(toolResults).toHaveLength(1);
  });

  it('handles assistant message with no tool-calls', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({ id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Just text' }] }),
    ];
    const result = sanitizeHistory(messages, 'anthropic');
    expect(result).toHaveLength(2);
    expect(result[1]!.parts).toHaveLength(1);
  });

  it('handles empty messages array', () => {
    const result = sanitizeHistory([], 'anthropic');
    expect(result).toHaveLength(0);
  });
});

describe('sanitizeHistory — Google', () => {
  it('removes system messages from history', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'system', parts: [{ type: 'text', text: 'System prompt' }] }),
      makeMessage({ id: 'm2', role: 'user' }),
      makeMessage({ id: 'm3', role: 'assistant', parts: [{ type: 'text', text: 'Hi!' }] }),
    ];
    const result = sanitizeHistory(messages, 'google');
    expect(result.every(m => m.role !== 'system')).toBe(true);
  });

  it('enforces user/assistant alternation', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Q1' }] }),
      makeMessage({ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'Q2' }] }),
      makeMessage({ id: 'm3', role: 'assistant', parts: [{ type: 'text', text: 'A1' }] }),
    ];
    const result = sanitizeHistory(messages, 'google');
    // Consecutive user messages should be merged
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.role).not.toBe(result[i - 1]!.role);
    }
  });

  it('injects synthetic user message when first message after system removal is assistant', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'system', parts: [{ type: 'text', text: 'System prompt' }] }),
      makeMessage({ id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Hi!' }] }),
      makeMessage({ id: 'm3', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }),
    ];
    const result = sanitizeHistory(messages, 'google');
    // System removed → first msg is assistant → synthetic user prepended
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.id).toBe('__synthetic_user');
    // Assistant should follow
    expect(result[1]!.role).toBe('assistant');
  });

  it('repairs missing tool-result', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'search',
            args: { query: 'test' },
          },
        ],
      }),
    ];
    const result = sanitizeHistory(messages, 'google');
    const assistantMsg = result.find(m => m.role === 'assistant');
    const toolResult = assistantMsg!.parts.find(p => p.type === 'tool-result');
    expect(toolResult).toBeDefined();
  });

  it('passes through valid alternating history unchanged', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({ id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Response' }] }),
    ];
    const result = sanitizeHistory(messages, 'google');
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe('user');
    expect(result[1]!.role).toBe('assistant');
  });

  it('handles empty message list', () => {
    const result = sanitizeHistory([], 'google');
    expect(result).toHaveLength(0);
  });
});

describe('sanitizeHistory — OpenAI', () => {
  it('repairs missing tool-result', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'web_search',
            args: { city: 'NYC' },
          },
        ],
      }),
    ];
    const result = sanitizeHistory(messages, 'openai');
    const assistantMsg = result.find(m => m.role === 'assistant');
    const toolResult = assistantMsg!.parts.find(p => p.type === 'tool-result');
    expect(toolResult).toBeDefined();
    expect((toolResult as { toolCallId: string }).toolCallId).toBe('tc-1');
  });

  it('passes through history unchanged otherwise', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({ id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] }),
      makeMessage({ id: 'm3', role: 'user', parts: [{ type: 'text', text: 'Thanks' }] }),
    ];
    const result = sanitizeHistory(messages, 'openai');
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe('m1');
    expect(result[1]!.id).toBe('m2');
    expect(result[2]!.id).toBe('m3');
  });

  it('does not merge consecutive same-role messages (OpenAI allows them)', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Part 1' }] }),
      makeMessage({ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'Part 2' }] }),
      makeMessage({ id: 'm3', role: 'assistant', parts: [{ type: 'text', text: 'Reply' }] }),
    ];
    const result = sanitizeHistory(messages, 'openai');
    // OpenAI sanitizer only does tool-result pairing, not alternation enforcement
    expect(result).toHaveLength(3);
  });

  it('uses default (openai) sanitizer for openrouter provider', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'search',
            args: {},
          },
        ],
      }),
    ];
    const result = sanitizeHistory(messages, 'openrouter');
    const assistantMsg = result.find(m => m.role === 'assistant');
    const toolResult = assistantMsg!.parts.find(p => p.type === 'tool-result');
    expect(toolResult).toBeDefined();
  });

  it('uses default (openai) sanitizer for custom provider', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({ id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] }),
    ];
    const result = sanitizeHistory(messages, 'custom' as any);
    expect(result).toHaveLength(2);
  });
});

describe('sanitizeHistory — Web provider', () => {
  it('uses OpenAI sanitizer for web provider', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'web_search',
            args: { query: 'test' },
          },
        ],
      }),
    ];
    const result = sanitizeHistory(messages, 'web');
    const assistantMsg = result.find(m => m.role === 'assistant');
    const toolResult = assistantMsg!.parts.find(p => p.type === 'tool-result');
    expect(toolResult).toBeDefined();
    expect((toolResult as { toolCallId: string }).toolCallId).toBe('tc-1');
  });
});

describe('sanitizeHistory — tool-call with inline result (UI merge format)', () => {
  it('extracts inline result from tool-call part instead of injecting synthetic error', () => {
    const fetchResult = { text: 'Blog content about Stripe Minions...', status: 200 };
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'web_fetch',
            args: { url: 'https://example.com/blog' },
            result: fetchResult,
            state: 'output-available' as const,
          },
        ],
      }),
    ];
    const result = sanitizeHistory(messages, 'openai');
    const assistantMsg = result.find(m => m.role === 'assistant')!;
    const toolResult = assistantMsg.parts.find(p => p.type === 'tool-result');
    expect(toolResult).toBeDefined();
    expect((toolResult as { result: unknown }).result).toEqual(fetchResult);
  });

  it('extracts inline results from multiple tool-calls', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'web_fetch',
            args: { url: 'https://example.com/part1' },
            result: { text: 'Part 1 content', status: 200 },
            state: 'output-available' as const,
          },
          {
            type: 'tool-call',
            toolCallId: 'tc-2',
            toolName: 'web_fetch',
            args: { url: 'https://example.com/part2' },
            result: { text: 'Part 2 content', status: 200 },
            state: 'output-available' as const,
          },
        ],
      }),
    ];
    const result = sanitizeHistory(messages, 'openai');
    const assistantMsg = result.find(m => m.role === 'assistant')!;
    const toolResults = assistantMsg.parts.filter(p => p.type === 'tool-result');
    expect(toolResults).toHaveLength(2);
    expect((toolResults[0] as { toolCallId: string }).toolCallId).toBe('tc-1');
    expect((toolResults[0] as { result: unknown }).result).toEqual({
      text: 'Part 1 content',
      status: 200,
    });
    expect((toolResults[1] as { toolCallId: string }).toolCallId).toBe('tc-2');
    expect((toolResults[1] as { result: unknown }).result).toEqual({
      text: 'Part 2 content',
      status: 200,
    });
  });

  it('falls back to synthetic error when tool-call has no result', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'web_fetch',
            args: { url: 'https://example.com' },
          },
        ],
      }),
    ];
    const result = sanitizeHistory(messages, 'openai');
    const assistantMsg = result.find(m => m.role === 'assistant')!;
    const toolResult = assistantMsg.parts.find(p => p.type === 'tool-result');
    expect(toolResult).toBeDefined();
    expect((toolResult as { result: unknown }).result).toEqual({
      error: 'Tool execution was interrupted or unavailable.',
    });
  });

  it('handles mix of tool-calls with and without inline results', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'web_fetch',
            args: { url: 'https://example.com' },
            result: { text: 'Fetched content', status: 200 },
            state: 'output-available' as const,
          },
          {
            type: 'tool-call',
            toolCallId: 'tc-2',
            toolName: 'browser',
            args: { action: 'navigate' },
            // No result — was interrupted
          },
        ],
      }),
    ];
    const result = sanitizeHistory(messages, 'openai');
    const assistantMsg = result.find(m => m.role === 'assistant')!;
    const toolResults = assistantMsg.parts.filter(p => p.type === 'tool-result');
    expect(toolResults).toHaveLength(2);
    // First: extracted inline result
    expect((toolResults[0] as { result: unknown }).result).toEqual({
      text: 'Fetched content',
      status: 200,
    });
    // Second: synthetic error
    expect((toolResults[1] as { result: unknown }).result).toEqual({
      error: 'Tool execution was interrupted or unavailable.',
    });
  });

  it('does not duplicate result when separate tool-result already exists', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'web_fetch',
            args: { url: 'https://example.com' },
            result: { text: 'inline result' },
            state: 'output-available' as const,
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'web_fetch',
            result: { text: 'separate result' },
          },
        ],
      }),
    ];
    const result = sanitizeHistory(messages, 'openai');
    const assistantMsg = result.find(m => m.role === 'assistant')!;
    const toolResults = assistantMsg.parts.filter(p => p.type === 'tool-result');
    // Separate tool-result already exists — should not add another
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { result: unknown }).result).toEqual({ text: 'separate result' });
  });

  it('works across all providers (anthropic, google, openai)', () => {
    const makeTestMessages = (): ChatMessage[] => [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'web_fetch',
            args: { url: 'https://example.com' },
            result: { text: 'content' },
            state: 'output-available' as const,
          },
        ],
      }),
    ];

    for (const provider of ['openai', 'anthropic', 'google'] as const) {
      const result = sanitizeHistory(makeTestMessages(), provider);
      const assistantMsg = result.find(m => m.role === 'assistant')!;
      const toolResult = assistantMsg.parts.find(p => p.type === 'tool-result');
      expect(toolResult).toBeDefined();
      expect((toolResult as { result: unknown }).result).toEqual({ text: 'content' });
    }
  });
});
