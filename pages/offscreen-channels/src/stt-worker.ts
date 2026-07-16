// ──────────────────────────────────────────────
// STT Worker — Local Voice Transcription
// ──────────────────────────────────────────────
// Uses @huggingface/transformers (ONNX) for local, private transcription.

import { registerSttEngine, getSttEngine } from './stt-engine-registry';
import { pipeline } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web';
import type { SttEngine } from './stt-engine-registry';

// Configure ONNX runtime BEFORE any pipeline() call.
// Point wasmPaths to same-origin extension files so dynamic import() uses
// chrome-extension:// URLs (allowed by MV3 CSP 'self') instead of blob: URLs
// (blocked by CSP). Setting this early prevents @huggingface/transformers
// from overwriting it with a CDN URL.
try {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('offscreen-channels/assets/');
} catch (err) {
  console.error('[stt] Failed to configure ONNX runtime:', err);
}

// Relay logger — sends structured log entries to the background SW's logger-buffer
// so they appear in the Options → Logs viewer alongside other extension logs.
const log = (level: string, message: string, data?: unknown) => {
  // Always log to offscreen devtools console as fallback
  const consoleFn = level === 'error' ? console.error : console.debug;
  consoleFn('[stt]', message, data ?? '');
  // Relay to background SW logger-buffer
  chrome.runtime
    .sendMessage({
      type: 'LOG_RELAY',
      level,
      message,
      ...(data !== undefined ? { data } : {}),
    })
    .catch(() => {});
};
const trace = (msg: string, data?: unknown) => log('trace', msg, data);
const debug = (msg: string, data?: unknown) => log('debug', msg, data);

console.debug('[stt] ONNX runtime configured', {
  numThreads: ort.env.wasm.numThreads,
  wasmPaths: ort.env.wasm.wasmPaths,
});
debug('ONNX runtime configured', {
  numThreads: ort.env.wasm.numThreads,
  wasmPaths: ort.env.wasm.wasmPaths,
});

const TARGET_SAMPLE_RATE = 16000;

// ── Model ID Mapping ────────────────────────────

/** Map a Whisper model name to the HuggingFace Transformers model ID. */
const toTransformersModelId = (model: string): string => {
  // Transformers uses Xenova/ prefix
  return `Xenova/whisper-${model}`;
};

// ── Progress Reporting ──────────────────────────

const sendProgress = (
  requestId: string,
  status: 'downloading' | 'loading' | 'transcribing' | 'ready',
  percent?: number,
): void => {
  chrome.runtime
    .sendMessage({ type: 'TRANSCRIBE_PROGRESS', requestId, status, percent })
    .catch(() => {});
};

const sendDownloadProgress = (
  downloadId: string,
  status: 'downloading' | 'complete' | 'error',
  percent: number,
  error?: string,
): void => {
  chrome.runtime
    .sendMessage({ type: 'STT_DOWNLOAD_PROGRESS', downloadId, status, percent, error })
    .catch(() => {});
};

// ── Audio Decoding ──────────────────────────────

/**
 * Decode audio data to mono PCM Float32 at 16kHz.
 * Uses OfflineAudioContext for browser-native decoding of OGG, MP3, etc.
 */
const decodeAudioToPcm = async (audioBuffer: ArrayBuffer): Promise<Float32Array> => {
  trace('decodeAudioToPcm: start', { byteLength: audioBuffer.byteLength });
  const tempCtx = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
  const decoded = await tempCtx.decodeAudioData(audioBuffer.slice(0));
  trace('decodeAudioToPcm: decoded', {
    duration: decoded.duration,
    sampleRate: decoded.sampleRate,
    channels: decoded.numberOfChannels,
  });

  const numSamples = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  const offlineCtx = new OfflineAudioContext(1, numSamples, TARGET_SAMPLE_RATE);

  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);

  const rendered = await offlineCtx.startRendering();
  trace('decodeAudioToPcm: done', { samples: rendered.getChannelData(0).length });
  return rendered.getChannelData(0);
};

// ── Transformers Engine (@huggingface/transformers) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedTranscriber: any = null;
let cachedTranscriberModel: string | null = null;

const transcribeWithTransformers = async (
  audio: ArrayBuffer,
  requestId: string,
  model: string,
  language: string,
): Promise<string> => {
  sendProgress(requestId, 'downloading');

  const modelId = toTransformersModelId(model);
  trace('transformers: start', { modelId });

  // Invalidate cache if model changed
  if (cachedTranscriberModel !== modelId) {
    cachedTranscriber = null;
    cachedTranscriberModel = null;
  }

  if (!cachedTranscriber) {
    trace('transformers: creating pipeline (wasmPaths=' + ort.env.wasm.wasmPaths + ')');
    const t0 = performance.now();
    cachedTranscriber = await pipeline('automatic-speech-recognition', modelId, {
      dtype: 'q8',
    });
    trace('transformers: pipeline ready', { elapsed: Math.round(performance.now() - t0) + 'ms' });
    cachedTranscriberModel = modelId;

    // Debug: dump model generation config to help diagnose language issues
    try {
      const genConfig = cachedTranscriber.model?.generation_config;
      debug('transformers: generation_config', {
        forced_decoder_ids: genConfig?.forced_decoder_ids,
        lang: genConfig?.lang,
        task: genConfig?.task,
        is_multilingual: genConfig?.is_multilingual,
      });
    } catch {
      // ignore — debug only
    }
  }

  sendProgress(requestId, 'transcribing');
  trace('transformers: decoding audio');
  const pcm = await decodeAudioToPcm(audio);

  // Always pass task:'transcribe' to override the model's default forced_decoder_ids
  // which force English (<|en|>). Without this, multilingual models (tiny, base, small)
  // always output English even when the input is another language.
  // When language is set: forces that language. When omitted: model auto-detects.
  const isMultilingual = !model.endsWith('.en');
  const pipelineOptions: Record<string, unknown> = { task: 'transcribe' };
  if (language) pipelineOptions.language = language;

  debug('transformers: pipelineOptions', {
    pipelineOptions,
    model,
    isMultilingual,
    languageParam: language,
    languageTruthy: !!language,
  });

  trace('transformers: running inference', { samples: pcm.length, language: language || 'auto' });
  const t1 = performance.now();
  const result = (await cachedTranscriber(pcm, pipelineOptions)) as { text: string };
  const elapsed = Math.round(performance.now() - t1);
  debug('transformers: raw result', {
    text: result.text?.substring(0, 200),
    textLength: result.text?.length,
    fullResult: JSON.stringify(result).substring(0, 500),
    elapsed: elapsed + 'ms',
  });

  sendProgress(requestId, 'ready');
  return result.text.trim();
};

// ── Model Download (transformers) ───────────────

/** Pre-fetch the Whisper model by instantiating its pipeline. */
const downloadTransformersModel = async (model: string, downloadId: string): Promise<void> => {
  sendDownloadProgress(downloadId, 'downloading', 0);
  const modelId = toTransformersModelId(model);
  trace('handleModelDownload: creating pipeline', {
    modelId,
    wasmPaths: ort.env.wasm.wasmPaths,
    numThreads: ort.env.wasm.numThreads,
  });
  const t0 = performance.now();
  cachedTranscriber = await pipeline('automatic-speech-recognition', modelId, {
    dtype: 'q8',
  });
  trace('handleModelDownload: pipeline created', {
    elapsed: Math.round(performance.now() - t0) + 'ms',
  });
  cachedTranscriberModel = modelId;
  sendDownloadProgress(downloadId, 'complete', 100);
};

// ── Engine Registration ─────────────────────────
// Each engine registers ONCE. Adding a new engine is a single registerSttEngine
// call — the transcribe + download dispatch below then routes to it with no
// further edits, so a new engine can't pass tests yet fail on first hotkey use.

registerSttEngine({
  id: 'transformers',
  transcribe: transcribeWithTransformers,
  download: downloadTransformersModel,
});

// SenseVoice pulls in the sherpa-wasm engine; import lazily on first use so the
// transformers-only path never loads the ~13 MB wasm glue.
registerSttEngine({
  id: 'sensevoice',
  transcribe: async (audio, requestId, _model, language) => {
    const { transcribeWithSenseVoice } = await import('./sensevoice-worker');
    return transcribeWithSenseVoice(audio, requestId, language);
  },
  download: async (_model, downloadId) => {
    const { handleModelDownload: handleSenseVoiceDownload } = await import('./sensevoice-worker');
    await handleSenseVoiceDownload(downloadId);
  },
});

// ── Dispatch ────────────────────────────────────

const transcribeAudio = async (
  audio: ArrayBuffer,
  mimeType: string,
  engine: SttEngine,
  requestId: string,
  model: string,
  language: string,
): Promise<string> => {
  trace('dispatch', {
    engine,
    model,
    requestId,
    language: language || 'auto',
    audioBytes: audio.byteLength,
  });
  const impl = getSttEngine(engine);
  if (!impl) throw new Error(`Unknown STT engine: ${engine}`);
  return impl.transcribe(audio, requestId, model, language);
};

// ── Model Download ──────────────────────────────

const handleModelDownload = async (
  engine: SttEngine,
  model: string,
  downloadId: string,
): Promise<void> => {
  try {
    trace('handleModelDownload: start', { engine, model, downloadId });
    const impl = getSttEngine(engine);
    if (!impl) throw new Error(`Unknown STT engine: ${engine}`);
    if (!impl.download) {
      throw new Error(`STT engine '${engine}' does not support pre-download`);
    }
    await impl.download(model, downloadId);
    trace('handleModelDownload: complete');
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log('error', 'Model download error', error);
    sendDownloadProgress(downloadId, 'error', 0, error);
  }
};

// ── Message Handler ─────────────────────────────

const handleTranscribeRequest = async (
  audio: ArrayBuffer,
  mimeType: string,
  requestId: string,
  engine: SttEngine,
  model: string,
  language: string,
): Promise<void> => {
  try {
    const text = await transcribeAudio(audio, mimeType, engine, requestId, model, language);
    await chrome.runtime
      .sendMessage({ type: 'TRANSCRIBE_RESULT', text, requestId })
      .catch(() => {});
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log('error', 'Transcription error', error);
    await chrome.runtime
      .sendMessage({ type: 'TRANSCRIBE_ERROR', error, requestId })
      .catch(() => {});
  }
};

export { handleTranscribeRequest, handleModelDownload, transcribeAudio };
