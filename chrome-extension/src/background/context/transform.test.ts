/**
 * Tests for context-transform.ts — createTransformContext
 * Verifies compaction pipeline and result reporting.
 * Note: Memory flush logic was moved to memory-flush.ts — see memory-flush.test.ts.
 */
import { compactMessagesWithSummary } from './compaction';
import { createTransformContext } from './transform';
import { updateCompactionSummary, incrementCompactionCount, updateCompactionMetadata, getAgent } from '@extension/storage';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatModel, ChatMessage } from '@extension/shared';

// Import after mocks

// ── Mocks ────────────────────────────────────────────────

vi.mock('./compaction', () => ({
  compactMessagesWithSummary: vi.fn(),
  estimateMessageTokens: vi.fn(() => 100),
}));

vi.mock('../agents/message-adapter', () => ({
  chatMessagesToPiMessages: vi.fn((msgs: ChatMessage[]) =>
    msgs.map(m => ({
      role: m.role,
      content:
        m.role === 'user'
          ? (m.parts[0] as { type: 'text'; text: string })?.text || ''
          : (m.parts?.map((p: unknown) => ({
              type: 'text',
              text: (p as { text?: string }).text,
            })) ?? []),
      timestamp: m.createdAt,
      ...(m.role === 'assistant'
        ? {
            api: 'openai-completions',
            provider: 'openai',
            model: 'test',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
          }
        : {}),
    })),
  ),
}));

vi.mock('../logging/logger-buffer', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('@extension/storage', () => ({
  updateCompactionSummary: vi.fn(async () => {}),
  incrementCompactionCount: vi.fn(async () => {}),
  updateCompactionMetadata: vi.fn(async () => {}),
  getChat: vi.fn(async () => null),
  getAgent: vi.fn(async () => undefined),
  getEnabledWorkspaceFiles: vi.fn(async () => []),
}));

vi.mock('./tool-result-context-guard', () => ({
  enforceToolResultBudget: vi.fn((msgs: ChatMessage[]) => msgs),
}));

vi.mock('./summarizer', () => ({
  extractCriticalRules: vi.fn(() => undefined),
}));

// ── Test fixtures ────────────────────────────────────────

const mockModelConfig: ChatModel = {
  id: 'gpt-4o',
  name: 'GPT-4o',
  provider: 'openai',
  routingMode: 'direct',
};

const makeAgentUserMessage = (text: string, ts?: number) => ({
  role: 'user' as const,
  content: text,
  timestamp: ts ?? Date.now(),
});

const makeAgentAssistantMessage = (text: string, ts?: number) => ({
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text }],
  api: 'openai-completions' as const,
  provider: 'openai' as const,
  model: 'gpt-4o',
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop' as const,
  timestamp: ts ?? Date.now(),
});

const defaultOpts = {
  chatId: 'chat-1',
  modelConfig: mockModelConfig,
  systemPromptTokens: 500,
};

// ── Tests ────────────────────────────────────────────────

describe('createTransformContext', () => {
  const mockCompact = vi.mocked(compactMessagesWithSummary);
  const mockUpdateSummary = vi.mocked(updateCompactionSummary);
  const mockIncrementCount = vi.mocked(incrementCompactionCount);

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no compaction needed
    mockCompact.mockResolvedValue({
      messages: [],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });
  });

  it('returns messages unchanged when no compaction needed', async () => {
    const messages = [makeAgentUserMessage('Hello'), makeAgentAssistantMessage('Hi there!')];

    // compactMessagesWithSummary returns the same messages (unchanged)
    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
          createdAt: Date.now(),
        },
        {
          id: 'msg-2',
          chatId: 'chat-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Hi there!' }],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    const result = await transformContext(messages);

    // Should return the converted messages (via chatMessagesToPiMessages mock)
    expect(result).toHaveLength(2);
    expect(mockCompact).toHaveBeenCalledOnce();
  });

  it('getResult() returns { wasCompacted: false } when no compaction', async () => {
    const messages = [makeAgentUserMessage('Hello')];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext, getResult } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const result = getResult();
    expect(result.wasCompacted).toBe(false);
  });

  it('getResult() returns { wasCompacted: true, compactionMethod: "summary" } after compaction', async () => {
    const messages = [
      makeAgentUserMessage('Hello'),
      makeAgentAssistantMessage('Response'),
      makeAgentUserMessage('Follow-up'),
    ];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: true,
      compactionMethod: 'summary',
      summary: 'User greeted the assistant.',
    });

    const { transformContext, getResult } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const result = getResult();
    expect(result.wasCompacted).toBe(true);
    expect(result.compactionMethod).toBe('summary');
  });

  it('calls updateCompactionSummary when summary is returned', async () => {
    const messages = [makeAgentUserMessage('Hello')];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: true,
      compactionMethod: 'summary',
      summary: 'Conversation summary text.',
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    // updateCompactionSummary is fire-and-forget (.catch), so we need to flush
    await vi.waitFor(() => {
      expect(mockUpdateSummary).toHaveBeenCalledWith('chat-1', 'Conversation summary text.');
    });
  });

  it('calls incrementCompactionCount when wasCompacted is true', async () => {
    const messages = [makeAgentUserMessage('Hello')];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: true,
      compactionMethod: 'sliding-window',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    await vi.waitFor(() => {
      expect(mockIncrementCount).toHaveBeenCalledWith('chat-1');
    });
  });

  // ── agentMessagesToChatMessages conversion tests ──
  // These test the message conversion indirectly via transformContext

  it('converts user message with string content to text part', async () => {
    const messages = [makeAgentUserMessage('Hello string')];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello string' }],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    const result = await transformContext(messages);

    // compactMessagesWithSummary receives the converted ChatMessage[]
    const chatMessages = mockCompact.mock.calls[0][0];
    expect(chatMessages[0].role).toBe('user');
    expect(chatMessages[0].parts).toEqual([{ type: 'text', text: 'Hello string' }]);

    // Verify the return value flows through chatMessagesToPiMessages mock
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('converts user message with array content (text parts)', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'Part 1' },
          { type: 'text' as const, text: 'Part 2' },
        ],
        timestamp: Date.now(),
      },
    ];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'user',
          parts: [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: 'Part 2' },
          ],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const chatMessages = mockCompact.mock.calls[0][0];
    expect(chatMessages[0].parts).toHaveLength(2);
    expect(chatMessages[0].parts[0]).toEqual({ type: 'text', text: 'Part 1' });
    expect(chatMessages[0].parts[1]).toEqual({ type: 'text', text: 'Part 2' });
  });

  it('converts user message with image content to file part', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'image' as const,
            data: 'base64data',
            mimeType: 'image/png',
          },
        ],
        timestamp: Date.now(),
      },
    ];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'user',
          parts: [{ type: 'file', url: 'base64data', filename: 'image', mediaType: 'image/png' }],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const chatMessages = mockCompact.mock.calls[0][0];
    expect(chatMessages[0].parts[0]).toEqual(
      expect.objectContaining({
        type: 'file',
        url: 'base64data',
        filename: 'image',
        mediaType: 'image/png',
      }),
    );
  });

  it('converts assistant message with text content', async () => {
    const messages = [makeAgentAssistantMessage('Hello from assistant')];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Hello from assistant' }],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const chatMessages = mockCompact.mock.calls[0][0];
    expect(chatMessages[0].role).toBe('assistant');
    expect(chatMessages[0].parts[0]).toEqual({ type: 'text', text: 'Hello from assistant' });
  });

  it('converts assistant message with thinking content to reasoning part', async () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'thinking' as const, thinking: 'Let me think...' }],
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'gpt-4o',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      },
    ];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'assistant',
          parts: [{ type: 'reasoning', text: 'Let me think...' }],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const chatMessages = mockCompact.mock.calls[0][0];
    expect(chatMessages[0].parts[0]).toEqual({ type: 'reasoning', text: 'Let me think...' });
  });

  it('converts assistant message with toolCall content to tool-call part', async () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'toolCall' as const,
            id: 'tc-1',
            name: 'get_weather',
            arguments: { city: 'SF' },
          },
        ],
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'gpt-4o',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      },
    ];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-call',
              toolCallId: 'tc-1',
              toolName: 'get_weather',
              args: { city: 'SF' },
              state: 'output-available',
            },
          ],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const chatMessages = mockCompact.mock.calls[0][0];
    expect(chatMessages[0].parts[0]).toEqual(
      expect.objectContaining({
        type: 'tool-call',
        toolCallId: 'tc-1',
        toolName: 'get_weather',
        args: { city: 'SF' },
        state: 'output-available',
      }),
    );
  });

  it('converts toolResult message — merges into last assistant parts', async () => {
    const ts = Date.now();
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'toolCall' as const,
            id: 'tc-1',
            name: 'get_weather',
            arguments: { city: 'SF' },
          },
        ],
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'gpt-4o',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: ts,
      },
      {
        role: 'toolResult' as const,
        toolCallId: 'tc-1',
        toolName: 'get_weather',
        content: [{ type: 'text' as const, text: '{"temp": 72}' }],
        isError: false,
        timestamp: ts + 1,
      },
    ];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-call',
              toolCallId: 'tc-1',
              toolName: 'get_weather',
              args: { city: 'SF' },
              state: 'output-available',
            },
            {
              type: 'tool-result',
              toolCallId: 'tc-1',
              toolName: 'get_weather',
              result: { temp: 72 },
              state: 'output-available',
            },
          ],
          createdAt: ts,
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const chatMessages = mockCompact.mock.calls[0][0];
    // Tool result should be merged into the assistant message
    const assistantMsg = chatMessages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    const toolResult = assistantMsg!.parts.find(
      (p: { type: string }) => p.type === 'tool-result',
    ) as { type: string; result: unknown; state: string } | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult!.result).toEqual({ temp: 72 });
    expect(toolResult!.state).toBe('output-available');
  });

  it('converts toolResult with non-JSON text as raw string', async () => {
    const ts = Date.now();
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'toolCall' as const,
            id: 'tc-2',
            name: 'search',
            arguments: { q: 'test' },
          },
        ],
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'gpt-4o',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: ts,
      },
      {
        role: 'toolResult' as const,
        toolCallId: 'tc-2',
        toolName: 'search',
        content: [{ type: 'text' as const, text: 'Not valid JSON' }],
        isError: false,
        timestamp: ts + 1,
      },
    ];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-call',
              toolCallId: 'tc-2',
              toolName: 'search',
              args: { q: 'test' },
              state: 'output-available',
            },
            {
              type: 'tool-result',
              toolCallId: 'tc-2',
              toolName: 'search',
              result: 'Not valid JSON',
              state: 'output-available',
            },
          ],
          createdAt: ts,
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const chatMessages = mockCompact.mock.calls[0][0];
    const assistantMsg = chatMessages.find((m: { role: string }) => m.role === 'assistant');
    const toolResult = assistantMsg!.parts.find(
      (p: { type: string }) => p.type === 'tool-result',
    ) as { type: string; result: unknown; state: string } | undefined;
    expect(toolResult!.result).toBe('Not valid JSON');
  });

  it('converts toolResult with isError=true to output-error state', async () => {
    const ts = Date.now();
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'toolCall' as const,
            id: 'tc-3',
            name: 'failing_tool',
            arguments: {},
          },
        ],
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'gpt-4o',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: ts,
      },
      {
        role: 'toolResult' as const,
        toolCallId: 'tc-3',
        toolName: 'failing_tool',
        content: [{ type: 'text' as const, text: 'Tool failed' }],
        isError: true,
        timestamp: ts + 1,
      },
    ];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-call',
              toolCallId: 'tc-3',
              toolName: 'failing_tool',
              args: {},
              state: 'output-available',
            },
            {
              type: 'tool-result',
              toolCallId: 'tc-3',
              toolName: 'failing_tool',
              result: 'Tool failed',
              state: 'output-error',
            },
          ],
          createdAt: ts,
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const chatMessages = mockCompact.mock.calls[0][0];
    const assistantMsg = chatMessages.find((m: { role: string }) => m.role === 'assistant');
    const toolResult = assistantMsg!.parts.find(
      (p: { type: string }) => p.type === 'tool-result',
    ) as { type: string; result: unknown; state: string } | undefined;
    expect(toolResult!.state).toBe('output-error');
  });

  it('converts toolResult with ImageContent to file parts', async () => {
    const ts = Date.now();
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'toolCall' as const,
            id: 'tc-ss',
            name: 'browser',
            arguments: { action: 'screenshot', tabId: 1 },
          },
        ],
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'gpt-4o',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: ts,
      },
      {
        role: 'toolResult' as const,
        toolCallId: 'tc-ss',
        toolName: 'browser',
        content: [
          { type: 'text' as const, text: 'Screenshot captured (1200×800)' },
          { type: 'image' as const, data: 'base64screenshotdata', mimeType: 'image/jpeg' },
        ],
        isError: false,
        timestamp: ts + 1,
      },
    ];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-call',
              toolCallId: 'tc-ss',
              toolName: 'browser',
              args: { action: 'screenshot', tabId: 1 },
              state: 'output-available',
            },
            {
              type: 'tool-result',
              toolCallId: 'tc-ss',
              toolName: 'browser',
              result: 'Screenshot captured (1200×800)',
              state: 'output-available',
            },
            {
              type: 'file',
              url: '',
              filename: 'tool-image-tc-ss-0.jpg',
              mediaType: 'image/jpeg',
              data: 'base64screenshotdata',
            },
          ],
          createdAt: ts,
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const chatMessages = mockCompact.mock.calls[0][0];
    const assistantMsg = chatMessages.find((m: { role: string }) => m.role === 'assistant');

    // Should have tool-call, tool-result, AND file parts
    const fileParts = assistantMsg!.parts.filter(
      (p: { type: string }) => p.type === 'file',
    ) as Array<{ type: string; filename: string; mediaType: string; data: string }>;
    expect(fileParts).toHaveLength(1);
    expect(fileParts[0]!.filename).toBe('tool-image-tc-ss-0.jpg');
    expect(fileParts[0]!.mediaType).toBe('image/jpeg');
    expect(fileParts[0]!.data).toBe('base64screenshotdata');
  });
});

// ── thinkingSignature preservation ──

describe('createTransformContext — thinkingSignature preservation', () => {
  const mockCompact = vi.mocked(compactMessagesWithSummary);

  beforeEach(() => {
    vi.clearAllMocks();
    mockCompact.mockResolvedValue({
      messages: [],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });
  });

  it('preserves thinkingSignature when converting thinking to reasoning part', async () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'thinking' as const,
            thinking: 'Let me think...',
            thinkingSignature: '{"id":"rs_123","type":"reasoning"}',
          },
        ],
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'gpt-5.3-codex',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      },
    ];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'assistant',
          parts: [{ type: 'reasoning', text: 'Let me think...', signature: '{"id":"rs_123","type":"reasoning"}' }],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const chatMessages = mockCompact.mock.calls[0][0];
    expect(chatMessages[0].parts[0]).toEqual({
      type: 'reasoning',
      text: 'Let me think...',
      signature: '{"id":"rs_123","type":"reasoning"}',
    });
  });

  it('omits signature field when thinking has no thinkingSignature', async () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'thinking' as const, thinking: 'Let me think...' }],
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'gpt-4o',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      },
    ];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'assistant',
          parts: [{ type: 'reasoning', text: 'Let me think...' }],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    const chatMessages = mockCompact.mock.calls[0][0];
    const part = chatMessages[0].parts[0] as { type: string; text: string; signature?: string };
    expect(part.type).toBe('reasoning');
    expect(part.text).toBe('Let me think...');
    expect(part.signature).toBeUndefined();
  });

  it('preserves signature through full round-trip: thinking → reasoning → thinking', async () => {
    // This test verifies the complete pipeline:
    // 1. Agent message with thinking + thinkingSignature
    // 2. Convert to ChatMessage (transform.ts) → reasoning + signature
    // 3. Convert back to pi-mono (message-adapter.ts via chatMessagesToPiMessages mock)

    const sig = '{"id":"rs_456","type":"reasoning"}';
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking' as const, thinking: 'Deep thought', thinkingSignature: sig },
          { type: 'text' as const, text: 'The answer is 42' },
        ],
        api: 'openai-completions' as const,
        provider: 'openai' as const,
        model: 'gpt-5.3-codex',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      },
    ];

    mockCompact.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'Deep thought', signature: sig },
            { type: 'text', text: 'The answer is 42' },
          ],
          createdAt: Date.now(),
        },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext(messages);

    // Step 2: Verify transform.ts produced reasoning with signature
    const chatMessages = mockCompact.mock.calls[0][0];
    const reasoningPart = chatMessages[0].parts[0] as { type: string; text: string; signature?: string };
    expect(reasoningPart.signature).toBe(sig);

    // Step 3: The chatMessagesToPiMessages mock is called with the compacted messages.
    // In real code, message-adapter.ts would convert signature → thinkingSignature.
    // We verify the intermediate ChatMessage format is correct.
    expect(reasoningPart.type).toBe('reasoning');
    expect(reasoningPart.text).toBe('Deep thought');
  });
});

// ── Workspace rules: criticalRules passed to compaction ──

describe('createTransformContext — workspace rules', () => {
  const mockCompact = vi.mocked(compactMessagesWithSummary);

  beforeEach(() => {
    vi.clearAllMocks();
    mockCompact.mockResolvedValue({
      messages: [],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });
  });

  it('passes criticalRules to compactMessagesWithSummary', async () => {
    const { getEnabledWorkspaceFiles } = await import('@extension/storage');
    const mockGetFiles = vi.mocked(getEnabledWorkspaceFiles);
    mockGetFiles.mockResolvedValueOnce([
      { id: 'ws-1', name: 'AGENTS.md', content: '## Red Lines\nNever do X\n## Other\nEnd', enabled: true, owner: 'user', predefined: true, createdAt: 0, updatedAt: 0, agentId: 'main' },
    ] as any);

    const { extractCriticalRules } = await import('./summarizer');
    const mockExtract = vi.mocked(extractCriticalRules);
    mockExtract.mockReturnValueOnce('Red Lines\nNever do X');

    mockCompact.mockResolvedValueOnce({
      messages: [{ id: 'msg-1', chatId: 'chat-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }], createdAt: Date.now() }],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext({ ...defaultOpts, agentId: 'main' });
    await transformContext([makeAgentUserMessage('Hello')]);

    // extractCriticalRules should have been called with the workspace files
    expect(mockExtract).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: 'AGENTS.md' }),
      ]),
    );

    // The criticalRules returned by extractCriticalRules should be passed to compactMessagesWithSummary
    const options = mockCompact.mock.calls[0]![3];
    expect(options).toBeDefined();
    expect(options!.criticalRules).toBe('Red Lines\nNever do X');
  });
});

// ── Phase 5C: CompactionConfig threading ──

describe('createTransformContext — compaction config', () => {
  const mockCompact = vi.mocked(compactMessagesWithSummary);
  const mockGetAgent = vi.mocked(getAgent);

  beforeEach(() => {
    vi.clearAllMocks();
    mockCompact.mockResolvedValue({
      messages: [],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });
  });

  it('passes agent compactionConfig to compactMessagesWithSummary', async () => {
    mockGetAgent.mockResolvedValueOnce({
      id: 'agent-1',
      name: 'Test',
      identity: {},
      isDefault: true,
      compactionConfig: { maxHistoryShare: 0.3, qualityGuardEnabled: false },
      createdAt: 0,
      updatedAt: 0,
    } as any);

    mockCompact.mockResolvedValueOnce({
      messages: [{ id: 'msg-1', chatId: 'chat-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }], createdAt: Date.now() }],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext({ ...defaultOpts, agentId: 'agent-1' });
    await transformContext([makeAgentUserMessage('Hello')]);

    const options = mockCompact.mock.calls[0]![3];
    expect(options).toBeDefined();
    expect(options!.compactionConfig).toEqual(
      expect.objectContaining({ maxHistoryShare: 0.3, qualityGuardEnabled: false }),
    );
  });

  it('passes undefined compactionConfig when agent has no config', async () => {
    mockGetAgent.mockResolvedValueOnce({
      id: 'agent-1',
      name: 'Test',
      identity: {},
      isDefault: true,
      createdAt: 0,
      updatedAt: 0,
    } as any);

    mockCompact.mockResolvedValueOnce({
      messages: [{ id: 'msg-1', chatId: 'chat-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }], createdAt: Date.now() }],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext({ ...defaultOpts, agentId: 'agent-1' });
    await transformContext([makeAgentUserMessage('Hello')]);

    const options = mockCompact.mock.calls[0]![3];
    expect(options!.compactionConfig).toBeUndefined();
  });
});

// ── Phase 6: Compaction metadata persistence ──

describe('createTransformContext — compaction metadata', () => {
  const mockCompact = vi.mocked(compactMessagesWithSummary);
  const mockUpdateMetadata = vi.mocked(updateCompactionMetadata);

  beforeEach(() => {
    vi.clearAllMocks();
    mockCompact.mockResolvedValue({
      messages: [],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });
  });

  it('updates chat record with compaction metadata when compaction occurs', async () => {
    mockCompact.mockResolvedValueOnce({
      messages: [
        { id: 'msg-1', chatId: 'chat-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }], createdAt: Date.now() },
      ],
      wasCompacted: true,
      compactionMethod: 'summary',
      summary: 'A summary',
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext([
      makeAgentUserMessage('Hello'),
      makeAgentAssistantMessage('Response'),
    ]);

    await vi.waitFor(() => {
      expect(mockUpdateMetadata).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        compactionMethod: 'summary',
        compactionTokensBefore: expect.any(Number),
        compactionTokensAfter: expect.any(Number),
      }));
    });
  });

  it('does not update metadata when no compaction occurred', async () => {
    mockCompact.mockResolvedValueOnce({
      messages: [
        { id: 'msg-1', chatId: 'chat-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }], createdAt: Date.now() },
      ],
      wasCompacted: false,
      compactionMethod: 'none',
      summary: undefined,
    });

    const { transformContext } = createTransformContext(defaultOpts);
    await transformContext([makeAgentUserMessage('Hello')]);

    expect(mockUpdateMetadata).not.toHaveBeenCalled();
  });
});
