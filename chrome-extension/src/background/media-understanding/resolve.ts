import { DEFAULT_LOCAL_MODEL } from './defaults';
import { getProvider } from './providers';
import { createLogger } from '../logging/logger-buffer';
import { checkWebAuth } from '../web-providers/auth';
import { getSpeechPlugin } from '../web-providers/speech/plugin-registry';
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
  } else if (engine === 'gemini-web') {
    // Pre-flight auth gate: check session BEFORE recording/injecting.
    // Fail fast with an actionable message if not logged in.
    const plugin = getSpeechPlugin('gemini-web');
    if (plugin) {
      const authStatus = await checkWebAuth(plugin.definition);
      if (authStatus === 'not-logged-in' || authStatus === 'expired') {
        throw new Error(
          'Sign in to Gemini to use browser STT. ' +
            'Open Settings → Speech-to-Text and click Login.',
        );
      }
    }
  } else if (engine === 'sensevoice') {
    // SenseVoice is multilingual; language is a hint (or 'auto'), not a model split.
    // No Whisper localModel — the worker loads its own fixed model.
    options.model = 'sensevoice';
    // The global STT language default is 'en', which forces English decoding and
    // mangles other languages (e.g. Chinese). SenseVoice is inherently
    // multilingual, so unless the user explicitly picked a non-default language,
    // let the model auto-detect per utterance ('' = auto). An explicit choice
    // other than the 'en' default is still honoured.
    if (config.language === 'en') {
      options.language = 'auto';
    }
  } else {
    options.model = config.localModel || DEFAULT_LOCAL_MODEL;
  }

  log.info('resolveTranscription: engine selected', {
    engine,
    configEngine: config.engine,
    bytes: audio.byteLength,
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
    log.error('transcription failed', {
      engine,
      configEngine: config.engine,
      error: err instanceof Error ? err.message : String(err),
    });
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
