import { createLogger } from '../../logging/logger-buffer';
import { getSpeechPlugin } from '../../web-providers/speech/plugin-registry';
import { transcribeViaSpeechPlugin } from '../../web-providers/speech/speech-bridge';
import type { MediaProvider, TranscribeOptions } from '../types';

const log = createLogger('media');

/**
 * Browser zero-token STT provider. Transcribes audio through the user's
 * logged-in Gemini web session (no API key). Dispatches through the speech
 * plugin registry — the heavy lifting (BrowserChannel transport + protobuf
 * framing) lives behind the Gemini speech plugin.
 */
const transcribe = async (
  audio: ArrayBuffer,
  _mimeType: string,
  options: TranscribeOptions,
): Promise<string> => {
  const language = options.language || 'en';
  log.debug('Gemini web STT request', { language, bytes: audio.byteLength });

  const plugin = getSpeechPlugin('gemini-web');
  if (!plugin) throw new Error('Gemini web speech plugin not registered');

  return transcribeViaSpeechPlugin(plugin, audio, language);
};

const geminiWebProvider: MediaProvider = { id: 'gemini-web', transcribe };

export { geminiWebProvider };
