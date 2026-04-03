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
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('./auth', () => ({
  getWebCredential: vi.fn(async () => ({
    providerId: 'qwen-web',
    cookies: { token: 'test-token' },
    capturedAt: Date.now(),
  })),
  storeWebCredential: vi.fn(async () => {}),
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
    if (id === 'chatgpt-web') {
      return {
        id: 'chatgpt-web',
        name: 'ChatGPT (Web)',
        loginUrl: 'https://chatgpt.com',
        cookieDomain: '.chatgpt.com',
        sessionIndicators: ['__Secure-next-auth.session-token'],
        defaultModelId: 'auto',
        defaultModelName: 'GPT-5.3',
        supportsTools: true,
        supportsReasoning: true,
        contextWindow: 128_000,
        buildRequest: () => ({
          url: 'https://chatgpt.com/backend-api/conversation',
          binaryProtocol: 'chatgpt',
          init: { method: 'POST', body: '{}' },
        }),
        parseSseDelta: () => null,
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
    query: vi.fn(async (queryInfo: { active?: boolean; currentWindow?: boolean; url?: string }) => {
      // Return a different tab for "active tab" queries vs provider tab queries
      if (queryInfo.active && queryInfo.currentWindow) return [{ id: 99 }];
      return [{ id: 1 }];
    }),
    create: vi.fn(async () => ({ id: 1 })),
    update: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  scripting: {
    executeScript: vi.fn(async () => {}),
  },
  cookies: {
    getAll: vi.fn(async () => []),
  },
});

vi.stubGlobal('crypto', { randomUUID: () => 'web-test-uuid' });

import { requestWebGeneration } from './web-llm-bridge';
import { getWebCredential, storeWebCredential } from './auth';

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

const chatgptModel: ChatModel = {
  id: 'auto',
  name: 'GPT-5.3',
  provider: 'web',
  webProviderId: 'chatgpt-web',
};

const chatgptOpts = {
  modelConfig: chatgptModel,
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
      chunk:
        'data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"web_search\\",\\"arguments\\":{\\"query\\":\\"test\\"}}</tool_call>"}}]}\n\n',
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
      chunk:
        'data: {"choices":[{"delta":{"role":"function","content":"Tool list does not exists."}}]}\n\n',
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
      chunk:
        'data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"web_fetch\\",\\"arguments\\":{\\"url\\":\\"https://news.ycombinator.com\\"}}</tool_call>"}}]}\n\n',
    });

    // Hallucinated summary text after tool_call — should be suppressed
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk:
        'data: {"choices":[{"delta":{"content":"Here are the top stories from Hacker News: 1. Fake story..."}}]}\n\n',
    });

    // Finish stream
    fireMessage({ type: 'WEB_LLM_DONE', requestId: 'web-test-uuid' });

    const events = (stream as any).events as Array<{
      type: string;
      delta?: string;
      reason?: string;
    }>;

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
      chunk:
        'data: {"choices":[{"delta":{"content":"<tool_call id=\\"abc\\" name=\\"browser\\">{\\"action\\":\\"open\\",\\"url\\":\\"https://example.com\\"}</tool_call>"}}]}\n\n',
    });

    // Malformed tool call (e.g. hallucinated browser.evaluate with broken JSON)
    fireMessage({
      type: 'WEB_LLM_CHUNK',
      requestId: 'web-test-uuid',
      chunk:
        'data: {"choices":[{"delta":{"content":"<tool_call id=\\"xyz\\" name=\\"browser\\">{\\"action\\":\\"evaluate\\",\\"expression\\":\\"class Foo { #private = null; }</tool_call>"}}]}\n\n',
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
      chunk:
        'data: {"choices":[{"delta":{"content":"<think>This is thinking content.</think>"}}]}\n\n',
    });

    fireMessage({ type: 'WEB_LLM_DONE', requestId: 'web-test-uuid' });

    const events = (stream as any).events as Array<{
      type: string;
      delta?: string;
      content?: string;
    }>;

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

// ── ChatGPT-web specific tests ──────────────────────────

describe('requestWebGeneration — chatgpt-web inactivity handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.length = 0;
  });

  const mockChatgptCredential = (overrides: Record<string, unknown> = {}) => {
    vi.mocked(getWebCredential).mockResolvedValue({
      providerId: 'chatgpt-web',
      cookies: { '__Secure-next-auth.session-token': 'test-session' },
      capturedAt: Date.now(),
      ...overrides,
    });
  };

  describe('stale session refresh', () => {
    it('does NOT reload tab when lastRequestAt is recent', async () => {
      mockChatgptCredential({ lastRequestAt: Date.now() - 5 * 60_000 }); // 5 min ago
      requestWebGeneration(chatgptOpts);

      await vi.waitFor(() => {
        expect(chrome.scripting.executeScript).toHaveBeenCalled();
      });

      expect(chrome.tabs.reload).not.toHaveBeenCalled();
    });

    it('reloads tab when lastRequestAt is stale (> 10 min) and restores previous tab', async () => {
      mockChatgptCredential({ lastRequestAt: Date.now() - 15 * 60_000 }); // 15 min ago

      // When tabs.reload is called, simulate the tab completing load shortly after.
      // The production code registers the onUpdated listener BEFORE calling reload,
      // so the listener is already in place when this mock fires.
      vi.mocked(chrome.tabs.reload).mockImplementation(async () => {
        const addListenerCalls = vi.mocked(chrome.tabs.onUpdated.addListener).mock.calls;
        const lastListener = addListenerCalls[addListenerCalls.length - 1]?.[0] as
          | ((id: number, info: { status: string }) => void)
          | undefined;
        if (lastListener) {
          setTimeout(() => lastListener(1, { status: 'complete' }), 10);
        }
      });

      requestWebGeneration(chatgptOpts);

      // Wait for the full setup to complete (scripts injected — happens after tab restore).
      // The 5s hydration delay in waitForTabLoad means this takes >5s real time.
      await vi.waitFor(
        () => {
          expect(chrome.scripting.executeScript).toHaveBeenCalled();
        },
        { timeout: 10000 },
      );

      // Verify previous tab (id: 99) was restored after foregrounding
      const updateCalls = vi.mocked(chrome.tabs.update).mock.calls;
      // First call: foreground chatgpt tab (id: 1)
      expect(updateCalls).toContainEqual([1, { active: true }]);
      // Second call: restore previous tab (id: 99)
      expect(updateCalls).toContainEqual([99, { active: true }]);
    }, 15_000);

    it('reloads tab when lastRequestAt is missing (first request after login)', async () => {
      mockChatgptCredential({}); // no lastRequestAt

      vi.mocked(chrome.tabs.reload).mockImplementation(async () => {
        const addListenerCalls = vi.mocked(chrome.tabs.onUpdated.addListener).mock.calls;
        const lastListener = addListenerCalls[addListenerCalls.length - 1]?.[0] as
          | ((id: number, info: { status: string }) => void)
          | undefined;
        if (lastListener) {
          setTimeout(() => lastListener(1, { status: 'complete' }), 10);
        }
      });

      requestWebGeneration(chatgptOpts);

      await vi.waitFor(() => {
        expect(chrome.tabs.reload).toHaveBeenCalledWith(1);
      });
    });

    it('does NOT reload tab for non-chatgpt-web providers', async () => {
      // Use qwen-web with stale lastRequestAt
      vi.mocked(getWebCredential).mockResolvedValue({
        providerId: 'qwen-web',
        cookies: { token: 'test-token' },
        capturedAt: Date.now(),
        lastRequestAt: Date.now() - 60 * 60_000, // 1 hour ago — very stale
      });

      requestWebGeneration(defaultOpts); // defaultOpts uses qwen-web

      await vi.waitFor(() => {
        expect(chrome.scripting.executeScript).toHaveBeenCalled();
      });

      expect(chrome.tabs.reload).not.toHaveBeenCalled();
    });
  });

  describe('lastRequestAt tracking', () => {
    it('updates lastRequestAt on WEB_LLM_DONE for chatgpt-web', async () => {
      mockChatgptCredential({ lastRequestAt: Date.now() });

      requestWebGeneration(chatgptOpts);

      await vi.waitFor(() => {
        expect(listeners.length).toBeGreaterThan(0);
      });

      fireMessage({
        type: 'WEB_LLM_DONE',
        requestId: 'web-test-uuid',
      });

      // storeWebCredential is called asynchronously
      await vi.waitFor(() => {
        expect(storeWebCredential).toHaveBeenCalled();
      });

      const storedCred = vi.mocked(storeWebCredential).mock.calls[0]?.[0];
      expect(storedCred?.providerId).toBe('chatgpt-web');
      expect(storedCred?.lastRequestAt).toBeGreaterThan(0);
    });

    it('does NOT update lastRequestAt on WEB_LLM_DONE for non-chatgpt-web', async () => {
      // Using default qwen-web opts
      requestWebGeneration(defaultOpts);

      await vi.waitFor(() => {
        expect(listeners.length).toBeGreaterThan(0);
      });

      fireMessage({
        type: 'WEB_LLM_DONE',
        requestId: 'web-test-uuid',
      });

      // Give async handler time to run
      await new Promise(r => setTimeout(r, 50));

      // storeWebCredential should only be called by chatgpt-web
      const chatgptCalls = vi
        .mocked(storeWebCredential)
        .mock.calls.filter(
          c => c[0]?.providerId === 'qwen-web' && c[0]?.lastRequestAt !== undefined,
        );
      expect(chatgptCalls).toHaveLength(0);
    });
  });

  describe('metadata relay', () => {
    it('persists deviceId from WEB_LLM_METADATA for chatgpt-web', async () => {
      mockChatgptCredential({ metadata: {} });

      requestWebGeneration(chatgptOpts);

      await vi.waitFor(() => {
        expect(listeners.length).toBeGreaterThan(0);
      });

      fireMessage({
        type: 'WEB_LLM_METADATA',
        requestId: 'web-test-uuid',
        metadata: { deviceId: 'persistent-device-123' },
      });

      await vi.waitFor(() => {
        expect(storeWebCredential).toHaveBeenCalled();
      });

      const storedCred = vi.mocked(storeWebCredential).mock.calls[0]?.[0];
      expect(storedCred?.metadata?.deviceId).toBe('persistent-device-123');
    });

    it('ignores WEB_LLM_METADATA for non-chatgpt-web providers', async () => {
      requestWebGeneration(defaultOpts); // qwen-web

      await vi.waitFor(() => {
        expect(listeners.length).toBeGreaterThan(0);
      });

      fireMessage({
        type: 'WEB_LLM_METADATA',
        requestId: 'web-test-uuid',
        metadata: { deviceId: 'should-be-ignored' },
      });

      await new Promise(r => setTimeout(r, 50));

      // storeWebCredential should not be called for metadata from qwen-web
      const metadataCalls = vi
        .mocked(storeWebCredential)
        .mock.calls.filter(c => c[0]?.metadata?.deviceId === 'should-be-ignored');
      expect(metadataCalls).toHaveLength(0);
    });

    it('passes stored metadata as providerMetadata for chatgpt-web', async () => {
      mockChatgptCredential({
        metadata: { deviceId: 'stored-device-456' },
        lastRequestAt: Date.now(),
      });

      const stream = requestWebGeneration(chatgptOpts);

      // Wait for async setup to complete — either executeScript or an error
      await vi.waitFor(
        () => {
          const events = (stream as any).events as Array<{ type: string }>;
          const hasScript = vi.mocked(chrome.scripting.executeScript).mock.calls.length > 0;
          const hasError = events.some(e => e.type === 'error');
          expect(hasScript || hasError).toBe(true);
        },
        { timeout: 5000 },
      );

      // Check if there's an error
      const events = (stream as any).events as Array<{ type: string; error?: string }>;
      const errorEvent = events.find(e => e.type === 'error');
      if (errorEvent) {
        throw new Error(`Bridge setup errored: ${JSON.stringify(errorEvent)}`);
      }

      // Find the MAIN world script injection (second executeScript call)
      const calls = vi.mocked(chrome.scripting.executeScript).mock.calls;
      const mainWorldCall = calls.find(c => (c[0] as { world?: string }).world === 'MAIN');
      expect(mainWorldCall).toBeDefined();

      // The args should include the fetchRequest with providerMetadata
      const args = (mainWorldCall![0] as { args?: unknown[] }).args;
      const fetchRequest = args?.[0] as Record<string, unknown>;
      expect(fetchRequest?.providerMetadata).toEqual({ deviceId: 'stored-device-456' });
    });

    it('does NOT pass providerMetadata for non-chatgpt-web providers', async () => {
      requestWebGeneration(defaultOpts); // qwen-web

      await vi.waitFor(() => {
        expect(chrome.scripting.executeScript).toHaveBeenCalled();
      });

      const calls = vi.mocked(chrome.scripting.executeScript).mock.calls;
      const mainWorldCall = calls.find(c => (c[0] as { world?: string }).world === 'MAIN');
      expect(mainWorldCall).toBeDefined();

      const args = (mainWorldCall![0] as { args?: unknown[] }).args;
      const fetchRequest = args?.[0] as Record<string, unknown>;
      expect(fetchRequest?.providerMetadata).toBeUndefined();
    });
  });

  describe('retry with tab refresh', () => {
    it('reloads tab and re-injects on WEB_LLM_RETRY_REFRESH for chatgpt-web', async () => {
      mockChatgptCredential({ lastRequestAt: Date.now() });

      // Mock tabs.reload to simulate page load completion after a tick
      vi.mocked(chrome.tabs.reload).mockImplementation(async () => {
        setTimeout(() => {
          const addListenerCalls = vi.mocked(chrome.tabs.onUpdated.addListener).mock.calls;
          const lastListener = addListenerCalls[addListenerCalls.length - 1]?.[0] as
            | ((id: number, info: { status: string }) => void)
            | undefined;
          if (lastListener) {
            lastListener(1, { status: 'complete' });
          }
        }, 10);
      });

      requestWebGeneration(chatgptOpts);

      // Wait for initial setup to complete: the initial MAIN world script must be injected
      // before the retry handler can work, because activeTabId/activeProvider/activeFetchRequest
      // are set just before script injection (line ~686 in web-llm-bridge.ts).
      // We look for a MAIN call WITHOUT retryAttempt (the initial request).
      await vi.waitFor(
        () => {
          const calls = vi.mocked(chrome.scripting.executeScript).mock.calls;
          const initialMain = calls.find(c => {
            const opt = c[0] as { world?: string; args?: unknown[] };
            if (opt.world !== 'MAIN') return false;
            const req = opt.args?.[0] as Record<string, unknown> | undefined;
            return req?.retryAttempt === undefined;
          });
          expect(initialMain).toBeDefined();
        },
        { timeout: 5000 },
      );

      fireMessage({
        type: 'WEB_LLM_RETRY_REFRESH',
        requestId: 'web-test-uuid',
        diag: '[diag: retry=403; retry=tab-refresh-requested]',
      });

      // Wait for the retry to complete: look for a MAIN world call with retryAttempt set.
      // We can't use call counts because async work from prior tests may leak additional
      // executeScript calls into this test's mock (stale-session test has 5s hydration).
      await vi.waitFor(
        () => {
          const calls = vi.mocked(chrome.scripting.executeScript).mock.calls;
          const retryCall = calls.find(c => {
            const opt = c[0] as { world?: string; args?: unknown[] };
            if (opt.world !== 'MAIN') return false;
            const req = opt.args?.[0] as Record<string, unknown> | undefined;
            return req?.retryAttempt !== undefined;
          });
          expect(retryCall).toBeDefined();
        },
        { timeout: 10000 },
      );

      expect(chrome.tabs.reload).toHaveBeenCalledWith(1);

      // Verify retryAttempt is incremented in the re-injected request
      const calls = vi.mocked(chrome.scripting.executeScript).mock.calls;
      const retryMainCall = calls.find(c => {
        const opt = c[0] as { world?: string; args?: unknown[] };
        const req = opt.args?.[0] as Record<string, unknown> | undefined;
        return opt.world === 'MAIN' && req?.retryAttempt !== undefined;
      });
      const retryArgs = (retryMainCall![0] as { args?: unknown[] }).args;
      const retryRequest = retryArgs?.[0] as Record<string, unknown>;
      expect(retryRequest?.retryAttempt).toBe(1);
    }, 15_000);

    it('ignores WEB_LLM_RETRY_REFRESH for non-chatgpt-web providers', async () => {
      requestWebGeneration(defaultOpts); // qwen-web

      await vi.waitFor(() => {
        expect(listeners.length).toBeGreaterThan(0);
      });

      const reloadCountBefore = vi.mocked(chrome.tabs.reload).mock.calls.length;

      fireMessage({
        type: 'WEB_LLM_RETRY_REFRESH',
        requestId: 'web-test-uuid',
      });

      await new Promise(r => setTimeout(r, 50));

      expect(vi.mocked(chrome.tabs.reload).mock.calls.length).toBe(reloadCountBefore);
    });
  });
});
