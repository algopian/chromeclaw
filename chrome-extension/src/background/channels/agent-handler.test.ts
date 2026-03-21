import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Chrome API mock — must be defined before module import ──
beforeAll(() => {
  Object.defineProperty(globalThis, 'chrome', {
    value: {
      alarms: { create: vi.fn(), clear: vi.fn() },
      runtime: {
        sendMessage: vi.fn(async () => ({})),
        getURL: vi.fn(() => 'chrome-extension://id/icon.png'),
      },
      notifications: { create: vi.fn() },
    },
    writable: true,
  });
});

// ── Dependency mocks ──
vi.mock('./config', () => ({
  updateChannelConfig: vi.fn(async () => {}),
}));
vi.mock('./telegram/bot-api', () => ({
  sendChatAction: vi.fn(async () => {}),
  sendHtmlMessage: vi.fn(async () => 1),
  editMessageText: vi.fn(async () => {}),
  getFile: vi.fn(async () => ({ filePath: 'test.ogg' })),
  downloadFile: vi.fn(async () => new ArrayBuffer(0)),
  setMessageReaction: vi.fn(async () => {}),
  removeMessageReaction: vi.fn(async () => {}),
  sendVoiceMessage: vi.fn(async () => {}),
  sendAudioMessage: vi.fn(async () => {}),
  formatTelegramHtml: vi.fn((t: string) => t),
  MAX_TG_MESSAGE_LENGTH: 4096,
}));
vi.mock('../agents/agent-setup', () => ({
  dbModelToChatModel: vi.fn(
    (m: { modelId: string; name: string; provider: string; apiKey: string }) => ({
      id: m.modelId,
      name: m.name,
      provider: m.provider,
      routingMode: 'direct',
      apiKey: m.apiKey,
    }),
  ),
  runAgent: vi.fn(async () => ({
    responseText: 'Test response',
    parts: [{ type: 'text', text: 'Test response' }],
    usage: { inputTokens: 10, outputTokens: 20 },
    error: undefined,
    stepCount: 1,
    timedOut: false,
    retryAttempts: 0,
  })),
}));
vi.mock('../context/history-sanitization', () => ({
  sanitizeHistory: vi.fn((msgs: unknown[]) => msgs),
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
vi.mock('../media-understanding', () => ({
  resolveTranscription: vi.fn(async () => 'transcribed text'),
}));
vi.mock('../agents/message-adapter', () => ({
  chatMessagesToPiMessages: vi.fn(
    (msgs: Array<{ role: string; parts?: Array<{ text?: string }> }>) =>
      msgs.map(m => ({ role: m.role, content: m.parts?.[0]?.text || '', timestamp: Date.now() })),
  ),
  convertToLlm: vi.fn((msgs: unknown[]) => msgs),
  makeConvertToLlm: vi.fn(() => (msgs: unknown[]) => msgs),
}));
vi.mock('../context/transform', () => ({
  createTransformContext: vi.fn(() => ({
    transformContext: vi.fn(async (msgs: unknown[]) => msgs),
    getResult: () => ({ wasCompacted: false }),
  })),
}));
vi.mock('../tts', () => ({
  maybeApplyTtsBatchedStream: vi.fn(async () => {}),
}));
vi.mock('../tools', () => ({
  getToolConfig: vi.fn(async () => ({ enabledTools: [] })),
  getImplementedToolNames: vi.fn(() => new Set<string>()),
}));
vi.mock('@extension/shared', () => ({
  buildSystemPrompt: vi.fn(() => ({ text: 'system prompt' })),
  resolveToolPromptHints: vi.fn(() => []),
  resolveToolListings: vi.fn(() => []),
}));
vi.mock('@extension/storage', () => ({
  createChat: vi.fn(async () => {}),
  addMessage: vi.fn(async () => {}),
  getMessagesByChatId: vi.fn(async () => []),
  findChatByChannelChatId: vi.fn(async () => null),
  touchChat: vi.fn(async () => {}),
  updateSessionTokens: vi.fn(async () => {}),
  customModelsStorage: {
    get: vi.fn(async () => [
      { id: 'test', modelId: 'gpt-4o', name: 'GPT-4o', provider: 'openai', apiKey: 'sk-test' },
    ]),
  },
  selectedModelStorage: { get: vi.fn(async () => 'gpt-4o') },
  activeAgentStorage: { get: vi.fn(async () => 'main') },
  getAgent: vi.fn(async () => undefined),
  getEnabledWorkspaceFiles: vi.fn(async () => []),
  getEnabledSkills: vi.fn(async () => []),
  ttsConfigStorage: { get: vi.fn(async () => ({ engine: 'off', autoMode: 'off' })) },
}));
vi.mock('nanoid', () => ({ nanoid: () => 'test-nano-id' }));

import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelInboundMessage,
} from './types';

// ── Helper factories ──

const createMockAdapter = (): ChannelAdapter => ({
  id: 'telegram',
  label: 'Telegram',
  maxMessageLength: 4096,
  validateAuth: vi.fn(async () => ({ valid: true })),
  sendMessage: vi.fn(async () => ({ ok: true, messageId: '1' })),
  formatSenderDisplay: vi.fn(() => 'TestUser'),
});

const createMockConfig = (overrides: Partial<ChannelConfig> = {}): ChannelConfig => ({
  channelId: 'telegram',
  enabled: true,
  allowedSenderIds: ['123'],
  status: 'passive',
  credentials: { botToken: '123:abc' },
  ...overrides,
});

const createMockMessage = (
  overrides: Partial<ChannelInboundMessage> = {},
): ChannelInboundMessage => ({
  channelChatId: '456',
  senderId: '123',
  body: 'Hello',
  timestamp: Date.now(),
  chatType: 'direct',
  ...overrides,
});

describe('agent-handler', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let handleChannelMessage: any;
  let resolveModel: any;
  let runAgent: any;
  let customModelsStorage: any;
  let selectedModelStorage: any;
  let createChat: any;
  let addMessage: any;
  let findChatByChannelChatId: any;
  let getMessagesByChatId: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    vi.clearAllMocks();

    const mod = await import('./agent-handler');
    handleChannelMessage = mod.handleChannelMessage;
    resolveModel = mod.resolveModel;

    const agentSetup = await import('../agents/agent-setup');
    runAgent = agentSetup.runAgent;

    const storage = await import('@extension/storage');
    customModelsStorage = storage.customModelsStorage;
    selectedModelStorage = storage.selectedModelStorage;
    createChat = storage.createChat;
    addMessage = storage.addMessage;
    findChatByChannelChatId = storage.findChatByChannelChatId;
    getMessagesByChatId = storage.getMessagesByChatId;
  });

  // ── resolveModel ──

  describe('resolveModel', () => {
    it('returns model from config.modelId override', async () => {
      const config = createMockConfig({ modelId: 'test' });

      const model = await resolveModel(config);

      expect(model).toBeDefined();
      expect(model?.id).toBe('gpt-4o');
      expect(model?.provider).toBe('openai');
    });

    it('falls back to selected model when config.modelId is not set', async () => {
      const config = createMockConfig(); // no modelId

      const model = await resolveModel(config);

      expect(model).toBeDefined();
      expect(model?.id).toBe('gpt-4o');
      expect(vi.mocked(selectedModelStorage.get)).toHaveBeenCalled();
    });

    it('returns null when no models are configured', async () => {
      vi.mocked(customModelsStorage.get).mockResolvedValueOnce([]);
      const config = createMockConfig();

      const model = await resolveModel(config);

      expect(model).toBeNull();
    });
  });

  // ── handleChannelMessage ──

  describe('handleChannelMessage', () => {
    it('sends error message when no model is configured', async () => {
      vi.mocked(customModelsStorage.get).mockResolvedValueOnce([]);
      const adapter = createMockAdapter();
      const config = createMockConfig();
      const msg = createMockMessage();

      await handleChannelMessage(msg, adapter, config);

      expect(adapter.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '456',
          text: expect.stringContaining('No AI model is configured'),
        }),
      );
    });

    it('creates chat and saves user message', async () => {
      const adapter = createMockAdapter();
      const config = createMockConfig();
      const msg = createMockMessage({ body: 'Test user message' });

      // findChatByChannelChatId returns null, so a new chat should be created
      vi.mocked(findChatByChannelChatId).mockResolvedValueOnce(null);

      await handleChannelMessage(msg, adapter, config);

      // Chat should be created
      expect(createChat).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-nano-id',
          source: 'telegram',
          channelMeta: expect.objectContaining({
            channelId: 'telegram',
            chatId: '456',
            senderId: '123',
          }),
        }),
      );

      // User message should be saved
      expect(addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          parts: [{ type: 'text', text: 'Test user message' }],
        }),
      );
    });

    it('runs agent and sends response', async () => {
      const adapter = createMockAdapter();
      const config = createMockConfig();
      const msg = createMockMessage();

      // getMessagesByChatId must return the user message so the agent handler
      // can find a promptMessage (it reads from DB after saving)
      vi.mocked(getMessagesByChatId).mockResolvedValueOnce([
        {
          id: 'test-nano-id',
          chatId: 'test-nano-id',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
          createdAt: Date.now(),
        },
      ]);

      await handleChannelMessage(msg, adapter, config);

      // Agent should have been called with the system prompt directly (no concatenation)
      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: 'system prompt',
        }),
      );

      // buildSystemPrompt should have been called with extraContext containing channel addendum
      const { buildSystemPrompt } = await import('@extension/shared');
      expect(buildSystemPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          extraContext: expect.stringContaining('Telegram'),
        }),
      );

      // Response should be sent via the adapter (since draft.everSent is false
      // when no draft edits were triggered)
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '456',
          text: 'Test response',
        }),
      );
    });
  });
});
