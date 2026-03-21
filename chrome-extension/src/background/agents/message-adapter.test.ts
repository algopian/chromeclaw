/**
 * Tests for message-adapter.ts
 * Verifies conversion between extension ChatMessage[] and pi-mono Message[].
 */
import { describe, it, expect } from 'vitest';
import { chatMessagesToPiMessages, convertToLlm, makeConvertToLlm } from './message-adapter';
import type { ChatMessage, ChatModel } from '@extension/shared';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Message } from '@mariozechner/pi-ai';

// ── Helpers ──────────────────────────────────────────────

const now = Date.now();

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'msg-1',
  chatId: 'chat-1',
  role: 'user',
  parts: [{ type: 'text', text: 'Hello' }],
  createdAt: now,
  ...overrides,
});

// ── chatMessagesToPiMessages ─────────────────────────────

describe('chatMessagesToPiMessages', () => {
  it('converts a user message with text only to string content', () => {
    const messages = [makeMessage({ parts: [{ type: 'text', text: 'Hi there' }] })];
    const result = chatMessagesToPiMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.content).toBe('Hi there');
    expect(result[0]!.timestamp).toBe(now);
  });

  it('converts a user message with image file parts to image content array', () => {
    const messages = [
      makeMessage({
        parts: [
          {
            type: 'file',
            url: 'data:image/png;base64,abc123',
            filename: 'photo.png',
            mediaType: 'image/png',
          },
        ],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    expect(Array.isArray(result[0]!.content)).toBe(true);
    const content = result[0]!.content as Array<{ type: string; data?: string; mimeType?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('image');
    expect(content[0]!.data).toBe('data:image/png;base64,abc123');
    expect(content[0]!.mimeType).toBe('image/png');
  });

  it('converts a user message with mixed text and images', () => {
    const messages = [
      makeMessage({
        parts: [
          {
            type: 'file',
            url: 'data:image/jpeg;base64,xyz',
            filename: 'img.jpg',
            mediaType: 'image/jpeg',
          },
          { type: 'text', text: 'Describe this image' },
        ],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    expect(result).toHaveLength(1);
    const content = result[0]!.content as Array<{ type: string; text?: string; data?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]!.type).toBe('image');
    expect(content[1]!.type).toBe('text');
    expect(content[1]!.text).toBe('Describe this image');
  });

  it('uses fp.data when available instead of fp.url', () => {
    const messages = [
      makeMessage({
        parts: [
          {
            type: 'file',
            url: 'http://fallback.url',
            data: 'base64-data-content',
            mediaType: 'image/png',
          },
        ],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    const content = result[0]!.content as Array<{ type: string; data?: string }>;
    expect(content[0]!.data).toBe('base64-data-content');
  });

  it('returns empty string content for user message with no text parts', () => {
    const messages = [makeMessage({ parts: [] })];
    const result = chatMessagesToPiMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('');
  });

  it('skips system messages', () => {
    const messages = [
      makeMessage({ id: 's1', role: 'system', parts: [{ type: 'text', text: 'System prompt' }] }),
      makeMessage({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }),
    ];
    const result = chatMessagesToPiMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
  });

  it('converts assistant message with text part', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        model: 'gpt-4o',
        parts: [{ type: 'text', text: 'Hello from assistant' }],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('assistant');
    const msg = result[0] as {
      role: string;
      content: Array<{ type: string; text: string }>;
      model: string;
    };
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]!.type).toBe('text');
    expect(msg.content[0]!.text).toBe('Hello from assistant');
    expect(msg.model).toBe('gpt-4o');
  });

  it('converts assistant message with reasoning part to thinking', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [{ type: 'reasoning', text: 'Let me think...' }],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    expect(result).toHaveLength(1);
    const msg = result[0] as {
      content: Array<{ type: string; thinking?: string }>;
    };
    expect(msg.content[0]!.type).toBe('thinking');
    expect(msg.content[0]!.thinking).toBe('Let me think...');
  });

  it('converts assistant message with tool-call part', () => {
    const messages = [
      makeMessage({
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
    const result = chatMessagesToPiMessages(messages);

    expect(result).toHaveLength(1);
    const msg = result[0] as {
      content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }>;
    };
    expect(msg.content[0]!.type).toBe('toolCall');
    expect(msg.content[0]!.id).toBe('tc-1');
    expect(msg.content[0]!.name).toBe('web_search');
    expect(msg.content[0]!.arguments).toEqual({ city: 'SF' });
  });

  it('converts assistant tool-result parts to separate toolResult messages', () => {
    const messages = [
      makeMessage({
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
            state: 'output-available',
          },
        ],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    // Should produce an assistant message (with the toolCall) and a toolResult message
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe('assistant');
    expect(result[1]!.role).toBe('toolResult');

    const toolResult = result[1] as {
      role: string;
      toolCallId: string;
      toolName: string;
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(toolResult.toolCallId).toBe('tc-1');
    expect(toolResult.toolName).toBe('web_search');
    expect(toolResult.content[0]!.text).toBe('{"temp":72}');
    expect(toolResult.isError).toBe(false);
  });

  it('sets isError=true when tool-result state is output-error', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'search',
            args: { q: 'test' },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'search',
            result: 'Something went wrong',
            state: 'output-error',
          },
        ],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    const toolResult = result[1] as { isError: boolean };
    expect(toolResult.isError).toBe(true);
  });

  it('handles string tool-result without JSON.stringify wrapping', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'search',
            args: {},
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'search',
            result: 'plain string result',
          },
        ],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    const toolResult = result[1] as { content: Array<{ text: string }> };
    expect(toolResult.content[0]!.text).toBe('plain string result');
  });

  it('converts assistant message with mixed parts (text + tool-call + tool-result)', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        model: 'gpt-4o',
        parts: [
          { type: 'text', text: 'Let me look that up.' },
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'search',
            args: { query: 'weather' },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'search',
            result: { answer: 'Sunny' },
          },
        ],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    // One assistant message (text + toolCall) + one toolResult message
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe('assistant');

    const assistantContent = (result[0] as { content: Array<{ type: string }> }).content;
    expect(assistantContent).toHaveLength(2);
    expect(assistantContent[0]!.type).toBe('text');
    expect(assistantContent[1]!.type).toBe('toolCall');

    expect(result[1]!.role).toBe('toolResult');
  });

  it('does not push assistant message when content is empty', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'search',
            result: 'data',
          },
        ],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    // Only the toolResult message should be pushed; no empty assistant message
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('toolResult');
  });

  it('uses "unknown" model when assistant message has no model', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [{ type: 'text', text: 'response' }],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    expect((result[0] as { model: string }).model).toBe('unknown');
  });

  it('sets placeholder usage and stopReason on assistant messages', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello' }],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    const msg = result[0] as {
      usage: { input: number; output: number; totalTokens: number };
      stopReason: string;
      api: string;
      provider: string;
    };
    expect(msg.usage.input).toBe(0);
    expect(msg.usage.output).toBe(0);
    expect(msg.usage.totalTokens).toBe(0);
    expect(msg.stopReason).toBe('stop');
    expect(msg.api).toBe('openai-completions');
    expect(msg.provider).toBe('openai');
  });

  it('skips non-image file parts in user messages', () => {
    const messages = [
      makeMessage({
        parts: [
          {
            type: 'file',
            url: 'data:application/pdf;base64,abc',
            filename: 'doc.pdf',
            mediaType: 'application/pdf',
          },
          { type: 'text', text: 'Read this' },
        ],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    // File parts are present so the content is an array, but only text should be included
    const content = result[0]!.content as Array<{ type: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
  });

  it('handles multiple messages in sequence', () => {
    const messages = [
      makeMessage({
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
        createdAt: 1000,
      }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hi!' }],
        createdAt: 2000,
      }),
      makeMessage({
        id: 'u2',
        role: 'user',
        parts: [{ type: 'text', text: 'How are you?' }],
        createdAt: 3000,
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    expect(result).toHaveLength(3);
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.timestamp).toBe(1000);
    expect(result[1]!.role).toBe('assistant');
    expect(result[1]!.timestamp).toBe(2000);
    expect(result[2]!.role).toBe('user');
    expect(result[2]!.timestamp).toBe(3000);
  });

  it('returns empty array for empty input', () => {
    const result = chatMessagesToPiMessages([]);
    expect(result).toHaveLength(0);
  });
});

// ── convertToLlm ─────────────────────────────────────────

describe('convertToLlm', () => {
  it('keeps user, assistant, and toolResult messages', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'Hi', timestamp: now },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
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
        timestamp: now,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'search',
        content: [{ type: 'text', text: 'result' }],
        isError: false,
        timestamp: now,
      },
    ] as AgentMessage[];

    const result = convertToLlm(messages);
    expect(result).toHaveLength(3);
    expect(result[0]!.role).toBe('user');
    expect(result[1]!.role).toBe('assistant');
    expect(result[2]!.role).toBe('toolResult');
  });

  it('filters out non-LLM roles', () => {
    const messages = [
      { role: 'user', content: 'Hi', timestamp: now },
      { role: 'event', data: 'something' },
      { role: 'metadata', info: 'extra' },
    ] as unknown as AgentMessage[];

    const result = convertToLlm(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
  });

  it('returns empty array when no messages match', () => {
    const messages = [{ role: 'event', data: 'something' }] as unknown as AgentMessage[];

    const result = convertToLlm(messages);
    expect(result).toHaveLength(0);
  });
});

// ── Reasoning signature round-trip tests ─────────────────

describe('chatMessagesToPiMessages — reasoning signature', () => {
  it('passes thinkingSignature when reasoning part has signature', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'thinking...', signature: '{"id":"rs_abc","type":"reasoning"}' },
        ],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    expect(result).toHaveLength(1);
    const msg = result[0] as {
      content: Array<{ type: string; thinking?: string; thinkingSignature?: string }>;
    };
    expect(msg.content[0]!.type).toBe('thinking');
    expect(msg.content[0]!.thinking).toBe('thinking...');
    expect(msg.content[0]!.thinkingSignature).toBe('{"id":"rs_abc","type":"reasoning"}');
  });

  it('omits thinkingSignature when reasoning part has no signature', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [{ type: 'reasoning', text: 'thinking...' }],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    const msg = result[0] as {
      content: Array<{ type: string; thinking?: string; thinkingSignature?: string }>;
    };
    expect(msg.content[0]!.type).toBe('thinking');
    expect(msg.content[0]!.thinking).toBe('thinking...');
    expect(msg.content[0]!.thinkingSignature).toBeUndefined();
  });

  it('round-trips reasoning + tool-call with signature (simulates multi-turn replay)', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'Let me search...', signature: '{"id":"rs_123"}' },
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'web_search',
            args: { query: 'test' },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'web_search',
            result: 'search results',
          },
        ],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    // Assistant message with thinking + toolCall, then toolResult message
    expect(result).toHaveLength(2);
    const assistant = result[0] as {
      content: Array<{ type: string; thinking?: string; thinkingSignature?: string; id?: string }>;
    };
    expect(assistant.content[0]!.type).toBe('thinking');
    expect(assistant.content[0]!.thinkingSignature).toBe('{"id":"rs_123"}');
    expect(assistant.content[1]!.type).toBe('toolCall');
    expect(assistant.content[1]!.id).toBe('tc-1');
  });

  it('handles mixed reasoning parts — some with signature, some without', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'first thought', signature: '{"id":"rs_1"}' },
          { type: 'text', text: 'some text' },
          { type: 'reasoning', text: 'second thought' },
        ],
      }),
    ];
    const result = chatMessagesToPiMessages(messages);

    const msg = result[0] as {
      content: Array<{ type: string; thinking?: string; thinkingSignature?: string }>;
    };
    expect(msg.content[0]!.thinkingSignature).toBe('{"id":"rs_1"}');
    expect(msg.content[2]!.type).toBe('thinking');
    expect(msg.content[2]!.thinkingSignature).toBeUndefined();
  });
});

// ── Image block round-trip tests ─────────────────────────

describe('chatMessagesToPiMessages — image blocks in tool results', () => {
  it('reconstructs ImageContent from tool-image file parts', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-ss',
            toolName: 'browser',
            args: { action: 'screenshot', tabId: 1 },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-ss',
            toolName: 'browser',
            result: 'Screenshot captured (1200×800)',
          },
          {
            type: 'file',
            url: '',
            filename: 'tool-image-tc-ss-0.jpg',
            mediaType: 'image/jpeg',
            data: 'base64screenshotdata',
          },
        ],
      }),
    ];

    const result = chatMessagesToPiMessages(messages);

    // Should produce an assistant message + a toolResult message
    expect(result.length).toBe(2);
    const toolResult = result[1] as {
      role: string;
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    };
    expect(toolResult.role).toBe('toolResult');

    // Should have both text and image content
    expect(toolResult.content).toHaveLength(2);
    expect(toolResult.content[0]!.type).toBe('text');
    expect(toolResult.content[0]!.text).toContain('Screenshot captured');
    expect(toolResult.content[1]!.type).toBe('image');
    expect(toolResult.content[1]!.data).toBe('base64screenshotdata');
    expect(toolResult.content[1]!.mimeType).toBe('image/jpeg');
  });

  it('does not associate file parts with non-matching toolCallId', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'browser',
            args: { action: 'screenshot' },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'browser',
            result: 'Screenshot captured',
          },
          {
            type: 'file',
            url: '',
            filename: 'tool-image-tc-OTHER.jpg',
            mediaType: 'image/jpeg',
            data: 'somedata',
          },
        ],
      }),
    ];

    const result = chatMessagesToPiMessages(messages);
    const toolResult = result[1] as {
      content: Array<{ type: string }>;
    };
    // Only text content, no image (filename doesn't match toolCallId)
    expect(toolResult.content).toHaveLength(1);
    expect(toolResult.content[0]!.type).toBe('text');
  });

  it('handles tool results without any file parts', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'web_search',
            args: { query: 'test' },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'web_search',
            result: '{"results": []}',
          },
        ],
      }),
    ];

    const result = chatMessagesToPiMessages(messages);
    const toolResult = result[1] as {
      content: Array<{ type: string }>;
    };
    expect(toolResult.content).toHaveLength(1);
    expect(toolResult.content[0]!.type).toBe('text');
  });

  it('skips file parts without data', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'browser',
            args: { action: 'screenshot' },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'browser',
            result: 'Screenshot',
          },
          {
            type: 'file',
            url: '',
            filename: 'tool-image-tc-1.jpg',
            mediaType: 'image/jpeg',
            // no data field
          },
        ],
      }),
    ];

    const result = chatMessagesToPiMessages(messages);
    const toolResult = result[1] as {
      content: Array<{ type: string }>;
    };
    // Should only have text (file part has no data)
    expect(toolResult.content).toHaveLength(1);
  });
});

// ── makeConvertToLlm ─────────────────────────────────────

describe('makeConvertToLlm', () => {
  const makeModel = (overrides: Partial<ChatModel> = {}): ChatModel => ({
    id: 'test-model',
    name: 'Test Model',
    provider: 'openai',
    ...overrides,
  });

  const assistantUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  it('filters non-LLM roles AND applies transcript sanitization', () => {
    const messages = [
      { role: 'user', content: 'Hi', timestamp: now },
      { role: 'event', data: 'noise' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Hello' },
        ],
        api: 'openai-completions',
        provider: 'openai',
        model: 'gpt-4o',
        usage: assistantUsage,
        stopReason: 'stop',
        timestamp: now,
      },
    ] as unknown as AgentMessage[];

    const convert = makeConvertToLlm(makeModel({ provider: 'google' }));
    const result = convert(messages);

    // event message filtered, thinking blocks dropped
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe('user');
    expect(result[1]!.role).toBe('assistant');
    const content = (result[1] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
  });

  it('sanitizes OpenAI reasoning blocks for Responses API model', () => {
    const messages = [
      { role: 'user', content: 'Hi', timestamp: now },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'reasoning',
            thinkingSignature: '{"id":"rs_1","type":"reasoning"}',
          },
        ],
        api: 'openai-completions',
        provider: 'openai',
        model: 'gpt-4o',
        usage: assistantUsage,
        stopReason: 'stop',
        timestamp: now,
      },
    ] as unknown as AgentMessage[];

    const convert = makeConvertToLlm(makeModel({ api: 'openai-responses' }));
    const result = convert(messages);

    // Standalone reasoning dropped → entire assistant message dropped
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
  });

  it('preserves thinking blocks for Anthropic model', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'deep thought' },
          { type: 'text', text: 'answer' },
        ],
        api: 'openai-completions',
        provider: 'anthropic',
        model: 'claude-3',
        usage: assistantUsage,
        stopReason: 'stop',
        timestamp: now,
      },
    ] as unknown as AgentMessage[];

    const convert = makeConvertToLlm(makeModel({ provider: 'anthropic' }));
    const result = convert(messages);

    expect(result).toHaveLength(1);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(2);
    expect(content[0]!.type).toBe('thinking');
  });
});
