/**
 * Tests for web-llm-bridge.ts — web provider streaming bridge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatModel } from '@extension/shared';

// ── Mocks ──────────────────────────────────────

vi.mock('../agents', () => ({
  createAssistantMessageEventStream: vi.fn(() => {
    const events: unknown[] = [];
    return {
      push: vi.fn((e: unknown) => events.push(e)),
      events,
    };
  }),
}));

vi.mock('../logging/logger-buffer', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(),
  }),
}));

vi.mock('./auth', () => ({
  getWebCredential: vi.fn(async () => ({
    providerId: 'qwen-web',
    cookies: { token: 'test-token' },
    capturedAt: Date.now(),
  })),
}));

const mockParseSseDelta = (data: any) => data?.choices?.[0]?.delta?.content ?? null;

vi.mock('./registry', () => ({
  getWebProvider: vi.fn((id: string) => {
    if (id === 'qwen-web') {
      return {
        id: 'qwen-web',
        name: 'Qwen (Web)',
        loginUrl: 'https://chat.qwen.ai',
        cookieDomain: '.qwen.ai',
        sessionIndicators: ['token'],
        defaultModelId: 'qwen-max',
        defaultModelName: 'Qwen Max',
        supportsTools: true,
        supportsReasoning: true,
        contextWindow: 32_000,
        buildRequest: () => ({
          url: 'https://chat.qwen.ai/api/chat/completions',
          init: { method: 'POST', body: '{}' },
        }),
        parseSseDelta: mockParseSseDelta,
      };
    }
    if (id === 'gemini-web') {
      return {
        id: 'gemini-web',
        name: 'Gemini (Web)',
        loginUrl: 'https://gemini.google.com',
        cookieDomain: '.google.com',
        sessionIndicators: ['SID'],
        defaultModelId: 'gemini-3-flash',
        defaultModelName: 'Gemini 3 Flash',
        supportsTools: true,
        supportsReasoning: true,
        contextWindow: 150_000,
        buildRequest: () => ({
          url: 'https://gemini.google.com/api',
          init: { method: 'POST', body: '{}' },
        }),
        parseSseDelta: mockParseSseDelta,
      };
    }
    return undefined;
  }),
}));

vi.mock('./content-fetch-relay', () => ({
  installRelay: vi.fn(),
}));

vi.mock('./content-fetch-main', () => ({
  mainWorldFetch: vi.fn(),
}));

type MessageListener = (msg: Record<string, unknown>) => void;
const listeners: MessageListener[] = [];

vi.stubGlobal('chrome', {
  runtime: {
    onMessage: {
      addListener: vi.fn((fn: MessageListener) => listeners.push(fn)),
      removeListener: vi.fn((fn: MessageListener) => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      }),
    },
  },
  tabs: {
    query: vi.fn(async () => [{ id: 1 }]),
    create: vi.fn(async () => ({ id: 1 })),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  scripting: {
    executeScript: vi.fn(async () => {}),
  },
});

vi.stubGlobal('crypto', { randomUUID: () => 'web-test-uuid' });

import { requestWebGeneration } from './web-llm-bridge';

const fireMessage = (msg: Record<string, unknown>) => {
  for (const fn of [...listeners]) fn(msg);
};

const defaultModel: ChatModel = {
  id: 'qwen-max',
  name: 'Qwen Max',
  provider: 'web',
  webProviderId: 'qwen-web',
};

const geminiModel: ChatModel = {
  id: 'gemini-3-flash',
  name: 'Gemini 3 Flash',
  provider: 'web',
  webProviderId: 'gemini-web',
};

const defaultOpts = {
  modelConfig: defaultModel,
  messages: [{ role: 'user', content: 'Hello' }],
  systemPrompt: 'You are helpful.',
};

const geminiOpts = {
  modelConfig: geminiModel,
  messages: [{ role: 'user', content: 'Hello' }],
  systemPrompt: 'You are helpful.',
};

// ── Tests ──────────────────────────────────────

describe('requestWebGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.length = 0;
  });

  it('returns a stream object with push method', () => {
    const stream = requestWebGeneration(defaultOpts);
    expect(stream).toBeDefined();
    expect(stream.push).toBeDefined();
  });

  it('sends start events after setup completes', async () => {
    const stream = requestWebGeneration(defaultOpts);

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'start')).toBe(true);
      expect(events.some(e => e.type === 'text_start')).toBe(true);
    });
  });

  it('emits text_delta on WEB_LLM_CHUNK with SSE data', async () => {
    const stream = requestWebGeneration(defaultOpts);

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'start')).toBe(true);
    });

    // Send SSE chunk with OpenAI-compatible format
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk: 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    });

    const events = (stream as any).events as Array<{ type: string; delta?: string }>;
    const textDelta = events.find(e => e.type === 'text_delta');
    expect(textDelta).toBeDefined();
    expect(textDelta!.delta).toBe('Hello');
  });

  it('emits done on WEB_LLM_DONE with content', async () => {
    const stream = requestWebGeneration(defaultOpts);

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'start')).toBe(true);
    });

    // Send some content first, then done
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk: 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    });
    fireMessage({
      type: 'WEB_LLM_DONE',
      requestId: 'web-test-uuid',
    });

    const events = (stream as any).events as Array<{ type: string }>;
    expect(events.some(e => e.type === 'text_end')).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
  });

  it('allows empty response for providers without onFinish (Qwen)', async () => {
    const stream = requestWebGeneration(defaultOpts);

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'start')).toBe(true);
    });

    // WEB_LLM_DONE with no content — Qwen adapter has no onFinish, so this is just empty done
    fireMessage({
      type: 'WEB_LLM_DONE',
      requestId: 'web-test-uuid',
    });

    const events = (stream as any).events as Array<{ type: string }>;
    expect(events.some(e => e.type === 'text_end')).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
  });

  it('emits error on WEB_LLM_ERROR', async () => {
    const stream = requestWebGeneration(defaultOpts);

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'start')).toBe(true);
    });

    fireMessage({
      type: 'WEB_LLM_ERROR',
      requestId: 'web-test-uuid',
      error: 'Connection refused',
    });

    const events = (stream as any).events as Array<{ type: string }>;
    expect(events.some(e => e.type === 'error')).toBe(true);
  });

  it('ignores messages with wrong requestId', async () => {
    const stream = requestWebGeneration(defaultOpts);

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'start')).toBe(true);
    });

    const eventsBefore = ((stream as any).events as unknown[]).length;

    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'wrong-uuid',
      chunk: 'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
    });

    const eventsAfter = ((stream as any).events as unknown[]).length;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('skips [DONE] SSE events', async () => {
    const stream = requestWebGeneration(defaultOpts);

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'start')).toBe(true);
    });

    const eventsBefore = ((stream as any).events as unknown[]).length;

    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk: 'data: [DONE]\n\n',
    });

    const eventsAfter = ((stream as any).events as unknown[]).length;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('handles tool_call in stream via XML parser', async () => {
    const stream = requestWebGeneration(defaultOpts);

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'start')).toBe(true);
    });

    // Send text with embedded tool_call XML
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk: 'data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"web_search\\",\\"arguments\\":{\\"query\\":\\"test\\"}}</tool_call>"}}]}\n\n',
    });

    const events = (stream as any).events as Array<{ type: string }>;
    expect(events.some(e => e.type === 'toolcall_start')).toBe(true);
    expect(events.some(e => e.type === 'toolcall_end')).toBe(true);
  });

  it('aborts stream early on native tool failure with shouldAbort', async () => {
    const stream = requestWebGeneration(defaultOpts);

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'start')).toBe(true);
    });

    // Send a native function_call followed by "Tool X does not exists" response.
    // The Qwen adapter's shouldAbort() will return true after this.
    // The bridge should emit done with reason='toolUse' without waiting for WEB_LLM_DONE.
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      // function_call event — adapter accumulates it
      chunk: 'data: {"choices":[{"delta":{"function_call":{"name":"list","arguments":"{}"}}}]}\n\n',
    });
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      // function response with "does not exist" — adapter converts to tool_call and sets shouldAbort
      chunk: 'data: {"choices":[{"delta":{"role":"function","content":"Tool list does not exists."}}]}\n\n',
    });

    const events = (stream as any).events as Array<{ type: string; reason?: string }>;
    // Should have tool_call events
    expect(events.some(e => e.type === 'toolcall_start')).toBe(true);
    expect(events.some(e => e.type === 'toolcall_end')).toBe(true);
    // Should have done with toolUse reason (early abort, no WEB_LLM_DONE needed)
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.reason).toBe('toolUse');

    // Subsequent chunks should be ignored (listener removed)
    const eventsBeforeExtra = events.length;
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk: 'data: {"choices":[{"delta":{"content":"this should be ignored"}}]}\n\n',
    });
    expect(events.length).toBe(eventsBeforeExtra);
  });

  it('suppresses text after tool_call (hallucinated tool_response summary)', async () => {
    const stream = requestWebGeneration(defaultOpts);

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'start')).toBe(true);
    });

    // Text before tool_call — should be emitted
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk: 'data: {"choices":[{"delta":{"content":"Let me check that for you."}}]}\n\n',
    });

    // Tool call
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk: 'data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"web_fetch\\",\\"arguments\\":{\\"url\\":\\"https://news.ycombinator.com\\"}}</tool_call>"}}]}\n\n',
    });

    // Hallucinated summary text after tool_call — should be suppressed
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk: 'data: {"choices":[{"delta":{"content":"Here are the top stories from Hacker News: 1. Fake story..."}}]}\n\n',
    });

    // Finish stream
    fireMessage({ type: 'WEB_LLM_DONE', requestId: 'web-test-uuid' });

    const events = (stream as any).events as Array<{ type: string; delta?: string; reason?: string }>;

    // Text before tool_call is preserved
    const textDeltas = events.filter(e => e.type === 'text_delta').map(e => e.delta);
    expect(textDeltas).toContain('Let me check that for you.');

    // Hallucinated summary is NOT present
    const allText = textDeltas.join('');
    expect(allText).not.toContain('Fake story');
    expect(allText).not.toContain('Here are the top stories');

    // Tool call is still emitted
    expect(events.some(e => e.type === 'toolcall_start')).toBe(true);
    expect(events.some(e => e.type === 'toolcall_end')).toBe(true);

    // Done with toolUse reason
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.reason).toBe('toolUse');
  });

  it('suppresses malformed tool_call after real tool_call', async () => {
    const stream = requestWebGeneration(defaultOpts);

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'start')).toBe(true);
    });

    // Real tool call
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk: 'data: {"choices":[{"delta":{"content":"<tool_call id=\\"abc\\" name=\\"browser\\">{\\"action\\":\\"open\\",\\"url\\":\\"https://example.com\\"}</tool_call>"}}]}\n\n',
    });

    // Malformed tool call (e.g. hallucinated browser.evaluate with broken JSON)
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk: 'data: {"choices":[{"delta":{"content":"<tool_call id=\\"xyz\\" name=\\"browser\\">{\\"action\\":\\"evaluate\\",\\"expression\\":\\"class Foo { #private = null; }</tool_call>"}}]}\n\n',
    });

    fireMessage({ type: 'WEB_LLM_DONE', requestId: 'web-test-uuid' });

    const events = (stream as any).events as Array<{ type: string; delta?: string }>;

    // Real tool call was emitted
    expect(events.some(e => e.type === 'toolcall_start')).toBe(true);

    // Malformed body should NOT leak into text
    const textDeltas = events.filter(e => e.type === 'text_delta').map(e => e.delta);
    const allText = textDeltas.join('');
    expect(allText).not.toContain('class Foo');
    expect(allText).not.toContain('#private');
  });

  it('does not promote thinking-only response without onFinish hook (Qwen)', async () => {
    const stream = requestWebGeneration(defaultOpts);

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'start')).toBe(true);
    });

    // Send response wrapped entirely in <think> tags
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk: 'data: {"choices":[{"delta":{"content":"<think>This is thinking content.</think>"}}]}\n\n',
    });

    fireMessage({ type: 'WEB_LLM_DONE', requestId: 'web-test-uuid' });

    const events = (stream as any).events as Array<{ type: string; delta?: string; content?: string }>;

    // Without onFinish hook, thinking is NOT promoted — text_end content is empty
    const textEnd = events.find(e => e.type === 'text_end');
    expect(textEnd).toBeDefined();
    expect(textEnd!.content).toBe('');

    // Thinking events are still emitted
    expect(events.some(e => e.type === 'thinking_start')).toBe(true);
    expect(events.some(e => e.type === 'thinking_end')).toBe(true);
  });

  it('emits error when provider is not found', async () => {
    const stream = requestWebGeneration({
      ...defaultOpts,
      modelConfig: { ...defaultModel, webProviderId: 'nonexistent' },
    });

    await vi.waitFor(() => {
      const events = (stream as any).events as Array<{ type: string }>;
      expect(events.some(e => e.type === 'error')).toBe(true);
    });
  });
});
