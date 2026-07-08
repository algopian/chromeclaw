/**
 * Self-contained MAIN-world BrowserChannel client for the Gemini web speech
 * endpoint (`speechs3proto2-pa.googleapis.com`).
 *
 * NOTE: This function is executed via `chrome.scripting.executeScript({ func })`
 * inside a logged-in `gemini.google.com` tab. Chrome serializes ONLY the function
 * body — module-scope imports and closures are NOT captured. Everything it needs
 * (protobuf frames) is passed in as pre-encoded base64url strings via `request`,
 * and it must not reference anything outside its own body.
 *
 * Auth model (verified against a live capture — see r20): only the
 * channel-opening `count=0` POST carries the page's public `X-Goog-Api-Key` +
 * `X-WebChannel-Content-Type`. The back-channel GET and every uplink POST send
 * NO auth headers — they authenticate purely through `credentials:'include'`,
 * which rides the first-party SAPISID/3P cookies along because this runs
 * same-origin inside the logged-in `gemini.google.com` page, plus the
 * SID/gsessionid pair returned by the probe. Attaching a `SAPISIDHASH`
 * Authorization header to the back-channel GET is what made it 400.
 *
 * Flow (BrowserChannel long-poll RPC):
 *   1. POST `count=0` probe to open the channel.
 *   2. GET back-channel (TYPE=xmlhttp) to capture SID + gsessionid.
 *   3. POST config frame   (ofs=0).
 *   4. POST audio frame(s)  (ofs=1..N).
 *   5. POST `GAE=` end frame (ofs=N+1).
 *   6. Read the back-channel body, collect all non-noop payloads, and post them
 *      to the background for decoding (finals selected by protobuf field 5).
 */

import type { SpeechFetchRequest } from '../plugin-types';

export const speechMainWorldChannel = async (request: SpeechFetchRequest): Promise<void> => {
  const { requestId, configFrame, audioFrames, endFrame } = request;
  const origin = window.location.origin;

  const post = (type: string, extra: Record<string, unknown> = {}): void => {
    window.postMessage({ type, requestId, ...extra }, origin);
  };
  const fail = (error: string): void => post('WEB_LLM_ERROR', { error });

  try {
    const BASE = 'https://speechs3proto2-pa.googleapis.com/s3web/prod/streaming/channel';
    const rand = () => Math.floor(Math.random() * 1e6).toString(36) + Date.now().toString(36);

    // ── Auth model (verified against a live capture) ─────────────────────────
    // The speech endpoint is on `googleapis.com`, so `.google.com` session
    // cookies do not auto-attach — but the first-party SAPISID/3P cookies DO
    // ride along via `credentials:'include'` because this runs inside the
    // logged-in gemini.google.com page. Only the channel-opening POST carries
    // the page's public API key + the WebChannel content-type; the back-channel
    // GET and every uplink POST authenticate purely through the included cookies
    // plus the SID/gsessionid pair. Attaching a SAPISIDHASH Authorization header
    // to the back-channel GET is what made it 400 (r20 empirical loop).

    // Extract the API key from the page's inline scripts at runtime — Google
    // rotates these keys with frontend deploys so a hardcoded value goes stale.
    const extractApiKey = (): string | undefined => {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const text = s.textContent;
        if (!text) continue;
        const match = text.match(/["']AIzaSy[A-Za-z0-9_-]{33}["']/);
        if (match) return match[0].slice(1, -1);
      }
      return undefined;
    };
    const API_KEY = extractApiKey();
    if (!API_KEY) {
      fail('Could not extract API key from gemini.google.com page. Please refresh the Gemini tab.');
      return;
    }
    post('SPEECH_DIAG', {
      msg: `apiKey extracted (${API_KEY.slice(0, 10)}…, len=${API_KEY.length})`,
    });
    const initHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Goog-Api-Key': API_KEY,
      'X-WebChannel-Content-Type': 'application/x-protobuf',
    };

    // Parse a length-prefixed BrowserChannel downlink into its JSON arrays.
    const parseArrays = (text: string): unknown[] => {
      const out: unknown[] = [];
      let i = 0;
      while (i < text.length) {
        const nl = text.indexOf('\n', i);
        if (nl === -1) break;
        const len = parseInt(text.slice(i, nl), 10);
        if (Number.isNaN(len)) break;
        // A length prefix is a byte count; a negative value would push `i`
        // backwards and spin forever (indexOf clamps negatives to 0), so bail.
        if (len < 0) break;
        const payload = text.slice(nl + 1, nl + 1 + len);
        try {
          out.push(JSON.parse(payload));
        } catch {
          /* ignore malformed chunk */
        }
        i = nl + 1 + len;
      }
      return out;
    };

    // ── Step 1: probe (count=0) — opens the channel, returns SID + gsessionid ─
    // The count=0 POST is the channel-opening request (its RID is one below the
    // first uplink's). Its response body carries the channel-established array
    // `[[0,["c","<SID>","",8,14,30000]]]`; gsessionid arrives either as the
    // `X-HTTP-Session-Id` response header (named by the probe's
    // `X-HTTP-Session-Id=gsessionid` param) or inline in the body. Both are then
    // reused verbatim on the back-channel GET and every uplink POST.
    const rid = Math.floor(Math.random() * 60000) + 1000;
    const probeUrl =
      `${BASE}?VER=8&RID=${rid}&CVER=22` + `&X-HTTP-Session-Id=gsessionid&zx=${rand()}&t=1`;
    const probeResp = await fetch(probeUrl, {
      method: 'POST',
      headers: initHeaders,
      credentials: 'include',
      body: 'count=0',
    });
    const probeText = await probeResp.text().catch(() => '');
    if (!probeResp.ok) {
      fail(
        `Speech probe failed (HTTP ${probeResp.status})${probeText ? `: ${probeText.slice(0, 200)}` : ''}`,
      );
      return;
    }

    let sid: string | undefined;
    let gsessionid: string | undefined;
    for (const arr of parseArrays(probeText)) {
      // Shape: [[<id>,["c","<SID>","",8,14,30000]]]
      if (Array.isArray(arr)) {
        for (const entry of arr as unknown[]) {
          if (Array.isArray(entry) && Array.isArray(entry[1])) {
            const inner = entry[1] as unknown[];
            if (inner[0] === 'c' && typeof inner[1] === 'string') sid = inner[1];
          }
        }
      }
    }
    let gsSource: 'header' | 'body' | 'none' = 'none';
    gsessionid = probeResp.headers.get('X-HTTP-Session-Id') ?? undefined;
    if (gsessionid) {
      gsSource = 'header';
    } else {
      const gsMatch = probeText.match(/"gsessionid"\s*,\s*"([^"]+)"/);
      if (gsMatch) {
        gsessionid = gsMatch[1];
        gsSource = 'body';
      }
    }

    // Surfaced in failure text so a live reload reveals whether the probe yielded
    // what the back-channel needs (r20 empirical loop). gsessionid is expected via
    // the X-HTTP-Session-Id response header; if it's not CORS-exposed, gs=none and
    // the back-channel 400s. Values are lengths only — never the raw tokens.
    const probeDiag =
      `sidLen=${sid?.length ?? 0} gs=${gsSource}${gsessionid ? `(${gsessionid.length})` : ''} ` +
      `hdrs=[${Array.from(probeResp.headers.keys()).join(',')}]`;

    if (!sid) {
      fail(
        `Speech channel did not return a SID — session may not be authorized.${probeText ? ` Probe said: ${probeText.slice(0, 200)}` : ''}`,
      );
      return;
    }

    // ── Step 2: open the back-channel (server→client stream) ─────────────────
    // Fire-and-forget GET — the reference client starts this WITHOUT awaiting it,
    // then immediately sends config+audio. The server buffers downlink arrays
    // while we push. We only drain the response AFTER all uplinks are sent.
    const bcUrl =
      `${BASE}?${gsessionid ? `gsessionid=${encodeURIComponent(gsessionid)}&` : ''}` +
      `VER=8&RID=rpc&SID=${encodeURIComponent(sid)}&AID=0&CI=0&TYPE=xmlhttp&zx=${rand()}&t=1`;
    const bcPromise = fetch(bcUrl, {
      method: 'GET',
      credentials: 'include',
    });

    // ── Uplink helper ────────────────────────────────────────────────────────
    let ofs = 0;
    let uplinkRid = rid + 1;
    const sendFrame = async (frameB64Url: string): Promise<void> => {
      const gsParam = gsessionid ? `&gsessionid=${encodeURIComponent(gsessionid)}` : '';
      const url =
        `${BASE}?VER=8${gsParam}&SID=${encodeURIComponent(sid!)}` +
        `&RID=${uplinkRid++}&AID=0&zx=${rand()}&t=1`;
      const body = `count=1&ofs=${ofs++}&` + `req0___data__=${encodeURIComponent(frameB64Url)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'include',
        body,
      });
      if (!resp.ok) {
        throw new Error(`uplink ofs=${ofs - 1} failed (HTTP ${resp.status})`);
      }
    };

    // ── Steps 3–5: config → audio → end ──────────────────────────────────────
    await sendFrame(configFrame);
    for (const frame of audioFrames) await sendFrame(frame);
    await sendFrame(endFrame);

    // ── Step 6: drain the back-channel for result payloads ─────────────────
    // Now that all uplinks are sent, await the back-channel response and drain.
    const bcResp = await bcPromise;
    if (!bcResp.ok) {
      const body = await bcResp.text().catch(() => '');
      fail(
        `Speech back-channel failed (HTTP ${bcResp.status}) [${probeDiag}]${body ? `: ${body.slice(0, 200)}` : ''}`,
      );
      return;
    }
    const reader = bcResp.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const payloads: string[] = [];
    let noopCount = 0;
    let totalFrames = 0;
    let closedByServer = false;

    /**
     * Extract non-noop payload strings from accumulated downlink text.
     * Returns the unconsumed remainder (partial frame spanning a chunk boundary).
     */
    const extractPayloads = (text: string): string => {
      let i = 0;
      while (i < text.length) {
        const nl = text.indexOf('\n', i);
        if (nl === -1) break;
        const len = parseInt(text.slice(i, nl), 10);
        if (Number.isNaN(len) || len < 0) break;
        if (nl + 1 + len > text.length) break; // incomplete frame — keep remainder
        const payload = text.slice(nl + 1, nl + 1 + len);
        try {
          const arr = JSON.parse(payload);
          if (Array.isArray(arr)) {
            for (const entry of arr as unknown[]) {
              if (Array.isArray(entry) && Array.isArray(entry[1])) {
                const inner = entry[1] as unknown[];
                const p = inner[0];
                totalFrames++;
                if (p === 'noop') {
                  noopCount++;
                } else if (p === 'close' || p === 'stop') {
                  // BrowserChannel session-termination signal — stop draining.
                  closedByServer = true;
                } else if (typeof p === 'string') {
                  payloads.push(p);
                }
              }
            }
          }
        } catch {
          /* malformed chunk */
        }
        i = nl + 1 + len;
      }
      return text.slice(i);
    };

    if (reader) {
      // Bound the drain so a hung channel can't wedge the injected script; the
      // background bridge also enforces its own timeout.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !closedByServer) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = extractPayloads(buffer);
      }
    } else {
      extractPayloads(await bcResp.text().catch(() => ''));
    }

    if (payloads.length === 0) {
      fail(
        `Speech channel closed without returning result frames ` +
          `(totalFrames=${totalFrames} noop=${noopCount} ` +
          `closedByServer=${closedByServer} [${probeDiag}]).`,
      );
      return;
    }

    // Post all collected payloads to the background for decoding + final selection.
    post('SPEECH_RESULT', { payloads });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
};
