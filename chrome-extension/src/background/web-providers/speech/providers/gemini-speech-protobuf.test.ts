/**
 * Round-trip tests for the hand-rolled Gemini web speech protobuf codec.
 *
 * The captured config frame (base64url) is the byte-for-byte fixture the encoder
 * must reproduce for `lang === 'en'`; the transcript / interim / end fixtures
 * exercise the response decoder's nested field walk (1253625 → 1 → 7 → 3 → 1)
 * and the `isFinal` flag (field 5).
 */
import {
  encodeConfigFrame,
  encodeAudioFrame,
  END_FRAME,
  toBase64Url,
  fromBase64Url,
  decodeResult,
  decodeResultB64Url,
  parseFields,
} from './gemini-speech-protobuf';
import { describe, expect, it } from 'vitest';

// ── Captured fixtures (base64url) ────────────────────────────────────────────
// The 98-byte config frame the live session sent for English.
const CONFIG_EN_B64URL =
  'ChViZXlvbmQtYTJhLXJlY29nbml6ZXIQAcKIjwEGEgQKAmVu4o6PAQkVAAB6RhgLIAGCx48BGBIRYmFyZC13ZWItZnJvbnRlbmRCA1dlYqLmjwEOCgRSAmVuKAHAAgGgAwE';
// A final downlink frame carrying the transcript "hello world".
const FINAL_FRAME_B64URL = 'KAHKj-QEEwoROg8aDQoLaGVsbG8gd29ybGQ';
// An interim frame: only timing metadata under field 2, no transcript path.
const INTERIM_FRAME_B64URL = 'EHs';

describe('speech-protobuf — config frame encoder', () => {
  it('reproduces the captured English config frame byte-for-byte', () => {
    const frame = encodeConfigFrame('en');
    expect(frame).toBeInstanceOf(Uint8Array);
    expect(frame.length).toBe(98);
    expect(toBase64Url(frame)).toBe(CONFIG_EN_B64URL);
  });

  it('defaults to English when no language is given', () => {
    expect(toBase64Url(encodeConfigFrame())).toBe(CONFIG_EN_B64URL);
  });

  it('substitutes the language into both language slots', () => {
    const en = encodeConfigFrame('en');
    const fr = encodeConfigFrame('fr');
    // Same 2-char language code → same overall length, different bytes.
    expect(fr.length).toBe(en.length);
    expect(toBase64Url(fr)).not.toBe(toBase64Url(en));
  });

  it('starts with the recognizer id string field', () => {
    const fields = parseFields(encodeConfigFrame('en'));
    const recognizer = fields.find(f => f.field === 1 && f.bytes);
    expect(recognizer).toBeDefined();
    expect(new TextDecoder().decode(recognizer!.bytes!)).toBe('beyond-a2a-recognizer');
  });
});

describe('speech-protobuf — audio frame encoder', () => {
  it('wraps container bytes under field 293101 → 1', () => {
    const container = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
    const frame = encodeAudioFrame(container);
    const top = parseFields(frame);
    const outer = top.find(f => f.field === 293101 && f.bytes);
    expect(outer).toBeDefined();
    const inner = parseFields(outer!.bytes!).find(f => f.field === 1 && f.bytes);
    expect(inner).toBeDefined();
    expect(Array.from(inner!.bytes!)).toEqual(Array.from(container));
  });

  it('preserves empty audio payloads', () => {
    const frame = encodeAudioFrame(new Uint8Array(0));
    const outer = parseFields(frame).find(f => f.field === 293101 && f.bytes);
    const inner = parseFields(outer!.bytes!).find(f => f.field === 1);
    expect(inner?.bytes?.length ?? 0).toBe(0);
  });
});

describe('speech-protobuf — end sentinel', () => {
  it('is the { 3: 1 } frame encoded as base64url "GAE"', () => {
    expect(Array.from(END_FRAME)).toEqual([0x18, 0x01]);
    expect(toBase64Url(END_FRAME)).toBe('GAE');
  });
});

describe('speech-protobuf — base64url round-trip', () => {
  it('round-trips arbitrary bytes including high values and zero', () => {
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 255, 128, 64]);
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
  });

  it('produces url-safe output (no +, / or = padding)', () => {
    // 0xff 0xef 0xbe would contain + and / in standard base64.
    const encoded = toBase64Url(new Uint8Array([0xff, 0xef, 0xbe, 0x00, 0x10]));
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('decodes pad-less base64url input', () => {
    // Encoder strips padding; decoder must re-add it internally.
    const encoded = toBase64Url(new Uint8Array([1, 2, 3]));
    expect(Array.from(fromBase64Url(encoded))).toEqual([1, 2, 3]);
  });
});

describe('speech-protobuf — response decoder', () => {
  it('decodes a final frame transcript via the nested field path', () => {
    const result = decodeResultB64Url(FINAL_FRAME_B64URL);
    expect(result.isFinal).toBe(true);
    expect(result.transcript).toBe('hello world');
  });

  it('decodeResult and decodeResultB64Url agree', () => {
    const bytes = fromBase64Url(FINAL_FRAME_B64URL);
    expect(decodeResult(bytes)).toEqual(decodeResultB64Url(FINAL_FRAME_B64URL));
  });

  it('returns an empty transcript for interim frames without the text path', () => {
    const result = decodeResultB64Url(INTERIM_FRAME_B64URL);
    expect(result.isFinal).toBe(false);
    expect(result.transcript).toBe('');
  });

  it('never throws on truncated / garbage input', () => {
    expect(() => decodeResult(new Uint8Array([0xff, 0xff, 0xff]))).not.toThrow();
    expect(decodeResult(new Uint8Array(0))).toEqual({ isFinal: false, transcript: '' });
  });
});
