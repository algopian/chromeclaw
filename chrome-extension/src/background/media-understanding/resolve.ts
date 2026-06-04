import { DEFAULT_LOCAL_MODEL } from './defaults';
import { getProvider } from './providers';
import { createLogger } from '../logging/logger-buffer';
import { sttConfigStorage, customModelsStorage } from '@extension/storage';
import type { MediaEngine, TranscribeOptions } from './types';
import type { SttConfig } from '@extension/storage';

const log = createLogger('media');

/** Pick the best engine based on config and available credentials. */
const resolveTranscription = async (audio: ArrayBuffer, mimeType: string): Promise<string> => {
  const config = await sttConfigStorage.get();

  if (config.engine === 'off') {
    throw new Error('Audio transcription is disabled');
  }

  const engine: MediaEngine =
    config.engine === 'auto' ? await detectBestEngine(config) : config.engine;

  const provider = getProvider(engine);
  if (!provider) throw new Error(`Unknown media engine: ${engine}`);

  const options: TranscribeOptions = { language: config.language };

  if (engine === 'openai') {
    options.apiKey = await resolveOpenAIKey(config);
    options.model = config.openai.model;
    options.baseUrl = config.openai.baseUrl;
    options.apiVersion = config.openai.apiVersion;
  } else {
    options.model = config.localModel || DEFAULT_LOCAL_MODEL;
  }

  log.debug('resolveTranscription', {
    engine,
    configEngine: config.engine,
    language: config.language,
    localModel: config.localModel,
    optionsModel: options.model,
    optionsLanguage: options.language,
    baseUrl: engine === 'openai' ? config.openai.baseUrl : undefined,
    apiVersion: engine === 'openai' ? config.openai.apiVersion : undefined,
    hasKey: engine === 'openai' ? Boolean(options.apiKey) : undefined,
  });

  try {
    return await provider.transcribe(audio, mimeType, options);
  } catch (err) {
    // In auto mode, a cloud (openai) failure should fall back to local Whisper
    // once before surfacing the error. When the user explicitly picked `openai`,
    // propagate so a misconfigured endpoint surfaces loudly.
    if (config.engine === 'auto' && engine === 'openai') {
      const local = getProvider('transformers');
      if (local) {
        log.warn('openai STT failed, falling back to transformers', {
          error: String(err),
        });
        return local.transcribe(audio, mimeType, {
          language: config.language,
          model: config.localModel || DEFAULT_LOCAL_MODEL,
        });
      }
    }
    throw err;
  }
};

/** Auto-detect the best available engine. */
const detectBestEngine = async (config: SttConfig): Promise<MediaEngine> => {
  // Prefer cloud if an API key is reachable
  try {
    await resolveOpenAIKey(config);
    return 'openai';
  } catch {
    // No key available — fall through to local
  }

  // transformers works without SharedArrayBuffer
  return 'transformers';
};

/** Resolve an OpenAI-compatible API key from multiple sources. */
const resolveOpenAIKey = async (config: SttConfig): Promise<string> => {
  // 1. Explicit STT key takes priority
  if (config.openai.apiKey) return config.openai.apiKey;

  // 2. Reuse first OpenAI model's API key from model configs
  const models = await customModelsStorage.get();
  const openaiModel = models?.find(m => m.provider === 'openai' && m.apiKey);
  if (openaiModel?.apiKey) return openaiModel.apiKey;

  throw new Error('No API key available for OpenAI STT');
};

export { resolveTranscription, resolveOpenAIKey, detectBestEngine };
