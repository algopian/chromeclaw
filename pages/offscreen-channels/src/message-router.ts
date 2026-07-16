/**
 * Message router — shared between offscreen document (Chrome) and
 * inline worker registration (Firefox).
 *
 * Routes incoming `chrome.runtime.onMessage` messages to the appropriate
 * worker (telegram, whatsapp, stt, tts, text-gen).
 *
 * On Firefox the background page imports this directly (no offscreen doc).
 * Messages originating from this router carry `_source: 'worker-router'`
 * so the background listener can identify them and avoid echo loops.
 */

import type { StorageProxy } from './storage-proxy';

const STORAGE_KEY = 'channelConfigs';

/** Read credentials from storage */
const getCredentials = async (
  storage: StorageProxy,
  channelId: string,
): Promise<Record<string, string> | null> => {
  const data = await storage.get(STORAGE_KEY);
  const configs = (data[STORAGE_KEY] ?? []) as Array<{
    channelId: string;
    credentials: Record<string, string>;
  }>;
  const config = configs.find(c => c.channelId === channelId);
  return config?.credentials ?? null;
};

// Lazy WhatsApp worker loader
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let waWorkerModule: typeof import('./whatsapp-worker') | null = null;
const getWaWorker = async () => {
  if (!waWorkerModule) {
    waWorkerModule = await import('./whatsapp-worker');
  }
  return waWorkerModule;
};

/**
 * Register the worker message router on `chrome.runtime.onMessage`.
 * @param storage - Storage proxy (offscreen uses message-based proxy, Firefox uses direct chrome.storage.local)
 */
const registerWorkerRouter = (storage: StorageProxy): void => {
  // Lazy Telegram worker imports
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  let telegramWorkerModule: typeof import('./telegram-worker') | null = null;
  const getTelegramWorker = async () => {
    if (!telegramWorkerModule) {
      telegramWorkerModule = await import('./telegram-worker');
    }
    return telegramWorkerModule;
  };

  chrome.runtime.onMessage.addListener(
    (message: Record<string, unknown>, _sender, sendResponse) => {
      const type = message.type;
      if (typeof type !== 'string') return false;

      switch (type) {
        case 'CHANNEL_START_WORKER': {
          const channelId = message.channelId;
          const offset = message.offset as number | undefined;
          if (typeof channelId !== 'string') {
            sendResponse({ ok: false, error: 'Missing channelId' });
            return false;
          }

          (async () => {
            try {
              switch (channelId) {
                case 'telegram': {
                  const tgWorker = await getTelegramWorker();
                  const credentials = await getCredentials(storage, channelId);
                  if (!credentials?.botToken) {
                    sendResponse({ ok: false, error: `No credentials for ${channelId}` });
                    return;
                  }
                  tgWorker.startTelegramWorker(credentials.botToken, offset);
                  sendResponse({ ok: true });
                  break;
                }
                case 'whatsapp': {
                  const wa = await getWaWorker();
                  await wa.startWhatsAppWorker();
                  sendResponse({ ok: true });
                  break;
                }
                default:
                  sendResponse({ ok: false, error: `Unknown channel: ${channelId}` });
              }
            } catch (err) {
              sendResponse({ ok: false, error: String(err) });
            }
          })();
          return true;
        }

        case 'CHANNEL_STOP_WORKER': {
          const channelId = message.channelId;
          if (typeof channelId !== 'string') return false;

          (async () => {
            switch (channelId) {
              case 'telegram': {
                const tgWorker = await getTelegramWorker();
                tgWorker.stopTelegramWorker();
                break;
              }
              case 'whatsapp':
                if (waWorkerModule) {
                  waWorkerModule.stopWhatsAppWorker();
                }
                break;
            }
            sendResponse({ ok: true });
          })();
          return true;
        }

        case 'CHANNEL_ACK_OFFSET': {
          const channelId = message.channelId;
          const offset = message.offset;
          if (typeof channelId !== 'string' || typeof offset !== 'number') return false;

          (async () => {
            if (channelId === 'telegram') {
              const tgWorker = await getTelegramWorker();
              tgWorker.updateTelegramOffset(offset);
            }
            sendResponse({ ok: true });
          })();
          return true;
        }

        case 'TRANSCRIBE_AUDIO': {
          const audioBase64 = message.audioBase64;
          const mimeType = message.mimeType;
          const requestId = message.requestId;
          if (
            typeof audioBase64 !== 'string' ||
            typeof mimeType !== 'string' ||
            typeof requestId !== 'string'
          ) {
            sendResponse({ ok: false, error: 'Invalid transcription request' });
            return false;
          }

          const binary = atob(audioBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          const audio = bytes.buffer;
          const model = typeof message.model === 'string' ? message.model : 'tiny';
          const language = typeof message.language === 'string' ? message.language : '';
          const engine = message.engine === 'sensevoice' ? 'sensevoice' : 'transformers';

          import('./stt-worker')
            .then(({ handleTranscribeRequest }) =>
              handleTranscribeRequest(audio, mimeType, requestId, engine, model, language),
            )
            .catch(err => {
              chrome.runtime
                .sendMessage({
                  type: 'TRANSCRIBE_ERROR',
                  error: String(err),
                  requestId,
                  _source: 'worker-router',
                })
                .catch(() => {});
            });
          sendResponse({ ok: true });
          return false;
        }

        case 'STT_DOWNLOAD_MODEL': {
          const model = message.model;
          const downloadId = message.downloadId;
          if (typeof model !== 'string' || typeof downloadId !== 'string') {
            return false;
          }
          const dlEngine = message.engine === 'sensevoice' ? 'sensevoice' : 'transformers';

          import('./stt-worker')
            .then(({ handleModelDownload }) =>
              handleModelDownload(dlEngine, model, downloadId),
            )
            .catch(err => {
              chrome.runtime
                .sendMessage({
                  type: 'STT_DOWNLOAD_PROGRESS',
                  downloadId,
                  status: 'error',
                  percent: 0,
                  error: String(err),
                  _source: 'worker-router',
                })
                .catch(() => {});
            });
          sendResponse({ ok: true });
          return false;
        }

        case 'TTS_SYNTHESIZE': {
          const text = message.text;
          const requestId = message.requestId;
          if (typeof text !== 'string' || typeof requestId !== 'string') {
            sendResponse({ ok: false, error: 'Invalid TTS request' });
            return false;
          }

          const ttsModel =
            typeof message.model === 'string'
              ? message.model
              : 'onnx-community/Kokoro-82M-v1.0-ONNX';
          const voice = typeof message.voice === 'string' ? message.voice : 'af_heart';
          const speed = typeof message.speed === 'number' ? message.speed : 1.0;

          import('./tts-worker')
            .then(({ handleSynthesisRequest }) =>
              handleSynthesisRequest(text, requestId, ttsModel, voice, speed),
            )
            .catch(err => {
              chrome.runtime
                .sendMessage({
                  type: 'TTS_ERROR',
                  error: String(err),
                  requestId,
                  _source: 'worker-router',
                })
                .catch(() => {});
            });
          sendResponse({ ok: true });
          return false;
        }

        case 'TTS_SYNTHESIZE_STREAM': {
          const text = message.text;
          const requestId = message.requestId;
          if (typeof text !== 'string' || typeof requestId !== 'string') {
            sendResponse({ ok: false, error: 'Invalid TTS stream request' });
            return false;
          }

          const ttsModel =
            typeof message.model === 'string'
              ? message.model
              : 'onnx-community/Kokoro-82M-v1.0-ONNX';
          const voice = typeof message.voice === 'string' ? message.voice : 'af_heart';
          const speed = typeof message.speed === 'number' ? message.speed : 1.0;

          import('./tts-worker')
            .then(({ handleStreamSynthesisRequest }) =>
              handleStreamSynthesisRequest(text, requestId, ttsModel, voice, speed),
            )
            .catch(err => {
              chrome.runtime
                .sendMessage({
                  type: 'TTS_ERROR',
                  error: String(err),
                  requestId,
                  _source: 'worker-router',
                })
                .catch(() => {});
            });
          sendResponse({ ok: true });
          return false;
        }

        case 'TTS_SYNTHESIZE_STREAM_BATCHED': {
          const text = message.text;
          const requestId = message.requestId;
          if (typeof text !== 'string' || typeof requestId !== 'string') {
            sendResponse({ ok: false, error: 'Invalid TTS batched stream request' });
            return false;
          }

          const ttsModel =
            typeof message.model === 'string'
              ? message.model
              : 'onnx-community/Kokoro-82M-v1.0-ONNX';
          const voice = typeof message.voice === 'string' ? message.voice : 'af_heart';
          const speed = typeof message.speed === 'number' ? message.speed : 1.0;
          const adaptiveChunking =
            typeof message.adaptiveChunking === 'boolean' ? message.adaptiveChunking : true;

          import('./tts-worker')
            .then(({ handleBatchedStreamSynthesisRequest }) =>
              handleBatchedStreamSynthesisRequest(
                text,
                requestId,
                ttsModel,
                voice,
                speed,
                adaptiveChunking,
              ),
            )
            .catch(err => {
              chrome.runtime
                .sendMessage({
                  type: 'TTS_ERROR',
                  error: String(err),
                  requestId,
                  _source: 'worker-router',
                })
                .catch(() => {});
            });
          sendResponse({ ok: true });
          return false;
        }

        case 'TTS_DOWNLOAD_MODEL': {
          const model = message.model;
          const downloadId = message.downloadId;
          if (typeof model !== 'string' || typeof downloadId !== 'string') {
            return false;
          }

          import('./tts-worker')
            .then(({ handleModelDownload }) => handleModelDownload(model, downloadId))
            .catch(err => {
              chrome.runtime
                .sendMessage({
                  type: 'TTS_DOWNLOAD_PROGRESS',
                  downloadId,
                  status: 'error',
                  percent: 0,
                  error: String(err),
                  _source: 'worker-router',
                })
                .catch(() => {});
            });
          sendResponse({ ok: true });
          return false;
        }

        case 'LOCAL_LLM_GENERATE': {
          const requestId = message.requestId;
          const modelId = message.modelId;
          const messages = message.messages;
          const systemPrompt = message.systemPrompt;
          if (
            typeof requestId !== 'string' ||
            typeof modelId !== 'string' ||
            !Array.isArray(messages) ||
            typeof systemPrompt !== 'string'
          ) {
            sendResponse({ ok: false, error: 'Invalid LOCAL_LLM_GENERATE request' });
            return false;
          }

          const maxTokens = typeof message.maxTokens === 'number' ? message.maxTokens : undefined;
          const temperature =
            typeof message.temperature === 'number' ? message.temperature : undefined;
          const device = typeof message.device === 'string' ? message.device : undefined;
          const tools = Array.isArray(message.tools) ? message.tools : undefined;
          const supportsReasoning =
            typeof message.supportsReasoning === 'boolean' ? message.supportsReasoning : undefined;

          import('./text-gen-worker')
            .then(({ handleGenerateRequest }) =>
              handleGenerateRequest(
                requestId,
                modelId,
                messages as Array<{ role: string; content: string }>,
                systemPrompt,
                maxTokens,
                temperature,
                device,
                tools,
                supportsReasoning,
              ),
            )
            .catch(err => {
              chrome.runtime
                .sendMessage({
                  type: 'LOCAL_LLM_ERROR',
                  requestId,
                  error: String(err),
                  _source: 'worker-router',
                })
                .catch(() => {});
            });
          sendResponse({ ok: true });
          return false;
        }

        case 'LOCAL_LLM_DOWNLOAD_MODEL': {
          const modelId = message.modelId;
          const downloadId = message.downloadId;
          if (typeof modelId !== 'string' || typeof downloadId !== 'string') {
            return false;
          }

          const device = typeof message.device === 'string' ? message.device : undefined;

          import('./text-gen-worker')
            .then(({ handleModelDownload }) => handleModelDownload(modelId, downloadId, device))
            .catch(err => {
              chrome.runtime
                .sendMessage({
                  type: 'LOCAL_LLM_DOWNLOAD_PROGRESS',
                  downloadId,
                  status: 'error',
                  percent: 0,
                  error: String(err),
                  _source: 'worker-router',
                })
                .catch(() => {});
            });
          sendResponse({ ok: true });
          return false;
        }

        case 'LOCAL_LLM_ABORT': {
          const requestId = message.requestId;
          if (typeof requestId !== 'string') return false;

          import('./text-gen-worker')
            .then(({ handleAbort }) => handleAbort(requestId))
            .catch(() => {});
          sendResponse({ ok: true });
          return false;
        }

        case 'WA_SEND_MESSAGE': {
          const jid = message.jid;
          const text = message.text;
          if (typeof jid !== 'string' || typeof text !== 'string') {
            sendResponse({ ok: false, error: 'Invalid WA_SEND_MESSAGE' });
            return false;
          }

          getWaWorker()
            .then(wa => wa.sendWhatsAppMessage(jid, text))
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ ok: false, error: String(err) }));
          return true;
        }

        case 'WA_SEND_AUDIO': {
          const jid = message.jid;
          const audioBase64 = message.audioBase64;
          const ptt = message.ptt;
          if (
            typeof jid !== 'string' ||
            typeof audioBase64 !== 'string' ||
            typeof ptt !== 'boolean'
          ) {
            sendResponse({ ok: false, error: 'Invalid WA_SEND_AUDIO' });
            return false;
          }

          const binaryAudio = atob(audioBase64);
          const audioBytes = new Uint8Array(binaryAudio.length);
          for (let i = 0; i < binaryAudio.length; i++) {
            audioBytes[i] = binaryAudio.charCodeAt(i);
          }

          getWaWorker()
            .then(wa => wa.sendWhatsAppAudio(jid, audioBytes.buffer, ptt))
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ ok: false, error: String(err) }));
          return true;
        }

        case 'WA_SET_TYPING': {
          const jid = message.jid;
          const isTyping = message.isTyping;
          if (typeof jid !== 'string' || typeof isTyping !== 'boolean') {
            sendResponse({ ok: false });
            return false;
          }

          getWaWorker()
            .then(wa => wa.setWhatsAppTyping(jid, isTyping))
            .then(() => sendResponse({ ok: true }))
            .catch(() => sendResponse({ ok: false }));
          return true;
        }
      }

      return false;
    },
  );
};

export { registerWorkerRouter };
