/**
 * Tests for stream-handler.ts — handleLLMStream
 * Verifies message forwarding, error handling, and lifecycle events.
 */

// Import after mocks
import { runAgent } from './agent-setup';
import { handleLLMStream } from './stream-handler';
import { saveArtifact } from '@extension/storage';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAgentOpts } from './agent-setup';
import type { ChatModel, ChatMessage, LLMRequestMessage } from '@extension/shared';

// ── Mocks ────────────────────────────────────────────────

vi.mock('./agent-setup', () => ({
  ProxyAuthError: class ProxyAuthError extends Error {},
  runAgent: vi.fn(),
  buildHeadlessSystemPrompt: vi.fn(async () => 'Fresh system prompt'),
}));

vi.mock('../context/history-sanitization', () => ({
  sanitizeHistory: vi.fn((msgs: ChatMessage[]) => msgs),
}));

vi.mock('../logging/logger-buffer', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('./message-adapter', () => ({
  chatMessagesToPiMessages: vi.fn((msgs: ChatMessage[]) =>
    msgs.map(m => ({
      role: m.role,
      content: (m.parts?.[0] as { type: 'text'; text: string })?.text || '',
      timestamp: m.createdAt,
    })),
  ),
  convertToLlm: vi.fn((msgs: unknown[]) => msgs),
  makeConvertToLlm: vi.fn(() => (msgs: unknown[]) => msgs),
}));

vi.mock('./model-adapter', () => ({
  chatModelToPiModel: vi.fn(() => ({
    model: { id: 'test', name: 'Test' },
  })),
}));

vi.mock('../context/transform', () => ({
  createTransformContext: vi.fn(() => ({
    transformContext: vi.fn(async (msgs: unknown[]) => msgs),
    getResult: () => ({ wasCompacted: false }),
  })),
}));

vi.mock('../memory/memory-flush', () => ({
  runMemoryFlushIfNeeded: vi.fn(async () => {}),
}));

vi.mock('@extension/storage', () => ({
  activeAgentStorage: { get: vi.fn(async () => 'main') },
  saveArtifact: vi.fn(async () => {}),
}));

// ── Test fixtures ────────────────────────────────────────

const mockModelConfig: ChatModel = {
  id: 'gpt-4o',
  name: 'GPT-4o',
  provider: 'openai',
  routingMode: 'direct',
};

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'msg-1',
  chatId: 'chat-1',
  role: 'user',
  parts: [{ type: 'text', text: 'Hello' }],
  createdAt: Date.now(),
  ...overrides,
});

const createMockPort = () => ({
  postMessage: vi.fn(),
  onMessage: { addListener: vi.fn() },
  onDisconnect: { addListener: vi.fn() },
});

const makeRequest = (overrides: Partial<LLMRequestMessage> = {}): LLMRequestMessage => ({
  type: 'LLM_REQUEST',
  chatId: 'chat-1',
  messages: [makeMessage()],
  model: mockModelConfig,
  ...overrides,
});

// ── Tests ────────────────────────────────────────────────

describe('handleLLMStream', () => {
  const mockRunAgent = vi.mocked(runAgent);

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: runAgent calls onAgentEnd with a successful completion
    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      // Simulate a simple agent end
      opts.onAgentEnd?.({
        agent: { state: {} } as never,
        messages: [],
        stepCount: 1,
        timedOut: false,
      });

      return {
        responseText: 'Hello!',
        parts: [{ type: 'text' as const, text: 'Hello!' }],
        usage: { inputTokens: 10, outputTokens: 5 },
        agent: { state: {} } as never,
        stepCount: 1,
        timedOut: false,
        retryAttempts: 0,
      };
    });
  });

  it('sends LLM_STREAM_ERROR when no messages provided', async () => {
    const port = createMockPort();
    const request = makeRequest({ messages: [] });

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'LLM_STREAM_ERROR',
        chatId: 'chat-1',
        error: 'No messages to send',
      }),
    );
  });

  it('calls runAgent with correct parameters', async () => {
    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    expect(mockRunAgent).toHaveBeenCalledOnce();
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockModelConfig,
        systemPrompt: 'Fresh system prompt',
      }),
    );
  });

  it('sends LLM_STREAM_CHUNK for text deltas via onTextDelta callback', async () => {
    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      // Simulate text delta events
      opts.onTextDelta?.('Hello');
      opts.onTextDelta?.(' world');

      opts.onAgentEnd?.({
        agent: { state: {} } as never,
        messages: [],
        stepCount: 1,
        timedOut: false,
      });

      return {
        responseText: 'Hello world',
        parts: [{ type: 'text' as const, text: 'Hello world' }],
        usage: { inputTokens: 10, outputTokens: 5 },
        agent: { state: {} } as never,
        stepCount: 1,
        timedOut: false,
        retryAttempts: 0,
      };
    });

    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    // Verify text delta chunks were sent
    const chunkCalls = port.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === 'LLM_STREAM_CHUNK',
    );
    expect(chunkCalls.length).toBeGreaterThanOrEqual(2);
    expect(chunkCalls[0][0]).toEqual(
      expect.objectContaining({
        type: 'LLM_STREAM_CHUNK',
        chatId: 'chat-1',
        delta: 'Hello',
      }),
    );
    expect(chunkCalls[1][0]).toEqual(
      expect.objectContaining({
        type: 'LLM_STREAM_CHUNK',
        chatId: 'chat-1',
        delta: ' world',
      }),
    );
  });

  it('sends LLM_STREAM_END on successful completion', async () => {
    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      opts.onAgentEnd?.({
        agent: { state: {} } as never,
        messages: [
          {
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: 'Hello!' }],
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
        ],
        stepCount: 1,
        timedOut: false,
      });

      return {
        responseText: 'Hello!',
        parts: [{ type: 'text' as const, text: 'Hello!' }],
        usage: { inputTokens: 10, outputTokens: 5 },
        agent: { state: {} } as never,
        stepCount: 1,
        timedOut: false,
        retryAttempts: 0,
      };
    });

    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    const endCalls = port.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === 'LLM_STREAM_END',
    );
    expect(endCalls).toHaveLength(1);
    expect(endCalls[0][0]).toEqual(
      expect.objectContaining({
        type: 'LLM_STREAM_END',
        chatId: 'chat-1',
        finishReason: 'stop',
        wasCompacted: false,
      }),
    );
  });

  it('sends LLM_STREAM_ERROR on exception', async () => {
    mockRunAgent.mockRejectedValueOnce(new Error('API connection failed'));

    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'LLM_STREAM_ERROR',
        chatId: 'chat-1',
        error: 'API connection failed',
      }),
    );
  });

  it('sends LLM_STEP_FINISH on turn end', async () => {
    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      // Simulate a turn end with usage
      opts.onTurnEnd?.({
        stepCount: 1,
        usage: { input: 50, output: 20 },
        message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'Response' }],
          api: 'openai-completions' as const,
          provider: 'openai' as const,
          model: 'gpt-4o',
          usage: {
            input: 50,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 70,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop' as const,
          timestamp: Date.now(),
        },
      });

      opts.onAgentEnd?.({
        agent: { state: {} } as never,
        messages: [],
        stepCount: 1,
        timedOut: false,
      });

      return {
        responseText: 'Response',
        parts: [{ type: 'text' as const, text: 'Response' }],
        usage: { inputTokens: 50, outputTokens: 20 },
        agent: { state: {} } as never,
        stepCount: 1,
        timedOut: false,
        retryAttempts: 0,
      };
    });

    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    const stepCalls = port.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === 'LLM_STEP_FINISH',
    );
    expect(stepCalls).toHaveLength(1);
    expect(stepCalls[0][0]).toEqual(
      expect.objectContaining({
        type: 'LLM_STEP_FINISH',
        chatId: 'chat-1',
        stepNumber: 1,
        usage: expect.objectContaining({
          promptTokens: expect.any(Number),
          completionTokens: expect.any(Number),
          totalTokens: expect.any(Number),
        }),
      }),
    );
  });

  it('saves artifact on createDocument tool result', async () => {
    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      opts.onToolResult?.({
        toolCallId: 'tc-art-1',
        toolName: 'create_document',
        result: 'Created document',
        isError: false,
        details: {
          id: 'art-1',
          title: 'My Doc',
          kind: 'text',
          content: 'Document content here',
        },
      });

      opts.onAgentEnd?.({
        agent: { state: {} } as never,
        messages: [],
        stepCount: 1,
        timedOut: false,
      });

      return {
        responseText: 'Created',
        parts: [{ type: 'text' as const, text: 'Created' }],
        usage: { inputTokens: 10, outputTokens: 5 },
        agent: { state: {} } as never,
        stepCount: 1,
        timedOut: false,
        retryAttempts: 0,
      };
    });

    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    expect(saveArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'art-1',
        chatId: 'chat-1',
        title: 'My Doc',
        kind: 'text',
        content: 'Document content here',
      }),
    );
  });

  it('does not save artifact on tool error', async () => {
    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      opts.onToolResult?.({
        toolCallId: 'tc-art-err',
        toolName: 'create_document',
        result: 'Error creating document',
        isError: true,
        details: { id: 'art-err', content: 'bad content' },
      });

      opts.onAgentEnd?.({
        agent: { state: {} } as never,
        messages: [],
        stepCount: 1,
        timedOut: false,
      });

      return {
        responseText: 'Error',
        parts: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        agent: { state: {} } as never,
        stepCount: 1,
        timedOut: false,
        retryAttempts: 0,
      };
    });

    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    expect(saveArtifact).not.toHaveBeenCalled();
  });

  it('sends LLM_STREAM_ERROR when agent ends with error', async () => {
    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      opts.onAgentEnd?.({
        agent: { state: { error: 'Rate limit exceeded' } } as never,
        messages: [],
        stepCount: 1,
        timedOut: false,
      });

      return {
        responseText: '',
        parts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        agent: { state: { error: 'Rate limit exceeded' } } as never,
        stepCount: 1,
        timedOut: false,
        retryAttempts: 0,
      };
    });

    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'LLM_STREAM_ERROR',
        chatId: 'chat-1',
        error: 'Rate limit exceeded',
      }),
    );
  });

  it('derives finishReason "length" from stopReason', async () => {
    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      opts.onAgentEnd?.({
        agent: { state: {} } as never,
        messages: [
          {
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: 'Truncated...' }],
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
            stopReason: 'length' as const,
            timestamp: Date.now(),
          },
        ],
        stepCount: 1,
        timedOut: false,
      });

      return {
        responseText: 'Truncated...',
        parts: [{ type: 'text' as const, text: 'Truncated...' }],
        usage: { inputTokens: 10, outputTokens: 5 },
        agent: { state: {} } as never,
        stepCount: 1,
        timedOut: false,
        retryAttempts: 0,
      };
    });

    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    const endCalls = port.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === 'LLM_STREAM_END',
    );
    expect(endCalls).toHaveLength(1);
    expect(endCalls[0][0]).toEqual(
      expect.objectContaining({
        finishReason: 'length',
      }),
    );
  });

  it('derives finishReason "timeout" from timedOut flag', async () => {
    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      opts.onAgentEnd?.({
        agent: { state: {} } as never,
        messages: [],
        stepCount: 1,
        timedOut: true,
      });

      return {
        responseText: 'Timed out',
        parts: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        agent: { state: {} } as never,
        stepCount: 1,
        timedOut: true,
        retryAttempts: 0,
      };
    });

    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    const endCalls = port.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === 'LLM_STREAM_END',
    );
    expect(endCalls).toHaveLength(1);
    expect(endCalls[0][0]).toEqual(
      expect.objectContaining({
        finishReason: 'timeout',
      }),
    );
  });

  it('sends LLM_STREAM_RETRY on retry callback', async () => {
    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      opts.onRetry?.({
        attempt: 1,
        maxAttempts: 3,
        reason: 'Context overflow — retrying with compaction',
        strategy: 'compaction',
      });

      opts.onAgentEnd?.({
        agent: { state: {} } as never,
        messages: [],
        stepCount: 1,
        timedOut: false,
      });

      return {
        responseText: 'Retried',
        parts: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        agent: { state: {} } as never,
        stepCount: 1,
        timedOut: false,
        retryAttempts: 1,
      };
    });

    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    const retryCalls = port.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === 'LLM_STREAM_RETRY',
    );
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0][0]).toEqual(
      expect.objectContaining({
        type: 'LLM_STREAM_RETRY',
        chatId: 'chat-1',
        attempt: 1,
        maxAttempts: 3,
        strategy: 'compaction',
      }),
    );
  });

  it('sends reasoning deltas as chunks', async () => {
    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      opts.onReasoningDelta?.('Thinking about this...');

      opts.onAgentEnd?.({
        agent: { state: {} } as never,
        messages: [],
        stepCount: 1,
        timedOut: false,
      });

      return {
        responseText: 'Done',
        parts: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        agent: { state: {} } as never,
        stepCount: 1,
        timedOut: false,
        retryAttempts: 0,
      };
    });

    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    const reasoningChunks = port.postMessage.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { type: string }).type === 'LLM_STREAM_CHUNK' &&
        (call[0] as { reasoning?: string }).reasoning,
    );
    expect(reasoningChunks).toHaveLength(1);
    expect(reasoningChunks[0][0]).toEqual(
      expect.objectContaining({
        type: 'LLM_STREAM_CHUNK',
        chatId: 'chat-1',
        reasoning: 'Thinking about this...',
      }),
    );
  });

  it('sends tool call chunks via onToolCallEnd', async () => {
    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      opts.onToolCallEnd?.({
        id: 'tc-1',
        name: 'get_weather',
        args: { city: 'SF' },
      });

      opts.onAgentEnd?.({
        agent: { state: {} } as never,
        messages: [],
        stepCount: 1,
        timedOut: false,
      });

      return {
        responseText: 'Done',
        parts: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        agent: { state: {} } as never,
        stepCount: 1,
        timedOut: false,
        retryAttempts: 0,
      };
    });

    const port = createMockPort();
    const request = makeRequest();

    await handleLLMStream(port as unknown as chrome.runtime.Port, request);

    const toolCallChunks = port.postMessage.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { type: string }).type === 'LLM_STREAM_CHUNK' &&
        (call[0] as { toolCall?: unknown }).toolCall,
    );
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0][0]).toEqual(
      expect.objectContaining({
        type: 'LLM_STREAM_CHUNK',
        chatId: 'chat-1',
        toolCall: { id: 'tc-1', name: 'get_weather', args: { city: 'SF' } },
        state: 'input-available',
      }),
    );
  });

  it('does not crash when port disconnects mid-stream', async () => {
    // Simulate port.postMessage throwing after the port disconnects.
    // In real Chrome, this happens when the UI (side panel) closes
    // while the background worker is still streaming.
    const port = createMockPort();
    let callCount = 0;
    port.postMessage.mockImplementation(() => {
      callCount++;
      // Allow the first postMessage (e.g. compaction chunk), then
      // throw on all subsequent calls as if the port disconnected.
      if (callCount >= 2) {
        throw new Error('Attempting to use a disconnected port object');
      }
    });

    mockRunAgent.mockImplementation(async (opts: RunAgentOpts) => {
      // Trigger callbacks that call port.postMessage internally:
      // onTextDelta → sendChunk, onTurnEnd → sendStepFinish,
      // onAgentEnd → sendEnd. Each of these will throw after callCount >= 2.
      opts.onTextDelta?.('Hello');
      opts.onTextDelta?.(' world');
      opts.onTurnEnd?.({
        stepCount: 1,
        usage: { input: 10, output: 5 },
        message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'Hello world' }],
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
      });
      opts.onAgentEnd?.({
        agent: { state: {} } as never,
        messages: [],
        stepCount: 1,
        timedOut: false,
      });

      return {
        responseText: 'Hello world',
        parts: [{ type: 'text' as const, text: 'Hello world' }],
        usage: { inputTokens: 10, outputTokens: 5 },
        agent: { state: {} } as never,
        stepCount: 1,
        timedOut: false,
        retryAttempts: 0,
      };
    });

    const request = makeRequest();

    // Key assertion: handleLLMStream should resolve normally even though
    // port.postMessage throws on most calls. Before the fix, this would
    // reject with "Attempting to use a disconnected port object".
    await expect(
      handleLLMStream(port as unknown as chrome.runtime.Port, request),
    ).resolves.toBeUndefined();
  });
});
