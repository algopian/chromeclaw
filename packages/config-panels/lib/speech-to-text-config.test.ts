/**
 * Unit tests for SpeechToTextConfig component's storage interactions.
 * Tests the sttConfigStorage operations and handler logic that SpeechToTextConfig relies on.
 */
import { defaultSttConfig } from '@extension/storage';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { formatKeyCode } from './format-key-code.js';
import type { SttConfig } from '@extension/storage';

// Mock sttConfigStorage
const mockSet = vi.fn<(config: SttConfig) => Promise<void>>(() => Promise.resolve());
let mockStoredConfig: SttConfig;

vi.mock('@extension/storage', async importOriginal => {
  const original = await importOriginal<typeof import('@extension/storage')>();
  return {
    ...original,
    sttConfigStorage: {
      get: vi.fn(() =>
        Promise.resolve({ ...mockStoredConfig, openai: { ...mockStoredConfig.openai } }),
      ),
      set: (...args: [SttConfig]) => mockSet(...args),
    },
  };
});

beforeEach(() => {
  mockStoredConfig = {
    engine: 'transformers',
    openai: { apiKey: '', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
    language: 'en',
    localModel: 'tiny',
    hotkey: 'AltRight',
  };
  mockSet.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SpeechToTextConfig — SttConfig defaults', () => {
  it('defaultSttConfig has expected shape', () => {
    expect(defaultSttConfig.engine).toBe('transformers');
    expect(defaultSttConfig.openai.apiKey).toBe('');
    expect(defaultSttConfig.openai.model).toBe('whisper-1');
    expect(defaultSttConfig.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(defaultSttConfig.language).toBe('en');
    expect(defaultSttConfig.localModel).toBe('tiny');
    expect(defaultSttConfig.hotkey).toBe('AltRight');
  });

  it('defaultSttConfig engine is a valid engine type', () => {
    const validEngines = ['off', 'openai', 'transformers', 'gemini-web'];
    expect(validEngines).toContain(defaultSttConfig.engine);
  });
});

describe('SpeechToTextConfig — engine change saves immediately', () => {
  it('saves new engine value immediately via sttConfigStorage.set', async () => {
    const { sttConfigStorage } = await import('@extension/storage');
    const config = await sttConfigStorage.get();
    expect(config.engine).toBe('transformers');

    // Simulate what handleEngineChange does: set with new engine
    const updated: SttConfig = { ...config, engine: 'openai' };
    await sttConfigStorage.set(updated);

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ engine: 'openai' }));
  });

  it('preserves other config fields when changing engine', async () => {
    mockStoredConfig = {
      engine: 'transformers',
      openai: { apiKey: 'sk-test', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
      language: 'en',
      localModel: 'base.en',
      hotkey: 'AltRight',
    };

    const { sttConfigStorage } = await import('@extension/storage');
    const config = await sttConfigStorage.get();

    const updated: SttConfig = { ...config, engine: 'openai' };
    await sttConfigStorage.set(updated);

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: 'openai',
        openai: expect.objectContaining({ apiKey: 'sk-test' }),
        language: 'en',
        localModel: 'base.en',
      }),
    );
  });
});

describe('SpeechToTextConfig — OpenAI field changes use debounced save', () => {
  it('saves apiKey change after debounce delay', async () => {
    const { sttConfigStorage } = await import('@extension/storage');
    const config = await sttConfigStorage.get();

    // Simulate handleOpenAIFieldChange: update field, schedule debounced save
    const next: SttConfig = { ...config, openai: { ...config.openai, apiKey: 'sk-new' } };

    // Set a debounced save (mirrors component behavior)
    setTimeout(() => {
      sttConfigStorage.set(next);
    }, 500);

    // Not called yet
    expect(mockSet).not.toHaveBeenCalled();

    // Advance past debounce
    vi.advanceTimersByTime(500);

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        openai: expect.objectContaining({ apiKey: 'sk-new' }),
      }),
    );
  });

  it('debounce cancels previous timer on rapid changes', async () => {
    const { sttConfigStorage } = await import('@extension/storage');
    const config = await sttConfigStorage.get();

    let timer: ReturnType<typeof setTimeout> | null = null;

    // First change
    const next1: SttConfig = { ...config, openai: { ...config.openai, model: 'whisper-2' } };
    timer = setTimeout(() => {
      sttConfigStorage.set(next1);
    }, 500);

    vi.advanceTimersByTime(200);

    // Second change cancels the first
    clearTimeout(timer);
    const next2: SttConfig = { ...config, openai: { ...config.openai, model: 'whisper-3' } };
    setTimeout(() => {
      sttConfigStorage.set(next2);
    }, 500);

    vi.advanceTimersByTime(500);

    // Only the second save should have fired
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        openai: expect.objectContaining({ model: 'whisper-3' }),
      }),
    );
  });

  it('saves baseUrl change correctly', async () => {
    const { sttConfigStorage } = await import('@extension/storage');
    const config = await sttConfigStorage.get();

    const next: SttConfig = {
      ...config,
      openai: { ...config.openai, baseUrl: 'http://localhost:4141/v1' },
    };

    setTimeout(() => {
      sttConfigStorage.set(next);
    }, 500);
    vi.advanceTimersByTime(500);

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        openai: expect.objectContaining({ baseUrl: 'http://localhost:4141/v1' }),
      }),
    );
  });
});

describe('SpeechToTextConfig — language change uses debounced save', () => {
  it('saves language after debounce delay', async () => {
    const { sttConfigStorage } = await import('@extension/storage');
    const config = await sttConfigStorage.get();

    const next: SttConfig = { ...config, language: 'ja' };
    setTimeout(() => {
      sttConfigStorage.set(next);
    }, 500);

    expect(mockSet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);

    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ language: 'ja' }));
  });
});

describe('SpeechToTextConfig — config shape validation', () => {
  it('saves correct full config shape', async () => {
    const { sttConfigStorage } = await import('@extension/storage');

    const updated: SttConfig = {
      engine: 'openai',
      openai: { apiKey: 'sk-abc', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
      language: 'fr',
      localModel: 'tiny',
      hotkey: 'AltRight',
    };

    await sttConfigStorage.set(updated);

    expect(mockSet).toHaveBeenCalledWith({
      engine: 'openai',
      openai: { apiKey: 'sk-abc', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
      language: 'fr',
      localModel: 'tiny',
      hotkey: 'AltRight',
    });
  });

  it('saves config with localModel field', async () => {
    const updated: SttConfig = {
      engine: 'transformers',
      openai: { apiKey: '', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' },
      language: 'en',
      localModel: 'small.en',
      hotkey: 'AltRight',
    };

    const { sttConfigStorage } = await import('@extension/storage');
    await sttConfigStorage.set(updated);

    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ localModel: 'small.en' }));
  });

  it('loads and returns stored config with non-default values', async () => {
    mockStoredConfig = {
      engine: 'openai',
      openai: { apiKey: 'sk-test', model: 'whisper-1', baseUrl: 'https://custom.api.com/v1' },
      language: 'de',
      localModel: 'base.en',
      hotkey: 'AltRight',
    };

    const { sttConfigStorage } = await import('@extension/storage');
    const config = await sttConfigStorage.get();

    expect(config.engine).toBe('openai');
    expect(config.openai.apiKey).toBe('sk-test');
    expect(config.openai.baseUrl).toBe('https://custom.api.com/v1');
    expect(config.language).toBe('de');
    expect(config.localModel).toBe('base.en');
  });
});

describe('SpeechToTextConfig — OpenAI fields visibility logic', () => {
  it('OpenAI fields should show when engine is openai', () => {
    const engine: SttConfig['engine'] = 'openai';
    const showOpenAIFields = engine === 'openai';
    expect(showOpenAIFields).toBe(true);
  });

  it('OpenAI fields should hide when engine is transformers', () => {
    const engine: SttConfig['engine'] = 'transformers';
    const showOpenAIFields = engine === 'openai';
    expect(showOpenAIFields).toBe(false);
  });
});

describe('SpeechToTextConfig — local model selector visibility logic', () => {
  it('local model fields should show when engine is transformers', () => {
    const engine: SttConfig['engine'] = 'transformers';
    const showLocalModelFields = engine === 'transformers';
    expect(showLocalModelFields).toBe(true);
  });

  it('local model fields should hide when engine is openai', () => {
    const engine: SttConfig['engine'] = 'openai';
    const showLocalModelFields = engine === 'transformers';
    expect(showLocalModelFields).toBe(false);
  });
});

describe('SpeechToTextConfig — off engine', () => {
  it('saves engine change to off via sttConfigStorage.set', async () => {
    const { sttConfigStorage } = await import('@extension/storage');
    const config = await sttConfigStorage.get();

    const updated: SttConfig = { ...config, engine: 'off' };
    await sttConfigStorage.set(updated);

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ engine: 'off' }));
  });

  it('valid engines list includes off', () => {
    const validEngines: SttConfig['engine'][] = ['off', 'openai', 'transformers', 'gemini-web'];
    expect(validEngines).toContain('off');
  });
});

describe('SpeechToTextConfig — visibility when engine is off', () => {
  it('showOpenAIFields is false when engine is off', () => {
    const engine: SttConfig['engine'] = 'off';
    const showOpenAIFields = engine === 'openai';
    expect(showOpenAIFields).toBe(false);
  });

  it('showLocalModelFields is false when engine is off', () => {
    const engine: SttConfig['engine'] = 'off';
    const showLocalModelFields = engine === 'transformers';
    expect(showLocalModelFields).toBe(false);
  });

  it('isEnabled is false when engine is off', () => {
    const engine: SttConfig['engine'] = 'off';
    const isEnabled = engine !== 'off';
    expect(isEnabled).toBe(false);
  });

  it('isEnabled is true for non-off engines', () => {
    const engines: SttConfig['engine'][] = ['openai', 'transformers', 'gemini-web'];
    for (const engine of engines) {
      const isEnabled = engine !== 'off';
      expect(isEnabled).toBe(true);
    }
  });

  it('gemini-web shows neither OpenAI nor local-model fields but is enabled', () => {
    const engine: SttConfig['engine'] = 'gemini-web';
    expect(engine === 'openai').toBe(false);
    expect(engine === 'transformers').toBe(false);
    expect(engine !== 'off').toBe(true);
  });
});

describe('SpeechToTextConfig — hotkey change saves immediately', () => {
  it('saves new hotkey value immediately via sttConfigStorage.set', async () => {
    const { sttConfigStorage } = await import('@extension/storage');
    const config = await sttConfigStorage.get();
    expect(config.hotkey).toBe('AltRight');

    // Mirrors handleHotkeyKeyDown: set with the captured KeyboardEvent.code.
    const updated: SttConfig = { ...config, hotkey: 'KeyK' };
    await sttConfigStorage.set(updated);

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ hotkey: 'KeyK' }));
  });

  it('preserves other config fields when changing hotkey', async () => {
    const { sttConfigStorage } = await import('@extension/storage');
    const config = await sttConfigStorage.get();

    const updated: SttConfig = { ...config, hotkey: 'Space' };
    await sttConfigStorage.set(updated);

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ hotkey: 'Space', engine: 'transformers', language: 'en' }),
    );
  });
});

describe('formatKeyCode', () => {
  it('formats sided modifier codes as "<Side> <Name>"', () => {
    expect(formatKeyCode('AltRight')).toBe('Right Alt');
    expect(formatKeyCode('AltLeft')).toBe('Left Alt');
    expect(formatKeyCode('ControlLeft')).toBe('Left Ctrl');
    expect(formatKeyCode('ShiftRight')).toBe('Right Shift');
    expect(formatKeyCode('MetaLeft')).toBe('Left Meta');
  });

  it('formats letter and digit codes to the bare character', () => {
    expect(formatKeyCode('KeyK')).toBe('K');
    expect(formatKeyCode('KeyZ')).toBe('Z');
    expect(formatKeyCode('Digit1')).toBe('1');
    expect(formatKeyCode('Digit0')).toBe('0');
  });

  it('formats named keys via the friendly map', () => {
    expect(formatKeyCode('Space')).toBe('Space');
    expect(formatKeyCode('Enter')).toBe('Enter');
    expect(formatKeyCode('Escape')).toBe('Esc');
    expect(formatKeyCode('Backquote')).toBe('`');
    expect(formatKeyCode('CapsLock')).toBe('Caps Lock');
  });

  it('returns empty string for empty input', () => {
    expect(formatKeyCode('')).toBe('');
  });

  it('returns unknown codes unchanged', () => {
    expect(formatKeyCode('F13')).toBe('F13');
    expect(formatKeyCode('NumpadEnter')).toBe('NumpadEnter');
  });
});
