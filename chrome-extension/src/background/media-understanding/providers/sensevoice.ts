import { requestTranscription } from '../offscreen-bridge';
import type { MediaProvider, TranscribeOptions } from '../types';

// SenseVoice loads a fixed multilingual model; `model` is a marker only.
// `language` is a hint ('' / 'auto' = auto-detect).
const transcribe = async (
  audio: ArrayBuffer,
  mimeType: string,
  options: TranscribeOptions,
): Promise<string> =>
  requestTranscription(
    audio,
    mimeType,
    options.model || 'sensevoice',
    options.language,
    'sensevoice',
  );

const sensevoiceProvider: MediaProvider = { id: 'sensevoice', transcribe };

export { sensevoiceProvider };
