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
  binaryProtocol?: 'connect-json' | 'gemini-chunks' | 'glm-intl';
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
      try {
        const bodyObj = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
          string,
          string
        >;
        geminiPrompt = bodyObj.prompt ?? '';
      } catch {
        /* use empty */
      }

      // Build the real Gemini request
      // _reqid increments by exactly 100,000 per API call in the real client.
      // We randomize it since we don't persist session-level state.
      const gemReqId = Math.floor(Math.random() * 9_000_000) + 1_000_000;
      const clientUuid = crypto.randomUUID();

      // prettier-ignore
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
      return;
    }

    // GLM International (chat.z.ai) — build the full request in MAIN world.
    // Requires localStorage JWT, browser fingerprint telemetry, and X-Signature.
    if (binaryProtocol === 'glm-intl') {
      // Parse the prompt and optional chatId from the lightweight stub body
      let glmPrompt = '';
      let existingChatId = '';
      let glmModel = 'glm-5';
      try {
        const bodyObj = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
          string,
          string
        >;
        glmPrompt = bodyObj.prompt ?? '';
        existingChatId = bodyObj.chatId ?? '';
        if (bodyObj.model) glmModel = bodyObj.model;
      } catch {
        /* use defaults */
      }

      // Read JWT from localStorage
      const token = localStorage.getItem('token') ?? '';
      if (!token) {
        window.postMessage(
          {
            type: 'WEB_LLM_ERROR',
            requestId,
            error:
              'No auth token found. Make sure you have an account and can use the model at https://chat.z.ai, then reconnect via Settings → Models.',
          },
          origin,
        );
        return;
      }

      // Decode user_id from JWT payload
      let userId = '';
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        userId = payload.id ?? '';
      } catch {
        /* ignore */
      }

      // Create a new chat session if we don't have a chatId
      let chatId = existingChatId;
      const msgId = crypto.randomUUID();
      const msgTimestamp = Math.floor(Date.now() / 1000);

      if (!chatId) {
        try {
          const createRes = await fetch('https://chat.z.ai/api/v1/chats/new', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'Accept-Language': 'en-US',
              Authorization: `Bearer ${token}`,
            },
            credentials: 'include',
            body: JSON.stringify({
              chat: {
                id: '',
                title: 'New Chat',
                models: [glmModel],
                params: {},
                history: {
                  messages: {
                    [msgId]: {
                      id: msgId,
                      parentId: null,
                      childrenIds: [],
                      role: 'user',
                      content: glmPrompt,
                      timestamp: msgTimestamp,
                      models: [glmModel],
                    },
                  },
                  currentId: msgId,
                },
                tags: [],
                flags: [],
                features: [{ type: 'tool_selector', server: 'tool_selector_h', status: 'hidden' }],
                mcp_servers: [],
                enable_thinking: true,
                auto_web_search: false,
                message_version: 1,
                extra: {},
                timestamp: Date.now(),
              },
            }),
          });
          if (!createRes.ok) {
            window.postMessage(
              {
                type: 'WEB_LLM_ERROR',
                requestId,
                error: `Chat creation failed: HTTP ${createRes.status}`,
              },
              origin,
            );
            return;
          }
          const chatData = await createRes.json();
          chatId = chatData.id ?? '';
        } catch (err) {
          window.postMessage(
            { type: 'WEB_LLM_ERROR', requestId, error: `Chat creation error: ${String(err)}` },
            origin,
          );
          return;
        }
      }

      // Build telemetry query params from browser globals
      const timestamp = Date.now();
      const queryParams: Record<string, string> = {
        timestamp: String(timestamp),
        requestId: crypto.randomUUID(),
        user_id: userId,
        version: '0.0.1',
        platform: 'web',
        token,
        user_agent: navigator.userAgent,
        language: navigator.language,
        languages: navigator.languages.join(','),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        cookie_enabled: String(navigator.cookieEnabled),
        screen_width: String(screen.width),
        screen_height: String(screen.height),
        screen_resolution: `${screen.width}x${screen.height}`,
        viewport_height: String(window.innerHeight),
        viewport_width: String(window.innerWidth),
        viewport_size: `${window.innerWidth}x${window.innerHeight}`,
        color_depth: String(screen.colorDepth),
        pixel_ratio: String(window.devicePixelRatio),
        current_url: window.location.href,
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
        host: window.location.host,
        hostname: window.location.hostname,
        protocol: window.location.protocol,
        referrer: document.referrer,
        title: document.title,
        timezone_offset: String(new Date().getTimezoneOffset()),
        local_time: new Date().toISOString(),
        utc_time: new Date().toUTCString(),
        is_mobile: 'false',
        is_touch: String('ontouchstart' in window),
        max_touch_points: String(navigator.maxTouchPoints),
        browser_name: 'Chrome',
        os_name: navigator.platform.includes('Win')
          ? 'Windows'
          : navigator.platform.includes('Mac')
            ? 'macOS'
            : 'Linux',
        signature_timestamp: String(timestamp),
      };

      const queryString = new URLSearchParams(queryParams).toString();
      const glmUrl = `https://chat.z.ai/api/v2/chat/completions?${queryString}`;

      // Build the datetime variables
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toTimeString().slice(0, 8);
      const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });

      // Build request body
      const glmBody = JSON.stringify({
        stream: true,
        model: glmModel,
        messages: [{ role: 'user', content: glmPrompt }],
        signature_prompt: glmPrompt,
        params: {},
        extra: {},
        features: {
          image_generation: false,
          web_search: false,
          auto_web_search: false,
          preview_mode: true,
          flags: [],
          enable_thinking: true,
        },
        variables: {
          '{{USER_NAME}}': 'user',
          '{{USER_LOCATION}}': 'Unknown',
          '{{CURRENT_DATETIME}}': `${dateStr} ${timeStr}`,
          '{{CURRENT_DATE}}': dateStr,
          '{{CURRENT_TIME}}': timeStr,
          '{{CURRENT_WEEKDAY}}': weekday,
          '{{CURRENT_TIMEZONE}}': tz,
          '{{USER_LANGUAGE}}': navigator.language,
        },
        chat_id: chatId,
        id: crypto.randomUUID(),
        current_user_message_id: msgId,
        current_user_message_parent_id: null,
        background_tasks: {
          title_generation: true,
          tags_generation: true,
        },
      });

      // Compute X-Signature (HMAC-SHA256 with derived key)
      // Algorithm:
      //   sortedPayload = "requestId,<uuid>,timestamp,<ts>,user_id,<uid>"
      //   message = sortedPayload + "|" + btoa(prompt) + "|" + timestamp
      //   timeBucket = Math.floor(timestamp / 300000)
      //   derivedKey = HMAC-SHA256(SECRET, String(timeBucket)).hex()
      //   signature = HMAC-SHA256(derivedKey, message).hex()
      const GLM_HMAC_SECRET = 'key-@@@@)))()((9))-xxxx&&&%%%%%';
      const glmHmacHex = async (key: string, message: string): Promise<string> => {
        const enc = new TextEncoder();
        const cryptoKey = await crypto.subtle.importKey(
          'raw',
          enc.encode(key),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
        return Array.from(new Uint8Array(sig))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
      };

      const sortedPayload = `requestId,${queryParams.requestId},timestamp,${queryParams.timestamp},user_id,${userId}`;
      // Base64-encode prompt (handle large prompts in 32KB chunks like the original)
      const promptBytes = new TextEncoder().encode(glmPrompt);
      let b64Chunks = '';
      for (let i = 0; i < promptBytes.length; i += 32768) {
        const chunk = promptBytes.slice(i, i + 32768);
        b64Chunks += String.fromCharCode.apply(null, Array.from(chunk) as number[]);
      }
      const base64Prompt = btoa(b64Chunks);
      const sigMessage = `${sortedPayload}|${base64Prompt}|${queryParams.timestamp}`;
      const timeBucket = Math.floor(timestamp / 300000);
      const derivedKey = await glmHmacHex(GLM_HMAC_SECRET, String(timeBucket));
      const xSignature = await glmHmacHex(derivedKey, sigMessage);

      // Build request headers
      const glmHeaders: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US',
        'X-FE-Version': 'prod-fe-1.0.272',
        'X-Signature': xSignature,
      };

      const glmResponse = await fetch(glmUrl, {
        method: 'POST',
        headers: glmHeaders,
        credentials: 'include',
        body: glmBody,
      });

      if (!glmResponse.ok) {
        let errorBody = '';
        try {
          errorBody = await glmResponse.text();
          if (errorBody.length > 500) errorBody = errorBody.slice(0, 500);
        } catch {
          /* ignore */
        }
        window.postMessage(
          {
            type: 'WEB_LLM_ERROR',
            requestId,
            error: `HTTP ${glmResponse.status}: ${glmResponse.statusText}${errorBody ? ` — ${errorBody}` : ''}`,
          },
          origin,
        );
        return;
      }

      // Stream SSE response back — standard "data: " line format
      const glmReader = glmResponse.body?.getReader();
      if (!glmReader) {
        window.postMessage(
          { type: 'WEB_LLM_ERROR', requestId, error: 'No response body from GLM Intl' },
          origin,
        );
        return;
      }

      // Inject synthetic SSE event carrying the chat_id so the bridge can
      // extract it via extractConversationId and reuse it on the next turn.
      if (chatId) {
        const idChunk = `data: ${JSON.stringify({ type: 'glm:chat_id', chat_id: chatId })}\n\n`;
        window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: idChunk }, origin);
      }

      const glmDecoder = new TextDecoder();
      let glmBuffer = '';

      while (true) {
        const { done, value } = await glmReader.read();
        if (done) break;

        glmBuffer += glmDecoder.decode(value, { stream: true });

        // Process complete lines
        while (glmBuffer.includes('\n')) {
          const lineEnd = glmBuffer.indexOf('\n');
          const line = glmBuffer.slice(0, lineEnd).trim();
          glmBuffer = glmBuffer.slice(lineEnd + 1);

          if (line.startsWith('data: ')) {
            const sseChunk = `${line}\n\n`;
            window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: sseChunk }, origin);
          }
        }
      }

      // Flush remaining data from decoder
      const glmFinal = glmDecoder.decode();
      if (glmFinal) glmBuffer += glmFinal;
      // Process any remaining complete lines
      while (glmBuffer.includes('\n')) {
        const lineEnd = glmBuffer.indexOf('\n');
        const line = glmBuffer.slice(0, lineEnd).trim();
        glmBuffer = glmBuffer.slice(lineEnd + 1);
        if (line.startsWith('data: ')) {
          window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: `${line}\n\n` }, origin);
        }
      }
      // Handle final line with no trailing newline
      const remaining = glmBuffer.trim();
      if (remaining.startsWith('data: ')) {
        window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: `${remaining}\n\n` }, origin);
      }

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
      } catch {
        /* ignore */
      }
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
            const errMsg = (errObj.message ??
              errObj.error ??
              errObj.code ??
              rawText.slice(0, 200)) as string;
            window.postMessage(
              { type: 'WEB_LLM_ERROR', requestId, error: `Connect error: ${errMsg}` },
              origin,
            );
          } catch {
            window.postMessage(
              {
                type: 'WEB_LLM_ERROR',
                requestId,
                error: `Connect error: ${rawText.slice(0, 500)}`,
              },
              origin,
            );
          }
          return;
        }
        isFirstChunk = false;

        // Extract complete frames: [flags:1][length:4][payload:length]
        while (buffer.byteLength >= 5) {
          const flags = buffer[0];
          const payloadLen = new DataView(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength,
          ).getUint32(1, false);
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
                const errMsg = (trailer.message ??
                  trailer.code ??
                  'Unknown Connect error') as string;
                window.postMessage(
                  {
                    type: 'WEB_LLM_ERROR',
                    requestId,
                    error: `Connect error: ${errMsg} (code: ${trailer.code ?? 'none'})`,
                  },
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
