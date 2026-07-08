import { getProvider } from './providers';
import {
  resolveTranscription,
  resolveOpenAIKey,
  detectBestEngine,
} from './resolve';
import { checkWebAuth } from '../web-providers/auth';
import { getSpeechPlugin } from '../web-providers/speech/plugin-registry';
import { sttConfigStorage, customModelsStorage } from '@extension/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttConfig } from '@extension/storage';

// Mock storage modules
vi.mock('@extension/storage', () => ({
  sttConfigStorage: {
    get: vi.fn(),
  },
  customModelsStorage: {
    get: vi.fn(),
  },
  logConfigStorage: {
    get: vi.fn().mockResolvedValue({ enabled: false, level: 'info' }),
    subscribe: vi.fn(),
  },
}));

// Mock the provider registry
vi.mock('./providers', () => ({
  getProvider: vi.fn(),
}));

// Mock the web-providers auth check
vi.mock('../web-providers/auth', () => ({
  checkWebAuth: vi.fn(),
}));

// Mock the speech plugin registry
vi.mock('../web-providers/speech/plugin-registry', () => ({
  getSpeechPlugin: vi.fn(),
}));

const mockSttConfig = sttConfigStorage as unknown as { get: ReturnType<typeof vi.fn> };
const mockModels = customModelsStorage as unknown as { get: ReturnType<typeof vi.fn> };
const mockGetProvider = getProvider as unknown as ReturnType<typeof vi.fn>;
const mockCheckWebAuth = checkWebAuth as unknown as ReturnType<typeof vi.fn>;
const mockGetSpeechPlugin = getSpeechPlugin as unknown as ReturnType<typeof vi.fn>;

const defaultConfig: SttConfig = {
  engine: 'transformers',
  openai: { apiKey: '', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
  language: 'en',
  localModel: 'tiny',
};

const audio = new ArrayBuffer(100);

// Helper: create a mock provider with a mock transcribe function
const createMockProvider = (id: string, result: string) => {
  const transcribe = vi.fn().mockResolvedValue(result);
  mockGetProvider.mockImplementation((engineId: string) =>
    engineId === id ? { id, transcribe } : undefined,
  );
  return transcribe;
};

describe('resolveTranscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto engine with OpenAI key available uses openai provider', async () => {
    mockSttConfig.get.mockResolvedValue({
      ...defaultConfig,
      engine: 'auto',
      openai: { apiKey: 'sk-test', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
    });
    const mockTranscribe = createMockProvider('openai', 'hello');

    const result = await resolveTranscription(audio, 'audio/ogg');
    expect(result).toBe('hello');
    expect(mockTranscribe).toHaveBeenCalledWith(audio, 'audio/ogg', {
      language: 'en',
      apiKey: 'sk-test',
      model: 'whisper-1',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('auto engine with no keys falls back to transformers provider', async () => {
    mockSttConfig.get.mockResolvedValue({ ...defaultConfig, engine: 'auto' });
    mockModels.get.mockResolvedValue([]);
    const mockTranscribe = createMockProvider('transformers', 'local transcript');

    const result = await resolveTranscription(audio, 'audio/ogg');
    expect(result).toBe('local transcript');
    expect(mockTranscribe).toHaveBeenCalledWith(audio, 'audio/ogg', {
      language: 'en',
      model: 'tiny',
    });
  });

  it('explicit openai engine uses openai provider', async () => {
    mockSttConfig.get.mockResolvedValue({
      ...defaultConfig,
      engine: 'openai',
      openai: { apiKey: 'sk-key', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
    });
    const mockTranscribe = createMockProvider('openai', 'openai result');

    const result = await resolveTranscription(audio, 'audio/ogg');
    expect(result).toBe('openai result');
    expect(mockTranscribe).toHaveBeenCalledWith(audio, 'audio/ogg', {
      language: 'en',
      apiKey: 'sk-key',
      model: 'whisper-1',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('explicit transformers engine uses transformers provider', async () => {
    mockSttConfig.get.mockResolvedValue({
      ...defaultConfig,
      engine: 'transformers',
    });
    const mockTranscribe = createMockProvider('transformers', 'transformers result');

    const result = await resolveTranscription(audio, 'audio/ogg');
    expect(result).toBe('transformers result');
    expect(mockTranscribe).toHaveBeenCalledWith(audio, 'audio/ogg', {
      language: 'en',
      model: 'tiny',
    });
  });

  it('explicit gemini-web engine uses gemini-web provider with only language', async () => {
    mockSttConfig.get.mockResolvedValue({
      ...defaultConfig,
      engine: 'gemini-web',
      // Even if an OpenAI key is present it must not leak into the options.
      openai: { apiKey: 'sk-should-not-be-used', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
      language: 'fr',
    });
    const mockTranscribe = createMockProvider('gemini-web', 'gemini transcript');

    const result = await resolveTranscription(audio, 'audio/ogg');
    expect(result).toBe('gemini transcript');
    // Zero-token engine: no apiKey, no model — only the language.
    expect(mockTranscribe).toHaveBeenCalledWith(audio, 'audio/ogg', { language: 'fr' });
    const passedOptions = mockTranscribe.mock.calls[0][2];
    expect(passedOptions).not.toHaveProperty('apiKey');
    expect(passedOptions).not.toHaveProperty('model');
  });

  it('custom localModel passes through to transformers provider', async () => {
    mockSttConfig.get.mockResolvedValue({
      ...defaultConfig,
      engine: 'transformers',
      localModel: 'base.en',
    });
    const mockTranscribe = createMockProvider('transformers', 'base result');

    const result = await resolveTranscription(audio, 'audio/ogg');
    expect(result).toBe('base result');
    expect(mockTranscribe).toHaveBeenCalledWith(audio, 'audio/ogg', {
      language: 'en',
      model: 'base.en',
    });
  });

  it('language passes through to openai provider', async () => {
    mockSttConfig.get.mockResolvedValue({
      ...defaultConfig,
      engine: 'openai',
      openai: { apiKey: 'sk-key', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
      language: 'zh',
    });
    const mockTranscribe = createMockProvider('openai', 'chinese result');

    const result = await resolveTranscription(audio, 'audio/ogg');
    expect(result).toBe('chinese result');
    expect(mockTranscribe).toHaveBeenCalledWith(audio, 'audio/ogg', {
      language: 'zh',
      apiKey: 'sk-key',
      model: 'whisper-1',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('language passes through to transformers provider', async () => {
    mockSttConfig.get.mockResolvedValue({
      ...defaultConfig,
      engine: 'transformers',
      language: 'ja',
    });
    const mockTranscribe = createMockProvider('transformers', 'japanese result');

    const result = await resolveTranscription(audio, 'audio/ogg');
    expect(result).toBe('japanese result');
    expect(mockTranscribe).toHaveBeenCalledWith(audio, 'audio/ogg', {
      language: 'ja',
      model: 'tiny',
    });
  });

  it('auto + openai throws -> falls back to transformers', async () => {
    mockSttConfig.get.mockResolvedValue({
      ...defaultConfig,
      engine: 'auto',
      openai: { apiKey: 'sk-test', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
    });
    const openaiTranscribe = vi.fn().mockRejectedValue(new Error('OpenAI STT failed (404): nope'));
    const localTranscribe = vi.fn().mockResolvedValue('local fallback');
    mockGetProvider.mockImplementation((engineId: string) =>
      engineId === 'openai'
        ? { id: 'openai', transcribe: openaiTranscribe }
        : engineId === 'transformers'
          ? { id: 'transformers', transcribe: localTranscribe }
          : undefined,
    );

    const result = await resolveTranscription(audio, 'audio/ogg');
    expect(result).toBe('local fallback');
    expect(openaiTranscribe).toHaveBeenCalled();
    expect(localTranscribe).toHaveBeenCalledWith(audio, 'audio/ogg', {
      language: 'en',
      model: 'tiny',
    });
  });

  it('explicit openai throws -> propagates (no fallback)', async () => {
    mockSttConfig.get.mockResolvedValue({
      ...defaultConfig,
      engine: 'openai',
      openai: { apiKey: 'sk-test', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
    });
    const openaiTranscribe = vi.fn().mockRejectedValue(new Error('OpenAI STT failed (404): nope'));
    const localTranscribe = vi.fn().mockResolvedValue('local fallback');
    mockGetProvider.mockImplementation((engineId: string) =>
      engineId === 'openai'
        ? { id: 'openai', transcribe: openaiTranscribe }
        : engineId === 'transformers'
          ? { id: 'transformers', transcribe: localTranscribe }
          : undefined,
    );

    await expect(resolveTranscription(audio, 'audio/ogg')).rejects.toThrow(
      'OpenAI STT failed (404): nope',
    );
    expect(localTranscribe).not.toHaveBeenCalled();
  });

  it('throws when engine is off', async () => {
    mockSttConfig.get.mockResolvedValue({
      ...defaultConfig,
      engine: 'off',
    });

    await expect(resolveTranscription(audio, 'audio/ogg')).rejects.toThrow(
      'Audio transcription is disabled',
    );
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('throws for unknown engine', async () => {
    mockSttConfig.get.mockResolvedValue({
      ...defaultConfig,
      engine: 'transformers',
    });
    mockGetProvider.mockReturnValue(undefined);

    await expect(resolveTranscription(audio, 'audio/ogg')).rejects.toThrow(
      'Unknown media engine: transformers',
    );
  });
});

describe('resolveOpenAIKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns explicit STT key first', async () => {
    const config: SttConfig = {
      ...defaultConfig,
      openai: { apiKey: 'sk-stt-key', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
    };
    const key = await resolveOpenAIKey(config);
    expect(key).toBe('sk-stt-key');
  });

  it('falls back to first OpenAI model key', async () => {
    mockModels.get.mockResolvedValue([
      { provider: 'anthropic', apiKey: 'ant-key' },
      { provider: 'openai', apiKey: 'sk-model-key' },
    ]);
    const key = await resolveOpenAIKey(defaultConfig);
    expect(key).toBe('sk-model-key');
  });

  it('throws when no key is available', async () => {
    mockModels.get.mockResolvedValue([]);
    await expect(resolveOpenAIKey(defaultConfig)).rejects.toThrow(
      'No API key available for OpenAI STT',
    );
  });
});

describe('detectBestEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns openai when key is available', async () => {
    mockModels.get.mockResolvedValue([{ provider: 'openai', apiKey: 'sk-test' }]);
    const engine = await detectBestEngine(defaultConfig);
    expect(engine).toBe('openai');
  });

  it('returns transformers when no key is available', async () => {
    mockModels.get.mockResolvedValue([]);
    const engine = await detectBestEngine(defaultConfig);
    expect(engine).toBe('transformers');
  });

  it('never auto-selects gemini-web (session-riding engine is opt-in only)', async () => {
    // With a key → openai; without → transformers. gemini-web must never be the
    // auto choice because it silently rides the user's logged-in Gemini session.
    mockModels.get.mockResolvedValue([{ provider: 'openai', apiKey: 'sk-test' }]);
    expect(await detectBestEngine(defaultConfig)).not.toBe('gemini-web');
    mockModels.get.mockResolvedValue([]);
    expect(await detectBestEngine(defaultConfig)).not.toBe('gemini-web');
  });
});

describe('gemini-web pre-flight auth gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const geminiConfig: SttConfig = {
    ...defaultConfig,
    engine: 'gemini-web',
    language: 'en',
  };

  const fakePlugin = {
    definition: {
      id: 'gemini-web',
      name: 'Gemini (browser session)',
      cookieDomain: '.google.com',
      sessionIndicators: ['__Secure-1PSID', 'SAPISID'],
      loginUrl: 'https://gemini.google.com',
    },
  };

  it('rejects with actionable message when not logged in', async () => {
    mockSttConfig.get.mockResolvedValue(geminiConfig);
    mockGetSpeechPlugin.mockReturnValue(fakePlugin);
    mockCheckWebAuth.mockResolvedValue('not-logged-in');
    createMockProvider('gemini-web', 'should not reach');

    await expect(resolveTranscription(audio, 'audio/ogg')).rejects.toThrow(
      'Sign in to Gemini to use browser STT',
    );
  });

  it('rejects with actionable message when session expired', async () => {
    mockSttConfig.get.mockResolvedValue(geminiConfig);
    mockGetSpeechPlugin.mockReturnValue(fakePlugin);
    mockCheckWebAuth.mockResolvedValue('expired');
    createMockProvider('gemini-web', 'should not reach');

    await expect(resolveTranscription(audio, 'audio/ogg')).rejects.toThrow(
      'Sign in to Gemini to use browser STT',
    );
  });

  it('proceeds to transcription when logged in', async () => {
    mockSttConfig.get.mockResolvedValue(geminiConfig);
    mockGetSpeechPlugin.mockReturnValue(fakePlugin);
    mockCheckWebAuth.mockResolvedValue('logged-in');
    const mockTranscribe = createMockProvider('gemini-web', 'gemini result');

    const result = await resolveTranscription(audio, 'audio/ogg');
    expect(result).toBe('gemini result');
    expect(mockTranscribe).toHaveBeenCalled();
  });

  it('proceeds when speech plugin is not registered (no gate)', async () => {
    mockSttConfig.get.mockResolvedValue(geminiConfig);
    mockGetSpeechPlugin.mockReturnValue(undefined);
    const mockTranscribe = createMockProvider('gemini-web', 'no-gate result');

    const result = await resolveTranscription(audio, 'audio/ogg');
    expect(result).toBe('no-gate result');
    expect(mockCheckWebAuth).not.toHaveBeenCalled();
    expect(mockTranscribe).toHaveBeenCalled();
  });
});
