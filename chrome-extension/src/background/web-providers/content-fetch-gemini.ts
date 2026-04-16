/**
 * MAIN world content script for Gemini (gemini.google.com).
 *
 * Extracts page state (f.sid, at, bl) from WIZ_global_data, builds the real
 * URL-encoded form body, and streams length-prefixed JSON chunks back to the
 * extension via window.postMessage().
 *
 * NOTE: This function is executed via chrome.scripting.executeScript({func}).
 * Chrome serializes ONLY the function body — module-scope imports and closures
 * are NOT captured. The function must be entirely self-contained.
 */

import type { ContentFetchRequest } from './content-fetch-main';

export const geminiMainWorldFetch = async (request: ContentFetchRequest): Promise<void> => {
  const { requestId, url, init } = request;
  const origin = window.location.origin;

  const decoder = new TextDecoder();
  let textBuffer = '';
  let prefixStripped = false;

  // Extract page state from Gemini's WIZ_global_data
  const wiz = (window as unknown as Record<string, unknown>).WIZ_global_data as
    | Record<string, unknown>
    | undefined;
  const sid = wiz?.FdrFJe as string | undefined;
  const at = wiz?.SNlM0e as string | undefined;
  const bl = wiz?.cfb2h as string | undefined;

  if (!at) {
    window.postMessage(
      {
        type: 'WEB_LLM_ERROR',
        requestId,
        error:
          'Could not extract Gemini CSRF token (at) from page. Please refresh gemini.google.com and try again.',
      },
      origin,
    );
    return;
  }

  // Parse the prompt from the init body (passed as JSON from buildRequest)
  let geminiPrompt = '';
  let geminiThinkingLevel = 'fast';
  try {
    const bodyObj = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
      string,
      string
    >;
    geminiPrompt = bodyObj.prompt ?? '';
    geminiThinkingLevel = bodyObj.thinkingLevel ?? 'fast';
  } catch {
    /* use empty */
  }

  // Build the real Gemini request
  // _reqid increments by exactly 100,000 per API call in the real client.
  // We randomize it since we don't persist session-level state.
  const gemReqId = Math.floor(Math.random() * 9_000_000) + 1_000_000;
  const clientUuid = crypto.randomUUID();

  // Thinking flag: [[0]] = thinking ON, [[1]] = thinking OFF (fast)
  const thinkingFlag = geminiThinkingLevel === 'thinking' ? [[0]] : [[1]];

  // prettier-ignore
  const innerJson = JSON.stringify([
    /* [0]  prompt tuple */              [geminiPrompt, 0, null, null, null, null, 0],
    /* [1]  locale */                    ['en'],
    /* [2]  unknown (10x null) */        [null, null, null, null, null, null, null, null, null, null],
    /* [3]  CSRF token (SNlM0e) */       at,
    /* [4]  */                           null,
    /* [5]  */                           null,
    /* [6]  unknown flag */              [0],
    /* [7]  unknown (1) */               1,
    /* [8]  */                           null,
    /* [9]  */                           null,
    /* [10] unknown (1) */               1,
    /* [11] unknown (0) */               0,
    /* [12-16] */                        null, null, null, null, null,
    /* [17] thinking: [[0]]=ON, [[1]]=OFF (fast) */ thinkingFlag,
    /* [18] unknown (0) */               0,
    /* [19-26] */                        null, null, null, null, null, null, null, null,
    /* [27] unknown (1) */               1,
    /* [28-29] */                        null, null,
    /* [30] unknown */                   [4],
    /* [31-40] */                        null, null, null, null, null, null, null, null, null, null,
    /* [41] unknown */                   [1],
    /* [42-44] */                        null, null, null,
    /* [45] temp chat (1=ephemeral) */   1,
    /* [46-52] */                        null, null, null, null, null, null, null,
    /* [53] unknown (0) */               0,
    /* [54-58] */                        null, null, null, null, null,
    /* [59] client UUID */               clientUuid,
    /* [60] */                           null,
    /* [61] empty array */               [],
    /* [62-67] */                        null, null, null, null, null, null,
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
    } catch {
      /* ignore */
    }
    window.postMessage(
      {
        type: 'WEB_LLM_ERROR',
        requestId,
        error: `HTTP ${gemResponse.status}: ${gemResponse.statusText}${errorBody ? ` — ${errorBody}` : ''}`,
      },
      origin,
    );
    return;
  }

  const gemReader = gemResponse.body?.getReader();
  if (!gemReader) {
    window.postMessage(
      { type: 'WEB_LLM_ERROR', requestId, error: 'No response body from Gemini' },
      origin,
    );
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
};
