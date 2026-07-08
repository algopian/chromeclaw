/**
 * Minimal hand-rolled protobuf codec for the Gemini web speech BrowserChannel
 * ("beyond-a2a-recognizer") wire format. No protobuf runtime dependency — we
 * only need to encode three request frames (config / audio / end) and decode
 * the single final-transcript response frame.
 *
 * Field layout was reverse-engineered from a captured live session (see
 * `.dev/requirements/r20-browser-stt-gemini-web.md`). The encoders reproduce the
 * captured config frame byte-for-byte when `lang === 'en'`, which the unit tests
 * assert against the recorded base64 fixture.
 *
 * This module lives in the BACKGROUND (not the injected MAIN-world script) so it
 * is importable and unit-testable. The MAIN-world BrowserChannel client receives
 * these frames pre-encoded as base64url strings and only performs the HTTP dance.
 */

// ── Wire-type constants ──────────────────────────────────────────────────────
const WIRE_VARINT = 0;
const WIRE_I32 = 5;
const WIRE_LEN = 2;

// ── Field numbers (from the captured "beyond-a2a-recognizer" schema) ─────────
const F_RECOGNIZER = 1; // string "beyond-a2a-recognizer"
const F_FLAG2 = 2; // varint 1
const F_LANG_A = 293000; // { 2: { 1: <lang> } }
const F_AUDIO_META = 293100; // { 2: float(sampleRate), 3: encoding, 4: channels }
const F_AUDIO_DATA = 293101; // { 1: <container bytes> }
const F_CLIENT = 294000; // { 2: "bard-web-frontend", 8: "Web" }
const F_LANG_B = 294500; // { 1: { 10: <lang> }, 5: 1, 40: 1, 52: 1 }

// Response field path: field 5 = isFinal; field 1253625 → 1 → 7 → 3 → 1 = text.
const F_IS_FINAL = 5;
const F_RESULT = 1253625;

const RECOGNIZER_ID = 'beyond-a2a-recognizer';
const CLIENT_NAME = 'bard-web-frontend';
const CLIENT_PLATFORM = 'Web';
const SAMPLE_RATE_HZ = 16000;
const ENCODING_WEBM_OPUS = 11;
const CHANNELS = 1;

/** The stream-end sentinel frame (`{ 3: 1 }`), base64url "GAE=". */
const END_FRAME: Uint8Array = new Uint8Array([0x18, 0x01]);

// ── Low-level writer ─────────────────────────────────────────────────────────

/** Growable byte buffer with protobuf primitive writers. */
class ProtoWriter {
  private bytes: number[] = [];

  varint(value: number): void {
    if (value < 0) throw new Error('varint cannot encode negative values');
    // BigInt-free loop using modulo (not bitwise, which truncates to 32-bit) —
    // safe for field numbers and lengths up to 2^53.
    let n = value;
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte += 128;
      this.bytes.push(byte);
    } while (n > 0);
  }

  tag(field: number, wire: number): void {
    this.varint(field * 8 + wire);
  }

  varintField(field: number, value: number): void {
    this.tag(field, WIRE_VARINT);
    this.varint(value);
  }

  /** 32-bit little-endian float (wire type 5). */
  floatField(field: number, value: number): void {
    this.tag(field, WIRE_I32);
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, value, true);
    const view = new Uint8Array(buf);
    for (const b of view) this.bytes.push(b);
  }

  lenField(field: number, payload: Uint8Array): void {
    this.tag(field, WIRE_LEN);
    this.varint(payload.length);
    for (const b of payload) this.bytes.push(b);
  }

  stringField(field: number, value: string): void {
    this.lenField(field, new TextEncoder().encode(value));
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

// ── Frame encoders ───────────────────────────────────────────────────────────

/**
 * Build the initial config frame. Reproduces the captured 98-byte frame exactly
 * when `lang === 'en'`. The language is substituted into both language slots
 * (293000→2→1 and 294500→1→10).
 */
const encodeConfigFrame = (lang = 'en'): Uint8Array => {
  const w = new ProtoWriter();
  w.stringField(F_RECOGNIZER, RECOGNIZER_ID);
  w.varintField(F_FLAG2, 1);

  // 293000: { 2: { 1: <lang> } }
  const langInner = new ProtoWriter();
  langInner.stringField(1, lang);
  const langA = new ProtoWriter();
  langA.lenField(2, langInner.toUint8Array());
  w.lenField(F_LANG_A, langA.toUint8Array());

  // 293100: { 2: float(16000), 3: 11, 4: 1 }
  const audioMeta = new ProtoWriter();
  audioMeta.floatField(2, SAMPLE_RATE_HZ);
  audioMeta.varintField(3, ENCODING_WEBM_OPUS);
  audioMeta.varintField(4, CHANNELS);
  w.lenField(F_AUDIO_META, audioMeta.toUint8Array());

  // 294000: { 2: "bard-web-frontend", 8: "Web" }
  const client = new ProtoWriter();
  client.stringField(2, CLIENT_NAME);
  client.stringField(8, CLIENT_PLATFORM);
  w.lenField(F_CLIENT, client.toUint8Array());

  // 294500: { 1: { 10: <lang> }, 5: 1, 40: 1, 52: 1 }
  const langBInner = new ProtoWriter();
  langBInner.stringField(10, lang);
  const langB = new ProtoWriter();
  langB.lenField(1, langBInner.toUint8Array());
  langB.varintField(5, 1);
  langB.varintField(40, 1);
  langB.varintField(52, 1);
  w.lenField(F_LANG_B, langB.toUint8Array());

  return w.toUint8Array();
};

/**
 * Wrap raw audio container bytes (WebM/Opus, EBML magic `1a45dfa3`) as an audio
 * frame: `{ 293101: { 1: <bytes> } }`.
 */
const encodeAudioFrame = (containerBytes: Uint8Array): Uint8Array => {
  const inner = new ProtoWriter();
  inner.lenField(1, containerBytes);
  const w = new ProtoWriter();
  w.lenField(F_AUDIO_DATA, inner.toUint8Array());
  return w.toUint8Array();
};

// ── base64 helpers ───────────────────────────────────────────────────────────

/** Standard base64 (with padding). This is what the speech server expects. */
const toBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** URL-safe base64 (no padding, - and _ instead of + and /). Used internally. */
const toBase64Url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (b64url: string): Uint8Array => {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// ── Response decoder ─────────────────────────────────────────────────────────

interface ProtoField {
  field: number;
  wire: number;
  /** varint value (wire 0) */
  varint?: number;
  /** length-delimited payload (wire 2) */
  bytes?: Uint8Array;
}

/** Read a varint starting at `pos`; returns [value, nextPos]. */
const readVarint = (buf: Uint8Array, pos: number): [number, number] => {
  let result = 0;
  let shift = 0;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, p];
};

/** Shallow-parse a protobuf message into its top-level fields. */
const parseFields = (buf: Uint8Array): ProtoField[] => {
  const fields: ProtoField[] = [];
  let p = 0;
  while (p < buf.length) {
    const [tag, np] = readVarint(buf, p);
    p = np;
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === WIRE_VARINT) {
      const [val, np2] = readVarint(buf, p);
      p = np2;
      fields.push({ field, wire, varint: val });
    } else if (wire === WIRE_LEN) {
      const [len, np2] = readVarint(buf, p);
      p = np2;
      fields.push({ field, wire, bytes: buf.slice(p, p + len) });
      p += len;
    } else if (wire === WIRE_I32) {
      p += 4;
      fields.push({ field, wire });
    } else if (wire === 1) {
      p += 8;
      fields.push({ field, wire });
    } else {
      break; // unknown wire type — stop
    }
  }
  return fields;
};

/** Find the first length-delimited child with the given field number. */
const findLen = (fields: ProtoField[], field: number): Uint8Array | undefined =>
  fields.find(f => f.field === field && f.bytes)?.bytes;

interface DecodedResult {
  isFinal: boolean;
  transcript: string;
}

/**
 * Decode a response frame (the base64 payload inside a `[[2|3, ["…"]]]` downlink
 * array). Walks field 5 (isFinal) and the transcript path
 * 1253625 → 1 → 7 → 3 → 1. Returns an empty transcript when the path is absent
 * (e.g. interim frames that only carry timing metadata under field 2).
 */
const decodeResult = (bytes: Uint8Array): DecodedResult => {
  const top = parseFields(bytes);
  const isFinal = top.find(f => f.field === F_IS_FINAL)?.varint === 1;

  let transcript = '';
  const resultBytes = findLen(top, F_RESULT);
  if (resultBytes) {
    const l1 = findLen(parseFields(resultBytes), 1);
    if (l1) {
      const l7 = findLen(parseFields(l1), 7);
      if (l7) {
        const l3 = findLen(parseFields(l7), 3);
        if (l3) {
          const l1b = findLen(parseFields(l3), 1);
          if (l1b) transcript = new TextDecoder().decode(l1b);
        }
      }
    }
  }
  return { isFinal, transcript };
};

/** Convenience: decode straight from a base64url frame string. */
const decodeResultB64Url = (b64url: string): DecodedResult => decodeResult(fromBase64Url(b64url));

export {
  encodeConfigFrame,
  encodeAudioFrame,
  END_FRAME,
  toBase64,
  toBase64Url,
  fromBase64Url,
  decodeResult,
  decodeResultB64Url,
  parseFields,
  readVarint,
};
export type { DecodedResult, ProtoField };
