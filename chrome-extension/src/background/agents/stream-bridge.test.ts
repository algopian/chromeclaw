/**
 * Tests for pi-stream-bridge.ts — createStreamFn and completeText
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssistantMessageEvent, AssistantMessage, Context, Model } from '@mariozechner/pi-ai';
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import type { ChatModel } from '@extension/shared';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../logging/logger-buffer', () => ({
  createLogger: () => ({
    info: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), warn: vi.fn(),
  }),
}));

let mockStreamSimpleResult: ReturnType<typeof createAssistantMessageEventStream>;
let mockCompleteSimpleResult: AssistantMessage;

vi.mock('@mariozechner/pi-ai', async importOriginal => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-ai')>();
  return {
    ...actual,
    streamSimple: vi.fn((_model: any, _context: any, _options: any) => {
      return mockStreamSimpleResult;
    }),
    completeSimple: vi.fn(async (_model: any, _context: any, _options: any) => {
      return mockCompleteSimpleResult;
    }),
  };
});

// Mock local-llm-bridge — avoids chrome.offscreen imports in test environment
vi.mock('../local-llm-bridge', () => ({
  requestLocalGeneration: vi.fn(),
}));

// Mock web-llm-bridge — avoids chrome.scripting imports in test environment
vi.mock('../web-providers/web-llm-bridge', () => ({
  requestWebGeneration: vi.fn(),
}));

// Mock chatModelToPiModel — returns a ResolvedModel
vi.mock('./model-adapter', () => ({
  chatModelToPiModel: vi.fn((_config: any) => ({
    model: {
      id: 'gpt-4o',
      name: 'GPT-4o',
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 32000,
    },
    apiKey: 'test-key',
  })),
}));

// Import after mocks
import { createStreamFn, completeText } from './stream-bridge';

// ── Test Fixtures ────────────────────────────────────────

const TEST_CHAT_MODEL: ChatModel = {
  id: 'gpt-4o',
  name: 'GPT-4o',
  provider: 'openai',
  routingMode: 'direct',
};

const TEST_PI_MODEL: Model<'openai-completions'> = {
  id: 'gpt-4o',
  name: 'GPT-4o',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000,
};

/** Collect all events from an AssistantMessageEventStream. */
const collectEvents = async (
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> => {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

const makeAssistantMessage = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'Hello' }],
  api: 'openai-completions',
  provider: 'openai',
  model: 'gpt-4o',
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: Date.now(),
  ...overrides,
});

// ── Tests ────────────────────────────────────────────────

describe('createStreamFn', () => {
  beforeEach(() => {
    mockStreamSimpleResult = createAssistantMessageEventStream();
  });

  it('returns a StreamFn that delegates to streamSimple', async () => {
    const streamFn = createStreamFn(TEST_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    // Push events to the mock stream
    const finalMsg = makeAssistantMessage();
    setTimeout(() => {
      mockStreamSimpleResult.push({ type: 'start', partial: finalMsg });
      mockStreamSimpleResult.push({ type: 'text_start', contentIndex: 0, partial: finalMsg });
      mockStreamSimpleResult.push({
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Hello',
        partial: finalMsg,
      });
      mockStreamSimpleResult.push({
        type: 'text_end',
        contentIndex: 0,
        content: 'Hello',
        partial: finalMsg,
      });
      mockStreamSimpleResult.push({ type: 'done', reason: 'stop', message: finalMsg });
    }, 0);

    const streamOrPromise = streamFn(TEST_PI_MODEL, context);
    const stream = streamOrPromise instanceof Promise ? await streamOrPromise : streamOrPromise;
    const events = await collectEvents(stream);

    expect(events.length).toBe(5);
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    if (doneEvent?.type === 'done') {
      expect(doneEvent.reason).toBe('stop');
    }
  });

  it('error event → stream emits error with stopReason aborted', async () => {
    const streamFn = createStreamFn(TEST_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    const errorMsg = makeAssistantMessage({ stopReason: 'aborted' });
    setTimeout(() => {
      mockStreamSimpleResult.push({ type: 'error', reason: 'aborted', error: errorMsg });
    }, 0);

    const streamOrPromise2 = streamFn(TEST_PI_MODEL, context);
    const stream = streamOrPromise2 instanceof Promise ? await streamOrPromise2 : streamOrPromise2;
    const events = await collectEvents(stream);

    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.reason).toBe('aborted');
      expect(errorEvent.error.stopReason).toBe('aborted');
    }
  });

  it('error event → stream emits error with stopReason error', async () => {
    const streamFn = createStreamFn(TEST_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    const errorMsg = makeAssistantMessage({
      stopReason: 'error',
      errorMessage: 'API rate limit',
    });
    setTimeout(() => {
      mockStreamSimpleResult.push({ type: 'error', reason: 'error', error: errorMsg });
    }, 0);

    const streamOrPromise3 = streamFn(TEST_PI_MODEL, context);
    const stream = streamOrPromise3 instanceof Promise ? await streamOrPromise3 : streamOrPromise3;
    const events = await collectEvents(stream);

    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.reason).toBe('error');
      expect(errorEvent.error.errorMessage).toContain('API rate limit');
    }
  });
});

describe('completeText', () => {
  beforeEach(() => {
    mockCompleteSimpleResult = makeAssistantMessage({
      content: [{ type: 'text', text: 'Summary result' }],
    });
  });

  it('returns text from completeSimple result', async () => {
    const result = await completeText(TEST_CHAT_MODEL, 'System prompt', 'User content');
    expect(result).toBe('Summary result');
  });

  it('joins multiple text parts', async () => {
    mockCompleteSimpleResult = makeAssistantMessage({
      content: [
        { type: 'text', text: 'Part 1 ' },
        { type: 'text', text: 'Part 2' },
      ],
    });

    const result = await completeText(TEST_CHAT_MODEL, 'System', 'User');
    expect(result).toBe('Part 1 Part 2');
  });

  it('filters out non-text content', async () => {
    mockCompleteSimpleResult = makeAssistantMessage({
      content: [
        { type: 'thinking', thinking: 'internal thoughts' } as any,
        { type: 'text', text: 'Visible result' },
      ],
    });

    const result = await completeText(TEST_CHAT_MODEL, 'System', 'User');
    expect(result).toBe('Visible result');
  });

  it('throws for local models', async () => {
    const localModel: ChatModel = {
      id: 'local-llama',
      name: 'Local Llama',
      provider: 'local',
      routingMode: 'direct',
    };

    await expect(completeText(localModel, 'System', 'User')).rejects.toThrow(
      'completeText is not supported for local models',
    );
  });

  it('throws for web models', async () => {
    const webModel: ChatModel = {
      id: 'claude-web',
      name: 'Claude Web',
      provider: 'web',
      webProviderId: 'claude-web',
    };

    await expect(completeText(webModel, 'System', 'User')).rejects.toThrow(
      'completeText is not supported for web models',
    );
  });
});

// ── Local model tests ───────────────────────────────────

import { requestLocalGeneration } from '../local-llm-bridge';
import { requestWebGeneration } from '../web-providers/web-llm-bridge';

const LOCAL_CHAT_MODEL: ChatModel = {
  id: 'Qwen/Qwen3-0.6B',
  name: 'Qwen3 0.6B',
  provider: 'local',
  routingMode: 'direct',
};

describe('createStreamFn — local provider', () => {
  const mockRequestLocalGeneration = vi.mocked(requestLocalGeneration);

  beforeEach(() => {
    mockRequestLocalGeneration.mockReset();
  });

  it('delegates to requestLocalGeneration for local models', () => {
    const mockStream = createAssistantMessageEventStream();
    mockRequestLocalGeneration.mockReturnValue(mockStream);

    const streamFn = createStreamFn(LOCAL_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Be helpful',
      messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
    };

    const result = streamFn({} as Model<any>, context);
    // local path is synchronous, not a Promise
    expect(result).toBe(mockStream);

    expect(mockRequestLocalGeneration).toHaveBeenCalledOnce();
    expect(mockRequestLocalGeneration).toHaveBeenCalledWith({
      modelId: 'Qwen/Qwen3-0.6B',
      messages: [{ role: 'user', content: 'Hello' }],
      systemPrompt: 'Be helpful',
      device: undefined,
    });
  });

  it('converts string message content to string', () => {
    const mockStream = createAssistantMessageEventStream();
    mockRequestLocalGeneration.mockReturnValue(mockStream);

    const streamFn = createStreamFn(LOCAL_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [
        { role: 'user', content: 'plain string message', timestamp: Date.now() },
      ],
    };

    streamFn({} as Model<any>, context);

    expect(mockRequestLocalGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'plain string message' }],
      }),
    );
  });

  it('extracts and joins text from array content, filtering non-text parts', () => {
    const mockStream = createAssistantMessageEventStream();
    mockRequestLocalGeneration.mockReturnValue(mockStream);

    const streamFn = createStreamFn(LOCAL_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'First part ' },
            { type: 'thinking', thinking: 'hidden' } as any,
            { type: 'text', text: 'second part' },
          ],
          api: 'openai-completions' as const,
          provider: 'openai' as const,
          model: 'test',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop' as const,
          timestamp: Date.now(),
        },
      ],
    };

    streamFn({} as Model<any>, context);

    expect(mockRequestLocalGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'assistant', content: 'First part second part' }],
      }),
    );
  });

  it('maps toolResult role to user with XML-wrapped content', () => {
    const mockStream = createAssistantMessageEventStream();
    mockRequestLocalGeneration.mockReturnValue(mockStream);

    const streamFn = createStreamFn(LOCAL_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [
        {
          role: 'toolResult',
          toolCallId: 'call_123',
          toolName: 'web_search',
          content: [{ type: 'text', text: 'tool output' }],
          timestamp: Date.now(),
        } as any,
      ],
    };

    streamFn({} as Model<any>, context);

    const calledMessages = mockRequestLocalGeneration.mock.calls[0][0].messages;
    expect(calledMessages[0].role).toBe('user');
    expect(calledMessages[0].content).toContain('<tool_response id="call_123" name="web_search">');
    expect(calledMessages[0].content).toContain('tool output');
    expect(calledMessages[0].content).toContain('</tool_response>');
    expect(calledMessages[0].content).toContain('[SYSTEM HINT]');
  });

  it('handles undefined content by producing empty string', () => {
    const mockStream = createAssistantMessageEventStream();
    mockRequestLocalGeneration.mockReturnValue(mockStream);

    const streamFn = createStreamFn(LOCAL_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [
        { role: 'user', content: undefined as any, timestamp: Date.now() },
      ],
    };

    streamFn({} as Model<any>, context);

    expect(mockRequestLocalGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: '' }],
      }),
    );
  });

  it('passes undefined systemPrompt as empty string', () => {
    const mockStream = createAssistantMessageEventStream();
    mockRequestLocalGeneration.mockReturnValue(mockStream);

    const streamFn = createStreamFn(LOCAL_CHAT_MODEL);
    const context: Context = {
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    streamFn({} as Model<any>, context);

    expect(mockRequestLocalGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: '',
      }),
    );
  });
});

describe('createStreamFn — local provider device validation', () => {
  const mockRequestLocalGeneration = vi.mocked(requestLocalGeneration);

  beforeEach(() => {
    mockRequestLocalGeneration.mockReset();
    mockRequestLocalGeneration.mockReturnValue(createAssistantMessageEventStream());
  });

  it('sets device to webgpu when baseUrl is "webgpu"', () => {
    const model: ChatModel = { ...LOCAL_CHAT_MODEL, baseUrl: 'webgpu' };
    const streamFn = createStreamFn(model);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    streamFn({} as Model<any>, context);

    expect(mockRequestLocalGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ device: 'webgpu' }),
    );
  });

  it('sets device to wasm when baseUrl is "wasm"', () => {
    const model: ChatModel = { ...LOCAL_CHAT_MODEL, baseUrl: 'wasm' };
    const streamFn = createStreamFn(model);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    streamFn({} as Model<any>, context);

    expect(mockRequestLocalGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ device: 'wasm' }),
    );
  });

  it('sets device to undefined when baseUrl is an unrecognized value', () => {
    const model: ChatModel = { ...LOCAL_CHAT_MODEL, baseUrl: 'https://localhost:8080' };
    const streamFn = createStreamFn(model);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    streamFn({} as Model<any>, context);

    expect(mockRequestLocalGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ device: undefined }),
    );
  });

  it('sets device to undefined when baseUrl is not set', () => {
    const model: ChatModel = { ...LOCAL_CHAT_MODEL };
    delete model.baseUrl;
    const streamFn = createStreamFn(model);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    streamFn({} as Model<any>, context);

    expect(mockRequestLocalGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ device: undefined }),
    );
  });
});

describe('createStreamFn — local provider error handling', () => {
  const mockRequestLocalGeneration = vi.mocked(requestLocalGeneration);

  beforeEach(() => {
    mockRequestLocalGeneration.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns an error stream when requestLocalGeneration throws an Error', async () => {
    mockRequestLocalGeneration.mockImplementation(() => {
      throw new Error('Model not found');
    });

    const streamFn = createStreamFn(LOCAL_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    const result = streamFn({} as Model<any>, context);
    const stream = result instanceof Promise ? await result : result;
    const events = await collectEvents(stream);

    expect(events).toHaveLength(1);
    const errorEvent = events[0];
    expect(errorEvent.type).toBe('error');
    if (errorEvent.type === 'error') {
      expect(errorEvent.reason).toBe('error');
      expect(errorEvent.error.stopReason).toBe('error');
      expect(errorEvent.error.errorMessage).toBe('Local LLM error: Model not found');
      expect(errorEvent.error.api).toBe('local-transformers');
      expect(errorEvent.error.provider).toBe('local');
      expect(errorEvent.error.model).toBe('Qwen/Qwen3-0.6B');
      expect(errorEvent.error.usage).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
      expect(errorEvent.error.content).toEqual([{ type: 'text', text: '' }]);
    }
  });

  it('returns an error stream when requestLocalGeneration throws a non-Error', async () => {
    mockRequestLocalGeneration.mockImplementation(() => {
      throw 'string error'; // eslint-disable-line no-throw-literal
    });

    const streamFn = createStreamFn(LOCAL_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    const result = streamFn({} as Model<any>, context);
    const stream = result instanceof Promise ? await result : result;
    const events = await collectEvents(stream);

    expect(events).toHaveLength(1);
    const errorEvent = events[0];
    expect(errorEvent.type).toBe('error');
    if (errorEvent.type === 'error') {
      expect(errorEvent.error.errorMessage).toBe('Local LLM error: string error');
    }
  });

  it('logs the error to console.error', () => {
    mockRequestLocalGeneration.mockImplementation(() => {
      throw new Error('GPU init failed');
    });

    const streamFn = createStreamFn(LOCAL_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    streamFn({} as Model<any>, context);

    expect(console.error).toHaveBeenCalledWith(
      '[stream-bridge] Local LLM streamFn error:',
      expect.any(Error),
    );
  });
});

// ── Web model tests ───────────────────────────────────

const WEB_CHAT_MODEL: ChatModel = {
  id: 'qwen-max',
  name: 'Qwen Max',
  provider: 'web',
  webProviderId: 'qwen-web',
};

describe('createStreamFn — web provider', () => {
  const mockRequestWebGeneration = vi.mocked(requestWebGeneration);

  beforeEach(() => {
    mockRequestWebGeneration.mockReset();
  });

  it('delegates to requestWebGeneration for web models', () => {
    const mockStream = createAssistantMessageEventStream();
    mockRequestWebGeneration.mockReturnValue(mockStream);

    const streamFn = createStreamFn(WEB_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Be helpful',
      messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
    };

    const result = streamFn({} as Model<any>, context);
    expect(result).toBe(mockStream);

    expect(mockRequestWebGeneration).toHaveBeenCalledOnce();
    expect(mockRequestWebGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: WEB_CHAT_MODEL,
        messages: [{ role: 'user', content: 'Hello' }],
        systemPrompt: 'Be helpful',
      }),
    );
  });

  it('returns an error stream when requestWebGeneration throws', async () => {
    mockRequestWebGeneration.mockImplementation(() => {
      throw new Error('Tab closed');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const streamFn = createStreamFn(WEB_CHAT_MODEL);
    const context: Context = {
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    };

    const result = streamFn({} as Model<any>, context);
    const stream = result instanceof Promise ? await result : result;
    const events = await collectEvents(stream);

    expect(events).toHaveLength(1);
    const errorEvent = events[0];
    expect(errorEvent.type).toBe('error');
    if (errorEvent.type === 'error') {
      expect(errorEvent.error.errorMessage).toBe('Web LLM error: Tab closed');
      expect(errorEvent.error.api).toBe('web-session');
      expect(errorEvent.error.provider).toBe('web');
    }
  });
});
