/**
 * Tests for the back-channel frame extraction and multi-final decode logic.
 *
 * These exercise the bug-fix path: the injected client collects ALL non-noop
 * payloads from [[<arrayId>, ["<payload>"]]] frames, and the bridge decodes
 * each, selects finals by protobuf field 5, and concatenates in order.
 */
import { describe, expect, it } from 'vitest';
import { decodeResult as assembleTranscript } from './gemini-web.speech';
import { decodeResultB64Url, fromBase64Url, toBase64 } from './gemini-speech-protobuf';

// ── Captured wire data (standard base64, as the server sends) ────────────────
// From a real backchannel-results.txt capture. Wire uses standard base64 with
// + and = characters. decodeResultB64Url handles both standard and url-safe.
const INTERIM_PAYLOAD = 'KADKj+QEDBIKCAAQgIgnGICIJw==';
const FINAL_PAYLOAD_WEATHER = 'KAHKj+QEGwoZCAA6FRoTChFXZWF0aGVyIHRvbW9ycm93Lg==';
// Synthetic second final (field 5 = 1, transcript "Hello world")
const FINAL_PAYLOAD_HELLO = 'KAHKj-QEEwoROg8aDQoLaGVsbG8gd29ybGQ';

// ── Simulated BrowserChannel downlink text ───────────────────────────────────
// Format: <byteLength>\n<json>
// Each JSON payload is [[<arrayId>, ["<payloadString>"]]]
const makeFrame = (arrayId: number, payload: string): string => {
  const json = JSON.stringify([[arrayId, [payload]]]);
  return `${json.length}\n${json}`;
};

const DOWNLINK_MIXED =
  makeFrame(1, 'noop') +
  makeFrame(2, INTERIM_PAYLOAD) +
  makeFrame(3, FINAL_PAYLOAD_WEATHER);

const DOWNLINK_MULTI_FINAL =
  makeFrame(1, 'noop') +
  makeFrame(2, FINAL_PAYLOAD_HELLO) +
  makeFrame(3, 'noop') +
  makeFrame(4, FINAL_PAYLOAD_WEATHER);

const DOWNLINK_NOOP_ONLY = makeFrame(1, 'noop') + makeFrame(2, 'noop');

// ── Frame extraction (replicates the injected client logic) ──────────────────
// Since extractPayloads is inside the non-exported injected function, we
// replicate its logic here to prove correctness against the wire format.
const extractPayloads = (text: string): { payloads: string[]; noopCount: number } => {
  const payloads: string[] = [];
  let noopCount = 0;
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    if (nl === -1) break;
    const len = parseInt(text.slice(i, nl), 10);
    if (Number.isNaN(len) || len < 0) break;
    if (nl + 1 + len > text.length) break;
    const payload = text.slice(nl + 1, nl + 1 + len);
    try {
      const arr = JSON.parse(payload);
      if (Array.isArray(arr)) {
        for (const entry of arr as unknown[]) {
          if (Array.isArray(entry) && Array.isArray(entry[1])) {
            const inner = entry[1] as unknown[];
            const p = inner[0];
            if (p === 'noop') {
              noopCount++;
            } else if (typeof p === 'string') {
              payloads.push(p);
            }
          }
        }
      }
    } catch {
      /* skip */
    }
    i = nl + 1 + len;
  }
  return { payloads, noopCount };
};

// ── Bridge decode logic (replicates the listener's decode + final selection) ─
const decodeAndConcatenate = (
  payloads: string[],
): { transcript: string; finalCount: number; interimCount: number } => {
  const decoded = payloads
    .filter((p): p is string => typeof p === 'string')
    .map(p => decodeResultB64Url(p));
  const finals = decoded.filter(d => d.isFinal && d.transcript);
  const transcript = finals.map(f => f.transcript).join(' ');
  return {
    transcript,
    finalCount: finals.length,
    interimCount: decoded.filter(d => !d.isFinal).length,
  };
};

describe('speech-bridge decode — frame extraction from wire format', () => {
  it('extracts non-noop payloads from [[arrayId, ["payload"]]] frames', () => {
    const { payloads, noopCount } = extractPayloads(DOWNLINK_MIXED);
    expect(noopCount).toBe(1);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toBe(INTERIM_PAYLOAD);
    expect(payloads[1]).toBe(FINAL_PAYLOAD_WEATHER);
  });

  it('handles noop-only streams (no result payloads)', () => {
    const { payloads, noopCount } = extractPayloads(DOWNLINK_NOOP_ONLY);
    expect(noopCount).toBe(2);
    expect(payloads).toHaveLength(0);
  });

  it('handles multiple finals interspersed with noops', () => {
    const { payloads, noopCount } = extractPayloads(DOWNLINK_MULTI_FINAL);
    expect(noopCount).toBe(2);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toBe(FINAL_PAYLOAD_HELLO);
    expect(payloads[1]).toBe(FINAL_PAYLOAD_WEATHER);
  });

  it('handles partial frames at chunk boundaries (incomplete length prefix)', () => {
    // Simulate a chunk that cuts mid-frame
    const full = makeFrame(1, FINAL_PAYLOAD_WEATHER);
    const partial = full.slice(0, full.length - 5);
    const { payloads } = extractPayloads(partial);
    expect(payloads).toHaveLength(0); // incomplete frame is not extracted
  });

  it('handles empty input', () => {
    const { payloads, noopCount } = extractPayloads('');
    expect(payloads).toHaveLength(0);
    expect(noopCount).toBe(0);
  });
});

describe('speech-bridge decode — final selection by protobuf field 5', () => {
  it('selects finals (isFinal=true) and concatenates transcripts in order', () => {
    const { payloads } = extractPayloads(DOWNLINK_MULTI_FINAL);
    const result = decodeAndConcatenate(payloads);
    expect(result.finalCount).toBe(2);
    expect(result.transcript).toBe('hello world Weather tomorrow.');
  });
  it('filters out interims (isFinal=false) from the transcript', () => {
    const { payloads } = extractPayloads(DOWNLINK_MIXED);
    const result = decodeAndConcatenate(payloads);
    expect(result.finalCount).toBe(1);
    expect(result.interimCount).toBe(1);
    expect(result.transcript).toBe('Weather tomorrow.');
  });

  it('returns empty transcript when all payloads are interim', () => {
    const result = decodeAndConcatenate([INTERIM_PAYLOAD, INTERIM_PAYLOAD]);
    expect(result.finalCount).toBe(0);
    expect(result.transcript).toBe('');
  });

  it('decodes standard base64 payloads (with + and =) from the wire', () => {
    // The wire sends standard base64, not base64url
    const result = decodeAndConcatenate([FINAL_PAYLOAD_WEATHER]);
    expect(result.transcript).toBe('Weather tomorrow.');
  });

  it('handles a single final payload correctly', () => {
    const result = decodeAndConcatenate([FINAL_PAYLOAD_HELLO]);
    expect(result.finalCount).toBe(1);
    expect(result.transcript).toBe('hello world');
  });
});

// ── Live wire shape regression — drives the REAL exported assembler ──────────
// The blocks above replicate the assembly logic locally; they never exercised
// the shipped `decodeResult`, so the finals-only bug slipped through. These
// tests import the real assembler and reproduce the field shape seen in
// production: the server streams the transcript on INTERIM frames (isFinal=0,
// cumulative) and closes with a bare `{isFinal:1}` marker that carries no text.
//
// Fixtures are derived from the captured payloads by flipping ONLY the field-5
// (isFinal) varint at byte index 1 (byte 0 is the 0x28 field-5 tag) — so no
// protobuf is hand-rolled; the transcript bytes are the captured ones.
const flipIsFinalToInterim = (b64: string): string =>
  toBase64(Uint8Array.from(fromBase64Url(b64), (b, i) => (i === 1 ? 0 : b)));

const WEATHER_AS_INTERIM = flipIsFinalToInterim(FINAL_PAYLOAD_WEATHER);
const HELLO_AS_INTERIM = flipIsFinalToInterim(FINAL_PAYLOAD_HELLO);
// Bare end marker: field-5 tag + varint 1, no transcript payload (first 2 bytes).
const BARE_FINAL_MARKER = toBase64(fromBase64Url(FINAL_PAYLOAD_WEATHER).slice(0, 2));

describe('assembleTranscript (real decodeResult) — live frame shapes', () => {
  it('sanity: derived interim carries text but is not final', () => {
    const d = decodeResultB64Url(WEATHER_AS_INTERIM);
    expect(d.isFinal).toBe(false);
    expect(d.transcript).toBe('Weather tomorrow.');
  });

  it('sanity: derived bare marker is final with no text', () => {
    const d = decodeResultB64Url(BARE_FINAL_MARKER);
    expect(d.isFinal).toBe(true);
    expect(d.transcript).toBe('');
  });

  it('recovers text from cumulative interims + bare final marker (the bug)', () => {
    // Regression: the shipped finals-only assembly returned '' for this input,
    // which is exactly the reported "dictates nothing, no error" failure.
    expect(assembleTranscript([WEATHER_AS_INTERIM, BARE_FINAL_MARKER])).toBe('Weather tomorrow.');
  });

  it('takes the LAST interim when several accumulate before the marker', () => {
    // Interims are cumulative, so the final utterance is the last non-empty one.
    expect(assembleTranscript([HELLO_AS_INTERIM, WEATHER_AS_INTERIM, BARE_FINAL_MARKER])).toBe(
      'Weather tomorrow.',
    );
  });

  it('still prefers text-carrying finals when present (captured fixture shape)', () => {
    expect(assembleTranscript([FINAL_PAYLOAD_HELLO, FINAL_PAYLOAD_WEATHER])).toBe(
      'hello world Weather tomorrow.',
    );
  });

  it('throws when no frame is final (unchanged contract)', () => {
    expect(() => assembleTranscript([WEATHER_AS_INTERIM])).toThrow(/none were final/);
  });

  it('returns empty on a genuine no-speech ack (bare marker only)', () => {
    expect(assembleTranscript([BARE_FINAL_MARKER])).toBe('');
  });
});
