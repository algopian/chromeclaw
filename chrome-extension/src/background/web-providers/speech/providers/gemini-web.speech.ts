/**
 * Gemini speech web provider plugin.
 *
 * Wraps the existing BrowserChannel client + protobuf codec into the
 * SpeechWebProviderPlugin interface so the speech bridge can dispatch
 * through the plugin registry instead of hardcoding Gemini imports.
 */

import { speechMainWorldChannel } from './gemini-browserchannel-client';
import {
  encodeConfigFrame,
  encodeAudioFrame,
  END_FRAME,
  toBase64,
  decodeResultB64Url,
} from './gemini-speech-protobuf';
import type {
  SpeechFetchRequest,
  SpeechWebProviderPlugin,
  SpeechWebProviderDefinition,
} from '../plugin-types';
import type { DecodedResult } from './gemini-speech-protobuf';

/** Max bytes per audio frame — chunk large clips so no single uplink is huge. */
const AUDIO_CHUNK_BYTES = 16_384;

const definition: SpeechWebProviderDefinition = {
  id: 'gemini-web',
  name: 'Gemini (browser session)',
  cookieDomain: '.google.com',
  sessionIndicators: ['__Secure-1PSID', 'SAPISID'],
  loginUrl: 'https://gemini.google.com',
};

/** Split audio container bytes into base64 audio frames. */
const buildAudioFrames = (audio: ArrayBuffer): string[] => {
  const bytes = new Uint8Array(audio);
  const frames: string[] = [];
  for (let off = 0; off < bytes.length; off += AUDIO_CHUNK_BYTES) {
    const chunk = bytes.subarray(off, Math.min(off + AUDIO_CHUNK_BYTES, bytes.length));
    frames.push(toBase64(encodeAudioFrame(chunk)));
  }
  return frames;
};

const encodeRequest = (audio: ArrayBuffer, language: string): SpeechFetchRequest => ({
  requestId: crypto.randomUUID(),
  configFrame: toBase64(encodeConfigFrame(language)),
  audioFrames: buildAudioFrames(audio),
  endFrame: toBase64(END_FRAME),
});

const decodeResult = (payloads: string[]): string => {
  const strings = payloads.filter((p): p is string => typeof p === 'string');
  if (strings.length === 0) {
    throw new Error('Gemini web STT returned no payloads');
  }

  const decoded: DecodedResult[] = [];
  let skipped = 0;
  for (const p of strings) {
    try {
      decoded.push(decodeResultB64Url(p));
    } catch {
      skipped++;
    }
  }

  const finals = decoded.filter(d => d.isFinal);
  if (finals.length === 0) {
    throw new Error(
      `Gemini web STT returned ${decoded.length} frame(s) but none were final ` +
        `(skipped: ${skipped})`,
    );
  }

  // Server acknowledged but detected no speech (e.g. silence / too short).
  const text = finals
    .map(f => f.transcript)
    .filter(Boolean)
    .join(' ');
  return text;
};

const geminiWebSpeechPlugin: SpeechWebProviderPlugin = {
  definition,
  encodeRequest,
  decodeResult,
  channelClient: speechMainWorldChannel,
};

export { geminiWebSpeechPlugin };
