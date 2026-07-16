// ──────────────────────────────────────────────
// SenseVoice Worker — Local Multilingual STT (sherpa-onnx-wasm)
// ──────────────────────────────────────────────
// Runs SenseVoice-Small entirely in the offscreen document via the k2-fsa
// sherpa-onnx WASM engine (Kaldi FBank + CTC decode + tokens.txt detokenize
// built in). The ~230 MB int8 model is fetched on demand, cached (Cache API),
// and written into the Emscripten MEMFS so the recognizer loads it by path.
//
// Path B (per R22 / Phase 13): consume the prebuilt THREADED sherpa wasm.
// Requires SharedArrayBuffer → crossOriginIsolated (manifest COOP/COEP keys).

import { stripSenseVoiceTokens } from './sensevoice-decode';

const TARGET_SAMPLE_RATE = 16000;

// On-demand model assets (sherpa-onnx SenseVoice export).
const MODEL_URL =
  'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx';
const TOKENS_URL =
  'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt';
// MEMFS paths the recognizer reads from.
const MEMFS_MODEL = '/sensevoice-model.int8.onnx';
const MEMFS_TOKENS = '/sensevoice-tokens.txt';
// Cache API bucket (shared naming with STT model caches).
const CACHE_NAME = 'sensevoice-cache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SherpaModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Recognizer = any;

const log = (level: string, message: string, data?: unknown) => {
  const consoleFn = level === 'error' ? console.error : console.debug;
  consoleFn('[sensevoice]', message, data ?? '');
  chrome.runtime
    .sendMessage({ type: 'LOG_RELAY', level, message, ...(data !== undefined ? { data } : {}) })
    .catch(() => {});
};
const trace = (msg: string, data?: unknown) => log('trace', msg, data);
const debug = (msg: string, data?: unknown) => log('debug', msg, data);

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

// ── Audio Decoding (16 kHz mono Float32) ────────

const decodeAudioToPcm = async (audioBuffer: ArrayBuffer): Promise<Float32Array> => {
  const tempCtx = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
  const decoded = await tempCtx.decodeAudioData(audioBuffer.slice(0));
  const numSamples = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  const offlineCtx = new OfflineAudioContext(1, numSamples, TARGET_SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
};

// ── Model asset fetch + cache ───────────────────

/**
 * Fetch an asset, preferring the Cache API. On a cache miss the response is
 * streamed, download progress is reported, and the body is stored for reuse.
 */
const fetchCached = async (
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> => {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) {
    trace('asset cache hit', { url });
    return cached.arrayBuffer();
  }

  trace('asset cache miss — downloading', { url });
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) {
    throw new Error(`Failed to download ${url}: HTTP ${resp.status}`);
  }

  const total = Number(resp.headers.get('content-length')) || 0;
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  // Store a fresh Response so subsequent runs are offline.
  await cache.put(url, new Response(bytes, { headers: { 'content-length': String(loaded) } }));
  return bytes.buffer;
};

// ── Sherpa WASM engine bootstrap ────────────────

let sherpaModulePromise: Promise<SherpaModule> | null = null;
let cachedRecognizer: Recognizer | null = null;
// MEMFS paths already written this page lifetime — FS_createDataFile throws on
// a duplicate path, and the full FS object (for a stat-based check) isn't exported.
const writtenMemfsPaths = new Set<string>();

const asset = (file: string): string =>
  chrome.runtime.getURL(`offscreen-channels/assets/${file}`);

/**
 * Load the sherpa Emscripten glue + API wrapper as same-origin scripts and
 * resolve once the wasm runtime is initialized. The threaded build spawns
 * pthread workers; `mainScriptUrlOrBlob` is pinned to a packaged same-origin
 * URL so MV3 CSP does not block a blob: worker.
 */
const loadSherpaModule = (): Promise<SherpaModule> => {
  if (sherpaModulePromise) return sherpaModulePromise;

  sherpaModulePromise = (async () => {
    if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated) {
      throw new Error(
        'SenseVoice requires cross-origin isolation (SharedArrayBuffer). ' +
          'The offscreen document is missing COOP/COEP — reload the extension.',
      );
    }

    const glueUrl = asset('sherpa-onnx-wasm-main-vad-asr.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = self as any;

    // Configure the Emscripten Module BEFORE the glue script runs.
    const readyPromise = new Promise<SherpaModule>((resolve, reject) => {
      const Module: SherpaModule = {
        locateFile: (path: string) => asset(path),
        mainScriptUrlOrBlob: glueUrl,
        onRuntimeInitialized: () => resolve(Module),
        onAbort: (reason: unknown) => reject(new Error(`sherpa wasm aborted: ${reason}`)),
      };
      g.Module = Module;
    });

    // Load the glue (defines the wasm runtime) then the JS API wrapper as
    // CLASSIC scripts — not ESM `import()`. Emscripten's glue guards its config
    // object with `var Module = typeof Module != "undefined" ? Module : {}`.
    // Under an ES-module scope the hoisted `var Module` shadows our pre-set
    // `self.Module`, so `typeof Module` is "undefined", our `locateFile` is
    // discarded, `scriptDirectory` collapses to "", and the wasm is fetched
    // from the bare (assets-less) path → ERR_FILE_NOT_FOUND. As a top-level
    // `var` in a classic script it does NOT overwrite the existing global, so
    // `locateFile` survives and resolves the wasm under assets/.
    const loadClassicScript = (src: string): Promise<void> =>
      new Promise((resolveScript, rejectScript) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = () => resolveScript();
        el.onerror = () => rejectScript(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(el);
      });

    await loadClassicScript(glueUrl);
    await loadClassicScript(asset('sherpa-onnx-asr.js'));

    const Module = await readyPromise;
    trace('sherpa wasm runtime initialized');
    return Module;
  })();

  return sherpaModulePromise;
};

/**
 * Ensure the SenseVoice model + tokens are present in MEMFS and return a
 * cached OfflineRecognizer configured for SenseVoice.
 */
const ensureRecognizer = async (
  language: string,
  onDownload?: (loaded: number, total: number) => void,
): Promise<Recognizer> => {
  const Module = await loadSherpaModule();

  if (!cachedRecognizer) {
    // The vendored sherpa glue only exports the `FS_createDataFile` helper, not
    // the full `FS` object (FS is not in EXPORTED_RUNTIME_METHODS), so
    // `Module.FS.writeFile`/`stat` are undefined. Write model bytes via
    // FS_createDataFile(parent, name, data, canRead, canWrite, canOwn) and track
    // what we've written with a module-level set — MEMFS persists for the page
    // lifetime, and FS_createDataFile throws if the path already exists.
    const writeMemfs = (path: string, data: ArrayBuffer): void => {
      if (writtenMemfsPaths.has(path)) return;
      const slash = path.lastIndexOf('/');
      const parent = path.slice(0, slash) || '/';
      const name = path.slice(slash + 1);
      Module.FS_createDataFile(parent, name, new Uint8Array(data), true, true, true);
      writtenMemfsPaths.add(path);
    };

    if (!writtenMemfsPaths.has(MEMFS_TOKENS)) {
      const tokens = await fetchCached(TOKENS_URL);
      writeMemfs(MEMFS_TOKENS, tokens);
    }
    if (!writtenMemfsPaths.has(MEMFS_MODEL)) {
      const model = await fetchCached(MODEL_URL, onDownload);
      writeMemfs(MEMFS_MODEL, model);
    }

    // SenseVoice `language` hint: '' = auto-detect. Whisper-style codes map
    // to SenseVoice's short codes; anything unrecognized falls back to auto.
    const langMap: Record<string, string> = {
      zh: 'zh',
      en: 'en',
      ja: 'ja',
      ko: 'ko',
      yue: 'yue',
      auto: '',
    };
    const svLang = langMap[language] ?? '';

    const config = {
      featConfig: { sampleRate: TARGET_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: MEMFS_MODEL,
          language: svLang,
          useInverseTextNormalization: 1,
        },
        tokens: MEMFS_TOKENS,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
    };

    trace('creating OfflineRecognizer', { language: svLang || 'auto' });
    // The vendored API wrapper attaches OfflineRecognizer to globalThis (see the
    // browser-export trailer in sherpa-onnx-asr.js) — it is not a Module member.
    // eslint-disable-next-line new-cap, @typescript-eslint/no-explicit-any
    const OfflineRecognizer = (self as any).OfflineRecognizer;
    if (typeof OfflineRecognizer !== 'function') {
      throw new Error('sherpa OfflineRecognizer not loaded — API wrapper failed to initialize');
    }
    cachedRecognizer = new OfflineRecognizer(config, Module);
  }

  return cachedRecognizer;
};

// ── Transcription ───────────────────────────────

const transcribeWithSenseVoice = async (
  audio: ArrayBuffer,
  requestId: string,
  language: string,
): Promise<string> => {
  // Decode the audio FIRST, while memory is still free. Loading the threaded
  // sherpa WASM engine + writing the ~239 MB model into MEMFS reserves a large
  // SharedArrayBuffer; decoding after that allocation intermittently fails with
  // a generic "Unable to decode audio data" DOMException. Decoding up front (the
  // transformers path already decodes under light memory) avoids that.
  const pcm = await decodeAudioToPcm(audio);

  sendProgress(requestId, 'loading');
  const recognizer = await ensureRecognizer(language, (loaded, total) => {
    sendProgress(requestId, 'downloading', total ? Math.round((loaded / total) * 100) : undefined);
  });

  sendProgress(requestId, 'transcribing');

  const stream = recognizer.createStream();
  try {
    stream.acceptWaveform(TARGET_SAMPLE_RATE, pcm);
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    debug('sensevoice raw result', { text: String(result?.text).substring(0, 200) });
    sendProgress(requestId, 'ready');
    return stripSenseVoiceTokens(String(result?.text ?? ''));
  } finally {
    // Release the per-utterance stream; keep the recognizer + model cached.
    stream.free();
  }
};

// ── Model Download (pre-fetch) ──────────────────

const handleModelDownload = async (downloadId: string): Promise<void> => {
  try {
    trace('handleModelDownload: start', { downloadId });
    sendDownloadProgress(downloadId, 'downloading', 0);
    // Instantiating the recognizer downloads + caches model + tokens.
    await ensureRecognizer('auto', (loaded, total) => {
      sendDownloadProgress(downloadId, 'downloading', total ? Math.round((loaded / total) * 100) : 0);
    });
    sendDownloadProgress(downloadId, 'complete', 100);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log('error', 'SenseVoice model download error', error);
    sendDownloadProgress(downloadId, 'error', 0, error);
  }
};

export { transcribeWithSenseVoice, handleModelDownload };
