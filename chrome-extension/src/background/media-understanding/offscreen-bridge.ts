import { ensureOffscreenDocument } from '../channels/offscreen-manager';
import { createLogger } from '../logging/logger-buffer';
import { DEFAULT_TRANSCRIPTION_TIMEOUT_MS } from './defaults';

const bridgeLog = createLogger('media');

/** Encode ArrayBuffer as base64 for chrome.runtime.sendMessage (ArrayBuffer is not JSON-serializable) */
const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

/** Request transcription of an audio buffer via the offscreen document's STT worker. */
const requestTranscription = async (
  audio: ArrayBuffer,
  mimeType: string,
  model: string,
  language?: string,
  engine: string = 'transformers',
): Promise<string> => {
  await ensureOffscreenDocument();

  const requestId = crypto.randomUUID();

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(
        new Error(`Transcription timed out after ${DEFAULT_TRANSCRIPTION_TIMEOUT_MS / 1000}s`),
      );
    }, DEFAULT_TRANSCRIPTION_TIMEOUT_MS);

    const listener = (message: Record<string, unknown>) => {
      if (message.requestId !== requestId) return;

      if (message.type === 'TRANSCRIBE_RESULT') {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message.text as string);
      } else if (message.type === 'TRANSCRIBE_ERROR') {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        reject(new Error(message.error as string));
      } else if (message.type === 'TRANSCRIBE_PROGRESS') {
        bridgeLog.debug('Transcription progress', {
          status: message.status,
          percent: message.percent,
        });
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    bridgeLog.debug('Sending TRANSCRIBE_AUDIO', { model, language, mimeType, requestId });

    chrome.runtime
      .sendMessage({
        type: 'TRANSCRIBE_AUDIO',
        audioBase64: arrayBufferToBase64(audio),
        mimeType,
        requestId,
        engine,
        model,
        language,
      })
      .then(response => {
        const resp = response as Record<string, unknown> | undefined;
        if (!resp || !resp.ok) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          reject(
            new Error(
              `Offscreen document rejected transcription: ${resp?.error ?? 'no response (module may have crashed)'}`,
            ),
          );
        }
      })
      .catch(err => {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        reject(new Error(`Failed to send transcription request: ${err}`));
      });
  });
};

/** Pre-download an STT model via the offscreen document. Returns a downloadId for progress tracking. */
const requestModelDownload = async (
  model: string,
  engine: string = 'transformers',
): Promise<string> => {
  await ensureOffscreenDocument();

  const downloadId = crypto.randomUUID();

  const response = (await chrome.runtime.sendMessage({
    type: 'STT_DOWNLOAD_MODEL',
    engine,
    model,
    downloadId,
  })) as Record<string, unknown> | undefined;

  if (!response || !response.ok) {
    throw new Error(
      `Offscreen document rejected model download: ${(response?.error as string) ?? 'no response (module may have crashed)'}`,
    );
  }

  return downloadId;
};

export { requestTranscription, requestModelDownload };
