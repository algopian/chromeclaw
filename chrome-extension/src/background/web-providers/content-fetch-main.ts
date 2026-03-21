/**
 * Content script injected into MAIN world of a provider's tab.
 * Performs fetch() with the user's session cookies and streams SSE chunks
 * back to the extension via window.postMessage().
 *
 * Injected by web-llm-bridge via chrome.scripting.executeScript.
 */

export interface ContentFetchRequest {
  type: 'WEB_LLM_FETCH';
  requestId: string;
  url: string;
  init: RequestInit;
  /**
   * Optional setup request that runs before the main fetch.
   * The JSON response is available to `urlTemplate` for variable substitution.
   * Used by providers that require session creation before streaming (e.g., Qwen).
   */
  setupRequest?: { url: string; init: RequestInit };
  /**
   * When set, the main `url` is treated as a template and `{key}` placeholders
   * are replaced with values from the setup response JSON.
   * E.g., url = "/api/completions?chat_id={id}" + setupResponse = { id: "abc" } → "/api/completions?chat_id=abc"
   */
  urlTemplate?: boolean;
  /** When set, the response uses a binary-framed protocol instead of plain SSE text. */
  binaryProtocol?: 'connect-json' | 'gemini-chunks';
  /** When true, encode the JSON body into a binary frame before sending. */
  binaryEncodeBody?: boolean;
}

/**
 * Execute a fetch in the MAIN world and stream SSE response back.
 * This function is serialized and injected into the page context.
 */
export const mainWorldFetch = async (request: ContentFetchRequest): Promise<void> => {
  const { requestId, setupRequest, urlTemplate, binaryProtocol, binaryEncodeBody } = request;
  let { url, init } = request;
  const origin = window.location.origin;

  try {
    // Optional setup step (e.g., create chat session)
    let setupData: Record<string, unknown> | undefined;
    if (setupRequest) {
      const setupResp = await fetch(setupRequest.url, {
        ...setupRequest.init,
        credentials: 'include',
      });
      if (!setupResp.ok) {
        window.postMessage(
          {
            type: 'WEB_LLM_ERROR',
            requestId,
            error: `Setup request failed: HTTP ${setupResp.status}: ${setupResp.statusText}`,
          },
          origin,
        );
        return;
      }
      setupData = await setupResp.json();

      // Substitute template variables in main URL
      // Supports both flat (data.key) and nested (data.data.key) response structures
      if (urlTemplate && setupData) {
        const flatEntries = (obj: Record<string, unknown>, prefix = ''): [string, string][] => {
          const entries: [string, string][] = [];
          for (const [key, value] of Object.entries(obj)) {
            const fullKey = prefix ? `${prefix}.${key}` : key;
            if (typeof value === 'string' || typeof value === 'number') {
              entries.push([fullKey, String(value)]);
              // Also add without prefix for convenience (last wins)
              entries.push([key, String(value)]);
            } else if (value && typeof value === 'object' && !Array.isArray(value)) {
              entries.push(...flatEntries(value as Record<string, unknown>, fullKey));
            }
          }
          return entries;
        };
        for (const [key, value] of flatEntries(setupData)) {
          url = url.replace(`{${key}}`, value);
        }
        // Also substitute in request body if it's a string (JSON body)
        if (typeof init.body === 'string') {
          let body = init.body;
          for (const [key, value] of flatEntries(setupData)) {
            body = body.replaceAll(`{${key}}`, value);
          }
          init = { ...init, body };
        }
        // Also substitute in headers (e.g. Authorization: Bearer {access_token})
        // Only matches {word_chars} patterns to avoid corrupting headers with literal braces.
        if (init.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
          const templatePattern = /\{[a-zA-Z_][a-zA-Z0-9_.]*\}/;
          const headers = { ...(init.headers as Record<string, string>) };
          for (const [hKey, hVal] of Object.entries(headers)) {
            if (typeof hVal === 'string' && templatePattern.test(hVal)) {
              for (const [key, value] of flatEntries(setupData)) {
                headers[hKey] = headers[hKey].replaceAll(`{${key}}`, value);
              }
            }
          }
          init = { ...init, headers };
        }
      }
    }

    // Gemini uses a completely different request/response format — handle it before the main fetch.
    // The MAIN world script extracts page state (f.sid, at, bl) from WIZ_global_data,
    // builds the real URL-encoded form body, and streams length-prefixed JSON chunks.
    if (binaryProtocol === 'gemini-chunks') {
      const decoder = new TextDecoder();
      let textBuffer = '';
      let prefixStripped = false;

      // Extract page state from Gemini's WIZ_global_data
      const wiz = (window as unknown as Record<string, unknown>).WIZ_global_data as Record<string, unknown> | undefined;
      const sid = wiz?.FdrFJe as string | undefined;
      const at = wiz?.SNlM0e as string | undefined;
      const bl = wiz?.cfb2h as string | undefined;

      if (!at) {
        window.postMessage(
          { type: 'WEB_LLM_ERROR', requestId, error: 'Could not extract Gemini CSRF token (at) from page. Please refresh gemini.google.com and try again.' },
          origin,
        );
        return;
      }

      // Parse the prompt from the init body (passed as JSON from buildRequest)
      let geminiPrompt = '';
      try {
        const bodyObj = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, string>;
        geminiPrompt = bodyObj.prompt ?? '';
      } catch { /* use empty */ }

      // Build the real Gemini request
      // _reqid increments by exactly 100,000 per API call in the real client.
      // We randomize it since we don't persist session-level state.
      const gemReqId = Math.floor(Math.random() * 9_000_000) + 1_000_000;
      const clientUuid = crypto.randomUUID();

      const innerJson = JSON.stringify([
        /* [0]  prompt tuple */              [geminiPrompt, 0, null, null, null, null, 0],
        /* [1]  locale */                    ['en'],
        /* [2]  unknown (10× null) */        [null, null, null, null, null, null, null, null, null, null],
        /* [3]  CSRF token (SNlM0e) */       at,
        /* [4]  */                           null,
        /* [5]  */                           null,
        /* [6]  unknown flag */              [0],
        /* [7]  unknown (1) */               1,
        /* [8]  */                           null,
        /* [9]  */                           null,
        /* [10] unknown (1) */               1,
        /* [11] unknown (0) */               0,
        /* [12–16] */                        null, null, null, null, null,
        /* [17] thinking: [[0]]=ON, [[1]]=OFF (fast) */ [[1]],
        /* [18] unknown (0) */               0,
        /* [19–26] */                        null, null, null, null, null, null, null, null,
        /* [27] unknown (1) */               1,
        /* [28–29] */                        null, null,
        /* [30] unknown */                   [4],
        /* [31–40] */                        null, null, null, null, null, null, null, null, null, null,
        /* [41] unknown */                   [1],
        /* [42–52] */                        null, null, null, null, null, null, null, null, null, null, null,
        /* [53] unknown (0) */               0,
        /* [54–58] */                        null, null, null, null, null,
        /* [59] client UUID */               clientUuid,
        /* [60] */                           null,
        /* [61] empty array */               [],
        /* [62–67] */                        null, null, null, null, null, null,
        /* [68] unknown (1) */               1,
      ]);
      const gemBody = `f.req=${encodeURIComponent(`[null,${JSON.stringify(innerJson)}]`)}&at=${encodeURIComponent(at)}`;

      const params = new URLSearchParams();
      if (bl) params.set('bl', bl);
      if (sid) params.set('f.sid', sid);
      params.set('hl', 'en');
      params.set('_reqid', String(gemReqId));
      params.set('rt', 'c');

      const gemUrl = `${url}?${params.toString()}`;

      const gemResponse = await fetch(gemUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'include',
        body: gemBody,
      });

      if (!gemResponse.ok) {
        let errorBody = '';
        try {
          errorBody = await gemResponse.text();
          if (errorBody.length > 500) errorBody = errorBody.slice(0, 500);
        } catch { /* ignore */ }
        window.postMessage(
          { type: 'WEB_LLM_ERROR', requestId, error: `HTTP ${gemResponse.status}: ${gemResponse.statusText}${errorBody ? ` — ${errorBody}` : ''}` },
          origin,
        );
        return;
      }

      const gemReader = gemResponse.body?.getReader();
      if (!gemReader) {
        window.postMessage({ type: 'WEB_LLM_ERROR', requestId, error: 'No response body from Gemini' }, origin);
        return;
      }

      while (true) {
        const { done, value } = await gemReader.read();
        if (done) break;

        textBuffer += decoder.decode(value, { stream: true });

        // Strip anti-XSS prefix `)]}'\n` on first meaningful data
        if (!prefixStripped) {
          const prefixEnd = textBuffer.indexOf('\n');
          if (prefixEnd === -1) continue; // need more data
          const prefix = textBuffer.slice(0, prefixEnd).trim();
          if (prefix === ")]}'" || prefix === ")]}'") {
            textBuffer = textBuffer.slice(prefixEnd + 1);
          }
          prefixStripped = true;
        }

        // Parse length-prefixed chunks using line-based approach.
        // Gemini format: <byte_length>\n<json_data>\n
        // Instead of tracking byte offsets (which differ from JS char offsets for
        // multi-byte content), we split on newlines and identify JSON lines by
        // checking if they start with '[' (all Gemini response chunks are arrays).
        // Numeric-only lines are length prefixes — skip them.
        while (textBuffer.includes('\n')) {
          const lineEnd = textBuffer.indexOf('\n');
          const line = textBuffer.slice(0, lineEnd).trim();
          textBuffer = textBuffer.slice(lineEnd + 1);

          // Skip empty lines and numeric length-prefix lines
          if (line.length === 0 || /^\d+$/.test(line)) continue;

          // Post JSON data lines as SSE events
          const sseChunk = `data: ${line}\n\n`;
          window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: sseChunk }, origin);
        }
      }

      // Flush any remaining text
      const finalText = decoder.decode();
      if (finalText) textBuffer += finalText;

      window.postMessage({ type: 'WEB_LLM_DONE', requestId }, origin);
      return;
    }

    // Binary frame encoding for Connect Protocol
    if (binaryProtocol === 'connect-json' && binaryEncodeBody && typeof init.body === 'string') {
      const encoder = new TextEncoder();
      const payload = encoder.encode(init.body);
      const frame = new ArrayBuffer(5 + payload.byteLength);
      const view = new DataView(frame);
      view.setUint8(0, 0x00); // flags: uncompressed
      view.setUint32(1, payload.byteLength, false); // big-endian length
      new Uint8Array(frame, 5).set(payload);
      init = { ...init, body: frame };
    }

    const response = await fetch(url, {
      ...init,
      credentials: 'include',
    });

    if (!response.ok) {
      // Read response body for diagnostic info on errors
      let errorBody = '';
      try {
        errorBody = await response.text();
        if (errorBody.length > 500) errorBody = errorBody.slice(0, 500);
      } catch { /* ignore */ }
      const errorDetail = errorBody ? ` — ${errorBody}` : '';
      window.postMessage(
        {
          type: 'WEB_LLM_ERROR',
          requestId,
          error: `HTTP ${response.status}: ${response.statusText}${errorDetail}`,
        },
        origin,
      );
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      window.postMessage({ type: 'WEB_LLM_ERROR', requestId, error: 'No response body' }, origin);
      return;
    }

    if (binaryProtocol === 'connect-json') {
      // Stream binary-framed Connect Protocol response, converting frames to SSE.
      // The first chunk is inspected to detect plain-JSON error responses (byte 0 > 0x03).
      let buffer = new Uint8Array(0);
      let isFirstChunk = true;
      let frameCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Append new bytes to buffer
        const merged = new Uint8Array(buffer.byteLength + value.byteLength);
        merged.set(buffer);
        merged.set(value, buffer.byteLength);
        buffer = merged;

        // First chunk: detect plain-JSON error (not binary-framed).
        // Valid Connect frame flags are 0x00-0x03; anything else is plain text.
        if (isFirstChunk && buffer.byteLength > 0 && buffer[0] > 0x03) {
          // Drain the rest of the response
          while (true) {
            const rest = await reader.read();
            if (rest.done) break;
            const m = new Uint8Array(buffer.byteLength + rest.value.byteLength);
            m.set(buffer);
            m.set(rest.value, buffer.byteLength);
            buffer = m;
          }
          const rawText = new TextDecoder().decode(buffer);
          try {
            const errObj = JSON.parse(rawText) as Record<string, unknown>;
            const errMsg = (errObj.message ?? errObj.error ?? errObj.code ?? rawText.slice(0, 200)) as string;
            window.postMessage(
              { type: 'WEB_LLM_ERROR', requestId, error: `Connect error: ${errMsg}` },
              origin,
            );
          } catch {
            window.postMessage(
              { type: 'WEB_LLM_ERROR', requestId, error: `Connect error: ${rawText.slice(0, 500)}` },
              origin,
            );
          }
          return;
        }
        isFirstChunk = false;

        // Extract complete frames: [flags:1][length:4][payload:length]
        while (buffer.byteLength >= 5) {
          const flags = buffer[0];
          const payloadLen = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(1, false);
          const frameLen = 5 + payloadLen;
          if (buffer.byteLength < frameLen) break; // incomplete frame

          // Trailers frame (flags & 0x02) — may contain error info
          if (flags & 0x02) {
            const trailerPayload = buffer.slice(5, frameLen);
            buffer = buffer.slice(frameLen);
            try {
              const trailerStr = new TextDecoder().decode(trailerPayload);
              const trailer = JSON.parse(trailerStr) as Record<string, unknown>;
              if (trailer.code || trailer.message) {
                const errMsg = (trailer.message ?? trailer.code ?? 'Unknown Connect error') as string;
                window.postMessage(
                  { type: 'WEB_LLM_ERROR', requestId, error: `Connect error: ${errMsg} (code: ${trailer.code ?? 'none'})` },
                  origin,
                );
                return;
              }
            } catch {
              // Non-JSON trailer — ignore
            }
            continue;
          }

          const payloadBytes = buffer.slice(5, frameLen);
          buffer = buffer.slice(frameLen);

          const jsonString = new TextDecoder().decode(payloadBytes);
          frameCount++;
          // Convert to SSE format so downstream pipeline works unchanged
          const sseChunk = `data: ${jsonString}\n\n`;
          window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: sseChunk }, origin);
        }
      }

      window.postMessage({ type: 'WEB_LLM_DONE', requestId }, origin);
    } else {
      // Standard SSE text streaming
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk }, origin);
      }

      // Flush any remaining bytes from the TextDecoder
      const finalChunk = decoder.decode();
      if (finalChunk) {
        window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: finalChunk }, origin);
      }

      window.postMessage({ type: 'WEB_LLM_DONE', requestId }, origin);
    }
  } catch (err) {
    window.postMessage(
      {
        type: 'WEB_LLM_ERROR',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      },
      origin,
    );
  }
};
