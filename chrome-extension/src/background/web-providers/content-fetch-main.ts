/**
 * Content script injected into MAIN world of a provider's tab.
 * Performs fetch() with the user's session cookies and streams SSE chunks
 * back to the extension via window.postMessage().
 *
 * Injected by web-llm-bridge via chrome.scripting.executeScript.
 *
 * IMPORTANT: This function is serialized via chrome.scripting.executeScript({func}).
 * Chrome serializes ONLY the function body — module-scope imports and closures are
 * NOT captured. All provider handlers MUST be defined as inner functions within
 * mainWorldFetch. Do NOT move them to separate files with static imports.
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
  binaryProtocol?: 'connect-json' | 'gemini-chunks' | 'glm-intl' | 'deepseek';
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
    // ═══════════════════════════════════════════════════════════════════════════
    // SHARED SETUP — Optional pre-flight request and template variable substitution
    // ═══════════════════════════════════════════════════════════════════════════

    let setupData: Record<string, unknown> | undefined;
    if (setupRequest) {
      const setupResp = await fetch(setupRequest.url, {
        ...setupRequest.init,
        credentials: 'include',
      });
      if (!setupResp.ok) {
        let errorBody = '';
        try {
          errorBody = await setupResp.text();
          if (errorBody.length > 500) errorBody = errorBody.slice(0, 500);
        } catch {
          /* ignore */
        }
        const errorDetail = errorBody ? ` — ${errorBody}` : '';
        const authHint =
          setupResp.status === 401 || setupResp.status === 403
            ? ` Please visit ${origin} to verify your account is active and can use this model, then log out and log back in via Settings → Models.`
            : '';
        window.postMessage(
          {
            type: 'WEB_LLM_ERROR',
            requestId,
            error: `Setup request failed: HTTP ${setupResp.status}: ${setupResp.statusText}${errorDetail}${authHint}`,
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

    // ═══════════════════════════════════════════════════════════════════════════
    // PROVIDER HANDLERS — each provider's full logic as a self-contained function.
    // These MUST live inside mainWorldFetch because chrome.scripting.executeScript
    // serializes only the function body (no module-scope access).
    // ═══════════════════════════════════════════════════════════════════════════

    // ── Gemini (gemini.google.com) ────────────────────────────────────────────
    // Extracts page state (f.sid, at, bl) from WIZ_global_data, builds the real
    // URL-encoded form body, and streams length-prefixed JSON chunks.
    async function handleGemini(): Promise<void> {
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
        /* [17] thinking: [[0]]=ON, [[1]]=OFF (fast) */ [[1]],
        /* [18] unknown (0) */               0,
        /* [19-26] */                        null, null, null, null, null, null, null, null,
        /* [27] unknown (1) */               1,
        /* [28-29] */                        null, null,
        /* [30] unknown */                   [4],
        /* [31-40] */                        null, null, null, null, null, null, null, null, null, null,
        /* [41] unknown */                   [1],
        /* [42-52] */                        null, null, null, null, null, null, null, null, null, null, null,
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
    }

    // ── GLM International (chat.z.ai) ─────────────────────────────────────────
    // Requires localStorage JWT, browser fingerprint telemetry, and X-Signature
    // (HMAC-SHA256 with derived key). Creates chat sessions dynamically.
    async function handleGlmIntl(): Promise<void> {
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
    }

    // ── DeepSeek (chat.deepseek.com) ──────────────────────────────────────────
    // Requires PoW challenge solving, bearer token extraction from localStorage,
    // session creation, and special per-request headers.
    async function handleDeepSeek(): Promise<void> {
      // ── Helper: Extract bearer token from localStorage ──
      const extractBearerToken = async (): Promise<string> => {
        let bearer = '';

        // 1. Try the known key: userToken (DeepSeek's actual key)
        try {
          const raw = localStorage.getItem('userToken');
          if (raw) {
            // Could be: raw JWT string, JSON string like "\"jwt...\"", or JSON object like {"token":"..."}
            try {
              const parsed = JSON.parse(raw);
              if (typeof parsed === 'string') {
                bearer = parsed;
              } else if (typeof parsed === 'object' && parsed !== null) {
                bearer = parsed.token ?? parsed.value ?? parsed.access_token ?? parsed.jwt ?? '';
              }
            } catch {
              bearer = raw; // raw string, not JSON
            }
          }
        } catch {
          /* localStorage may not be accessible */
        }

        // 2. Scan other localStorage keys if userToken didn't work
        if (!bearer) {
          try {
            const candidates = ['token', 'ds_token', 'auth_token', 'access_token', 'jwt'];
            for (const key of candidates) {
              const val = localStorage.getItem(key);
              if (val && val.length > 10) {
                try {
                  const parsed = JSON.parse(val);
                  if (typeof parsed === 'string' && parsed.length > 10) {
                    bearer = parsed;
                  } else if (typeof parsed === 'object' && parsed !== null) {
                    bearer = parsed.token ?? parsed.value ?? '';
                  }
                } catch {
                  bearer = val;
                }
                if (bearer) break;
              }
            }
          } catch {
            /* ignore */
          }
        }

        // 3. Broader scan: any key with "token"/"auth" in the name
        if (!bearer) {
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (!key || key === 'userToken') continue; // already tried
              const lk = key.toLowerCase();
              if (lk.includes('token') || lk.includes('auth') || lk.includes('jwt') || lk.includes('bearer')) {
                const val = localStorage.getItem(key);
                if (val && val.length > 10) {
                  try {
                    const parsed = JSON.parse(val);
                    if (typeof parsed === 'string' && parsed.length > 10) {
                      bearer = parsed;
                    } else if (typeof parsed === 'object' && parsed !== null) {
                      bearer = parsed.token ?? parsed.value ?? '';
                    }
                  } catch {
                    bearer = val;
                  }
                  if (bearer) break;
                }
              }
            }
          } catch {
            /* ignore */
          }
        }

        // 4. Fallback: try to get token from /api/v0/users/current (like reference impl)
        if (!bearer) {
          try {
            const userRes = await fetch('https://chat.deepseek.com/api/v0/users/current', {
              credentials: 'include',
            });
            if (userRes.ok) {
              const userData = (await userRes.json()) as Record<string, unknown>;
              const userDataInner = userData.data as Record<string, unknown> | undefined;
              const userBiz = (userDataInner?.biz_data ?? userDataInner) as
                | Record<string, string>
                | undefined;
              if (userBiz?.token) bearer = userBiz.token;
            }
          } catch {
            /* ignore */
          }
        }

        return bearer;
      };

      // ── Helper: Extract PoW challenge from API response ──
      type PowChallenge = {
        algorithm: string;
        challenge: string;
        difficulty: number;
        salt: string;
        signature: string;
        expire_at?: number;
      };

      const extractPowChallenge = (powData: Record<string, unknown>): PowChallenge | null => {
        const dataObj = powData.data as Record<string, unknown> | undefined;
        const biz = dataObj && typeof dataObj === 'object'
          ? (dataObj.biz_data as Record<string, unknown> | undefined)
          : undefined;

        // Try nested challenge object first
        let raw: unknown = biz?.challenge ?? dataObj?.challenge ?? powData.challenge;
        // If biz_data itself has challenge fields (algorithm + salt)
        if ((!raw || typeof raw !== 'object') && biz?.algorithm && biz?.salt) {
          raw = biz;
        }
        // If data itself has challenge fields (flat structure)
        if ((!raw || typeof raw !== 'object') && dataObj && typeof dataObj === 'object' && dataObj.algorithm && dataObj.salt) {
          raw = dataObj;
        }

        if (!raw || typeof raw !== 'object') return null;
        return raw as PowChallenge;
      };

      // ── Helper: Solve SHA256 PoW challenge ──
      const solveSha256Pow = async (
        salt: string,
        challenge: string,
        difficulty: number,
      ): Promise<number> => {
        const targetDifficulty = difficulty > 1000 ? Math.floor(Math.log2(difficulty)) : difficulty;
        const encoder = new TextEncoder();

        for (let nonce = 0; nonce < 1_000_000; nonce++) {
          const input = encoder.encode(salt + challenge + nonce);
          const hashBuf = await crypto.subtle.digest('SHA-256', input);
          const hashArr = new Uint8Array(hashBuf);
          // Count leading zero bits (same algorithm as reference: count zero hex digits)
          const hexChars = Array.from(hashArr, b => b.toString(16).padStart(2, '0')).join('');
          let zeroBits = 0;
          for (const char of hexChars) {
            const val = parseInt(char, 16);
            if (val === 0) {
              zeroBits += 4;
            } else {
              zeroBits += Math.clz32(val) - 28;
              break;
            }
          }
          if (zeroBits >= targetDifficulty) return nonce;
        }

        return -1; // unsolvable
      };

      // ── Helper: Solve DeepSeekHashV1 PoW challenge via embedded WASM ──
      // Uses a SHA3-based hash compiled to WASM (from reference implementation).
      // The WASM module exports wasm_solve(retptr, ptrC, lenC, ptrP, lenP, difficulty)
      // which writes {status: i32, answer: f64} at retptr.
      /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
      const solveDeepSeekHashV1 = async (
        powCh: PowChallenge,
      ): Promise<number> => {
        // Embedded SHA3 WASM module as base64 (from openclaw-zero-token reference impl)
        const WASM_B64 = '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ADYCAEGEocAAQfigwAA2AgBBgKHAAEH4oMAANgIAQYyhwABBgKHAADYCAEGIocAAQYChwAA2AgBBlKHAAEGIocAANgIAQZChwABBiKHAADYCAEGcocAAQZChwAA2AgBBpKHAAEGYocAANgIAQZihwABBkKHAADYCAEGsocAAQaChwAA2AgBBoKHAAEGYocAANgIAQbShwABBqKHAADYCAEGoocAAQaChwAA2AgBBvKHAAEGwocAANgIAQbChwABBqKHAADYCAEHEocAAQbihwAA2AgBBuKHAAEGwocAANgIAQcyhwABBwKHAADYCAEHAocAAQbihwAA2AgBB1KHAAEHIocAANgIAQcihwABBwKHAADYCAEHcocAAQdChwAA2AgBB0KHAAEHIocAANgIAQeShwABB2KHAADYCAEHYocAAQdChwAA2AgBB7KHAAEHgocAANgIAQeChwABB2KHAADYCAEH0ocAAQeihwAA2AgBB6KHAAEHgocAANgIAQfyhwABB8KHAADYCAEHwocAAQeihwAA2AgBBhKLAAEH4ocAANgIAQfihwABB8KHAADYCAEGMosAAQYCiwAA2AgBBgKLAAEH4ocAANgIAQZSiwABBiKLAADYCAEGIosAAQYCiwAA2AgBBrKLAACABNgIAQZCiwABBiKLAADYCAEGkosAAIANBKGsiADYCACABIABBAXI2AgQgACABakEoNgIEQbiiwABBgICAATYCAAwHCyACIARJIAEgAk1yDQAgACgCDEUNAwtBvKLAAEG8osAAKAIAIgAgASAAIAFJGzYCACABIANqIQRBgKDAACEAAkACQANAIAQgACgCACIGRwRAIAAoAggiAA0BDAILCyAAKAIMRQ0BC0GAoMAAIQADQAJAIAIgACgCACIETwRAIAIgBCAAKAIEaiIGSQ0BCyAAKAIIIQAMAQsLQayiwAAgATYCAEGkosAAIANBKGsiADYCACABIABBAXI2AgQgACABakEoNgIEQbiiwABBgICAATYCACACIAZBIGtBeHFBCGsiACAAIAJBEGpJGyIEQRs2AgRBgKDAACkCACEJIARBEGpBiKDAACkCADcCACAEIAk3AghBhKDAACADNgIAQYCgwAAgATYCAEGIoMAAIARBCGo2AgBBjKDAAEEANgIAIARBHGohAANAIABBBzYCACAAQQRqIgAg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QZyiwABBnKLAACgCACADcjYCAA8LAkACQCABIAQoAgAiAygCBEF4cUYEQCADIQIMAQsgAUEZIAJBAXZrQQAgAkEfRxt0IQUDQCADIAVBHXZBBHFqQRBqIgQoAgAiAkUNAiAFQQF0IQUgAiEDIAIoAgRBeHEgAUcNAAsLIAIoAggiASAANgIMIAIgADYCCCAAQQA2AhggACACNgIMIAAgATYCCA8LIAQgADYCACAAIAM2AhggACAANgIMIAAgADYCCAuBAgEFfyMAQYABayIEJAACfwJAAkAgASgCHCICQRBxRQRAIAJBIHENASAAIAEQDwwDC0H/ACECA0AgBCACIgNqIgUgAEEPcSICQTByIAJB1wBqIAJBCkkbOgAAIANBAWshAiAAQRBJIABBBHYhAEUNAAsMAQtB/wAhAgNAIAQgAiIDaiIFIABBD3EiAkEwciACQTdqIAJBCkkbOgAAIANBAWshAiAAQRBJIABBBHYhAEUNAAsgA0GBAU8EQCADEBgACyABQYCEwABBAiAFQYABIANrEAkMAQsgA0GBAU8EQCADEBgACyABQYCEwABBAiAFQYABIANrEAkLIARBgAFqJAALuQIAIAIEQCABIAJBiAFsaiECA0AgACAAKQMAIAEpAACFNwMAIAAgACkDCCABKQAIhTcDCCAAIAApAxAgASkAEIU3AxAgACAAKQMYIAEpABiFNwMYIAAgACkDICABKQAghTcDICAAIAApAyggASkAKIU3AyggACAAKQMwIAEpADCFNwMwIAAgACkDOCABKQA4hTcDOCAAIAApA0AgASkAQIU3A0AgACAAKQNIIAEpAEiFNwNIIAAgACkDUCABKQBQhTcDUCAAIAApA1ggASkAWIU3A1ggACAAKQNgIAEpAGCFNwNgIAAgACkDaCABKQBohTcDaCAAIAApA3AgASkAcIU3A3AgACAAKQN4IAEpAHiFNwN4IAAgACkDgAEgASkAgAGFNwOAASAAEAQgAUGIAWoiASACRw0ACwsLsAEBAn8jAEEgayIDJAAgASABIAJqIgJLBEBBAEEAECgAC0EIIAAoAgAiAUEBdCIEIAIgAiAESRsiAiACQQhNGyIEQQBIBEBBAEEAECgACyADIAEEfyADIAE2AhwgAyAAKAIENgIUQQEFQQALNgIYIANBCGogBCADQRRqEB0gAygCCEEBRgRAIAMoAgwgAygCEBAoAAsgAygCDCEBIAAgBDYCACAAIAE2AgQgA0EgaiQAC7ABAQR/IwBBIGsiASQAIAAoAgAiAkF/RgRAQQBBABAoAAtBCCACQQF0IgMgAkEBaiIEIAMgBEsbIgMgA0EITRsiA0EASARAQQBBABAoAAsgASACBH8gASACNgIcIAEgACgCBDYCFEEBBUEACzYCGCABQQhqIAMgAUEUahAdIAEoAghBAUYEQCABKAIMIAEoAhAQKAALIAEoAgwhAiAAIAM2AgAgACACNgIEIAFBIGokAAuOAQECfyABQRBPBEAgAEEAIABrQQNxIgNqIQIgAwRAA0AgAEEAOgAAIABBAWoiACACSQ0ACwsgAiABIANrIgFBfHEiA2ohACADQQBKBEADQCACQQA2AgAgAkEEaiICIABJDQALCyABQQNxIQELIAEEQCAAIAFqIQEDQCAAQQA6AAAgAEEBaiIAIAFJDQALCwtsAQN/AkACQCAAKAIAIgIEQCAAKAIEIgBBBGsoAgAiAUF4cSIDQQRBCCABQQNxIgEbIAJqSQ0BIAFBACADIAJBJ2pLGw0CIAAQBQsPC0H5ncAAQS5BqJ7AABAgAAtBuJ7AAEEuQeiewAAQIAALewEBfyMAQRBrIgMkAEH8nsAAQfyewAAoAgAiBEEBajYCAAJAIARBAEgNAAJAQciiwAAtAABFBEBBxKLAAEHEosAAKAIAQQFqNgIAQfiewAAoAgBBAE4NAQwCCyADQQhqIAAgARECAAALQciiwABBADoAACACRQ0AAAsAC2wCAX8BfiMAQTBrIgEkACABIAA2AgAgAUGAATYCBCABQQI2AgwgAUGAhsAANgIIIAFCAjcCFCABQoCAgIAwIgIgAUEEaq2ENwMoIAEgAiABrYQ3AyAgASABQSBqNgIQIAFBCGpB8IPAABAkAAtoAgF/AX4jAEEwayIDJAAgAyABNgIEIAMgADYCACADQQI2AgwgA0G4g8AANgIIIANCAjcCFCADQoCAgIAwIgQgA62ENwMoIAMgBCADQQRqrYQ3AyAgAyADQSBqNgIQIANBCGogAhAkAAtoAgF/AX4jAEEwayIDJAAgAyAANgIAIAMgATYCBCADQQI2AgwgA0HUhsAANgIIIANCAjcCFCADQoCAgIAwIgQgA0EEaq2ENwMoIAMgBCADrYQ3AyAgAyADQSBqNgIQIANBCGogAhAkAAtiAQF/AkACQCABBEAgAEEEaygCACICQXhxIgNBBEEIIAJBA3EiAhsgAWpJDQEgAkEAIAMgAUEnaksbDQIgABAFCw8LQfmdwABBLkGonsAAECAAC0G4nsAAQS5B6J7AABAgAAtbAQJ/AkAgAEEEaygCACICQXhxIgNBBEEIIAJBA3EiAhsgAWpPBEAgAkEAIAMgAUEnaksbDQEgABAFDwtB+Z3AAEEuQaiewAAQIAALQbiewABBLkHonsAAECAAC1gBAX8CfyACKAIEBEACQCACKAIIIgNFBEAMAQsgAigCACADQQEgARAHDAILC0HJosAALQAAGiABEAALIQIgACABNgIIIAAgAkEBIAIbNgIEIAAgAkU2AgALSAACQCABaUEBR0GAgICAeCABayAASXINACAABEBByaLAAC0AABoCfyABQQlPBEAgASAAEAoMAQsgABAACyIBRQ0BCyABDwsAC0EBAX8gAiAAKAIAIAAoAggiA2tLBEAgACADIAIQEyAAKAIIIQMLIAAoAgQgA2ogASACEA0aIAAgAiADajYCCEEAC0EBAX8jAEEgayIDJAAgA0EANgIQIANBATYCBCADQgQ3AgggAyABNgIcIAMgADYCGCADIANBGGo2AgAgAyACECQACzgAAkAgAkGAgMQARg0AIAAgAiABKAIQEQAARQ0AQQEPCyADRQRAQQAPCyAAIAMgBCABKAIMEQEACzwBAX9BASECAkAgACgCACABEBENACABKAIUQciCwABBAiABKAIYKAIMEQEADQAgACgCBCABEBEhAgsgAgstAAJAIANpQQFHQYCAgIB4IANrIAFJckUEQCAAIAEgAyACEAciAA0BCwALIAAL6gECAn8BfiMAQRBrIgIkACACQQE7AQwgAiABNgIIIAIgADYCBCMAQRBrIgEkACACQQRqIgApAgAhBCABIAA2AgwgASAENwIEIwBBEGsiACQAIAFBBGoiASgCACICKAIMIQMCQAJAAkACQCACKAIEDgIAAQILIAMNAUEBIQJBACEDDAILIAMNACACKAIAIgIoAgQhAyACKAIAIQIMAQsgAEGAgICAeDYCACAAIAE2AgwgAEEGIAEoAggiAC0ACCAALQAJEBcACyAAIAM2AgQgACACNgIAIABBByABKAIIIgAtAAggAC0A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AgAgBkEDdGoiACgCACAAKAIEIAIoAiQoAgwRAQBFDQELQQEMAQtBAAsgAkEwaiQACwsAIAAoAgAgARAPCwwAIAAgASkCADcDAAsJACAAQQA2AgALC/weAgBBgIDAAAtBRXJyb3IAAAAIAAAADAAAAAQAAAAJAAAACgAAAAsAAABzaGEzLXdhc20vc3JjL2xpYi5ycyAAEAAUAAAASQAAADMAQcyAwAALqR4BAAAADAAAAGEgRGlzcGxheSBpbXBsZW1lbnRhdGlvbiByZXR1cm5lZCBhbiBlcnJvciB1bmV4cGVjdGVkbHkvVXNlcnMvcnoucGFuLy5ydXN0dXAvdG9vbGNoYWlucy9zdGFibGUtYWFyY2g2NC1hcHBsZS1kYXJ3aW4vbGliL3J1c3RsaWIvc3JjL3J1c3QvbGlicmFyeS9hbGxvYy9zcmMvc3RyaW5nLnJziwAQAG0AAAB7CgAADgAAAGNhcGFjaXR5IG92ZXJmbG93AAAACAEQABEAAABhbGxvYy9zcmMvcmF3X3ZlYy5ycyQBEAAUAAAAGAAAAAUAAAAuLjAxMjM0NTY3ODlhYmNkZWZjYWxsZWQgYE9wdGlvbjo6dW53cmFwKClgIG9uIGEgYE5vbmVgIHZhbHVlaW5kZXggb3V0IG9mIGJvdW5kczogdGhlIGxlbiBpcyAgYnV0IHRoZSBpbmRleCBpcyAAhQEQACAAAAClARAAEgAAADogAAABAAAAAAAAAMgBEAACAAAAY29yZS9zcmMvZm10L251bS5ycwDcARAAEwAAAGYAAAAXAAAAMHgwMDAxMDIwMzA0MDUwNjA3MDgwOTEwMTExMjEzMTQxNTE2MTcxODE5MjAyMTIyMjMyNDI1MjYyNzI4MjkzMDMxMzIzMzM0MzUzNjM3MzgzOTQwNDE0MjQzNDQ0NTQ2NDc0ODQ5NTA1MTUyNTM1NDU1NTY1NzU4NTk2MDYxNjI2MzY0NjU2NjY3Njg2OTcwNzE3MjczNzQ3NTc2Nzc3ODc5ODA4MTgyODM4NDg1ODY4Nzg4ODk5MDkxOTI5Mzk0OTU5Njk3OTg5OXJhbmdlIHN0YXJ0IGluZGV4ICBvdXQgb2YgcmFuZ2UgZm9yIHNsaWNlIG9mIGxlbmd0aCAAAMoCEAASAAAA3AIQACIAAAByYW5nZSBlbmQgaW5kZXggEAMQABAA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';

        // Decode base64 to Uint8Array (browser-native, no Buffer needed)
        const binaryStr = atob(WASM_B64);
        const wasmBytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          wasmBytes[i] = binaryStr.charCodeAt(i);
        }

        const { instance } = await WebAssembly.instantiate(wasmBytes.buffer, { wbg: {} });
        const exports = instance.exports as Record<string, unknown>;
        const memory = exports.memory as WebAssembly.Memory;
        const alloc = exports.__wbindgen_export_0 as (a: number, b: number) => number;
        const addToStack = exports.__wbindgen_add_to_stack_pointer as (a: number) => number;
        const wasmSolve = exports.wasm_solve as (
          retptr: number, ptrC: number, lenC: number, ptrP: number, lenP: number, difficulty: number,
        ) => void;

        const prefix = `${powCh.salt}_${powCh.expire_at}_`;
        const challengeStr = powCh.challenge;

        const encodeString = (str: string): [number, number] => {
          const buf = new TextEncoder().encode(str);
          const ptr = alloc(buf.length, 1);
          new Uint8Array(memory.buffer).set(buf, ptr);
          return [ptr, buf.length];
        };

        const [ptrC, lenC] = encodeString(challengeStr);
        const [ptrP, lenP] = encodeString(prefix);
        const retptr = addToStack(-16);

        wasmSolve(retptr, ptrC, lenC, ptrP, lenP, powCh.difficulty);

        const view = new DataView(memory.buffer);
        const status = view.getInt32(retptr, true);
        const answer = view.getFloat64(retptr + 8, true);
        addToStack(16);

        if (status === 0) {
          return -1; // failed to find solution
        }
        return answer;
      };
      /* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */

      // ── Main DeepSeek flow ──

      // Parse the prompt and optional chatId from the lightweight stub body
      let dsPrompt = '';
      let existingChatId = '';
      try {
        const bodyObj = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
          string,
          string
        >;
        dsPrompt = bodyObj.prompt ?? '';
        existingChatId = bodyObj.chatId ?? '';
      } catch {
        /* use defaults */
      }

      // Extract bearer token
      const bearer = await extractBearerToken();

      if (!bearer) {
        let utPreview = '(none)';
        try {
          const ut = localStorage.getItem('userToken');
          if (ut) utPreview = `len=${ut.length}, start=${ut.slice(0, 50)}`;
        } catch { /* ignore */ }

        window.postMessage(
          {
            type: 'WEB_LLM_ERROR',
            requestId,
            error: `No auth token found for DeepSeek. userToken: ${utPreview}. URL: ${window.location.href}. Please visit https://chat.deepseek.com, log in, then reconnect via Settings → Models.`,
          },
          origin,
        );
        return;
      }

      // Common headers for all DeepSeek API calls
      const dsHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: '*/*',
        Referer: 'https://chat.deepseek.com/',
        Origin: 'https://chat.deepseek.com',
        'x-client-platform': 'web',
        'x-client-version': '1.7.0',
        'x-app-version': '20241129.1',
        Authorization: `Bearer ${bearer}`,
      };

      // ── Create chat session ──
      let chatSessionId = existingChatId;
      if (!chatSessionId) {
        try {
          const createRes = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
            method: 'POST',
            headers: dsHeaders,
            credentials: 'include',
            body: JSON.stringify({}),
          });
          if (!createRes.ok) {
            let errorBody = '';
            try {
              errorBody = await createRes.text();
              if (errorBody.length > 500) errorBody = errorBody.slice(0, 500);
            } catch {
              /* ignore */
            }
            const authHint =
              createRes.status === 401 || createRes.status === 403
                ? ' Please visit https://chat.deepseek.com to verify your account is active, then log out and log back in via Settings → Models.'
                : '';
            window.postMessage(
              {
                type: 'WEB_LLM_ERROR',
                requestId,
                error: `Chat session creation failed: HTTP ${createRes.status}${errorBody ? ` — ${errorBody}` : ''}${authHint}`,
              },
              origin,
            );
            return;
          }
          const sessionData = (await createRes.json()) as Record<string, unknown>;
          if (sessionData.code !== undefined && sessionData.code !== 0) {
            window.postMessage(
              {
                type: 'WEB_LLM_ERROR',
                requestId,
                error: `Chat session creation error: code=${sessionData.code}, msg=${sessionData.msg ?? 'unknown'}`,
              },
              origin,
            );
            return;
          }
          const sessionBizData = sessionData.data as Record<string, unknown> | undefined;
          const bizData = (sessionBizData?.biz_data ?? sessionBizData) as Record<string, string> | undefined;
          chatSessionId = bizData?.id ?? bizData?.chat_session_id ?? '';
        } catch (err) {
          window.postMessage(
            { type: 'WEB_LLM_ERROR', requestId, error: `Chat session creation error: ${String(err)}` },
            origin,
          );
          return;
        }
      }

      // ── Fetch and solve PoW challenge ──
      let powChallenge: PowChallenge;
      try {
        const powRes = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
          method: 'POST',
          headers: dsHeaders,
          credentials: 'include',
          body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
        });
        if (!powRes.ok) {
          const errorBody = await powRes.text().catch(() => '');
          window.postMessage(
            {
              type: 'WEB_LLM_ERROR',
              requestId,
              error: `PoW challenge request failed: HTTP ${powRes.status}${errorBody ? ` — ${errorBody.slice(0, 500)}` : ''}`,
            },
            origin,
          );
          return;
        }
        const powData = (await powRes.json()) as Record<string, unknown>;
        if (powData.code !== undefined && powData.code !== 0) {
          window.postMessage(
            {
              type: 'WEB_LLM_ERROR',
              requestId,
              error: `PoW challenge API error: code=${powData.code}, msg=${powData.msg ?? 'unknown'}. Make sure you are logged in at https://chat.deepseek.com`,
            },
            origin,
          );
          return;
        }
        const extracted = extractPowChallenge(powData);
        if (!extracted) {
          const dataObj = powData.data as Record<string, unknown> | undefined;
          const dataKeys = dataObj && typeof dataObj === 'object' ? Object.keys(dataObj) : String(dataObj);
          window.postMessage(
            {
              type: 'WEB_LLM_ERROR',
              requestId,
              error: `PoW challenge missing in response. top: ${JSON.stringify(Object.keys(powData))}, data: ${JSON.stringify(dataKeys)}`,
            },
            origin,
          );
          return;
        }
        powChallenge = extracted;
      } catch (err) {
        window.postMessage(
          { type: 'WEB_LLM_ERROR', requestId, error: `PoW challenge error: ${String(err)}` },
          origin,
        );
        return;
      }

      // Solve PoW
      let powAnswer: number;
      if (powChallenge.algorithm === 'sha256') {
        powAnswer = await solveSha256Pow(powChallenge.salt, powChallenge.challenge, powChallenge.difficulty);
      } else if (powChallenge.algorithm === 'DeepSeekHashV1') {
        powAnswer = await solveDeepSeekHashV1(powChallenge);
      } else {
        window.postMessage(
          {
            type: 'WEB_LLM_ERROR',
            requestId,
            error: `Unsupported PoW algorithm: ${powChallenge.algorithm}. Only SHA256 and DeepSeekHashV1 are supported.`,
          },
          origin,
        );
        return;
      }

      if (powAnswer < 0) {
        window.postMessage(
          { type: 'WEB_LLM_ERROR', requestId, error: `PoW solve failed (${powChallenge.algorithm}) — no solution found` },
          origin,
        );
        return;
      }

      // Encode PoW response as base64
      const powResponse = btoa(
        JSON.stringify({
          ...powChallenge,
          answer: powAnswer,
          target_path: '/api/v0/chat/completion',
        }),
      );

      // ── Send completion request ──
      const dsResponse = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: {
          ...dsHeaders,
          'x-ds-pow-response': powResponse,
        },
        credentials: 'include',
        body: JSON.stringify({
          chat_session_id: chatSessionId,
          parent_message_id: null,
          prompt: dsPrompt,
          ref_file_ids: [],
          thinking_enabled: true,
          search_enabled: false,
          preempt: false,
        }),
      });

      if (!dsResponse.ok) {
        let errorBody = '';
        try {
          errorBody = await dsResponse.text();
          if (errorBody.length > 500) errorBody = errorBody.slice(0, 500);
        } catch {
          /* ignore */
        }
        const authHint =
          dsResponse.status === 401 || dsResponse.status === 403
            ? ' Please visit https://chat.deepseek.com to verify your account is active, then log out and log back in via Settings → Models.'
            : '';
        window.postMessage(
          {
            type: 'WEB_LLM_ERROR',
            requestId,
            error: `HTTP ${dsResponse.status}: ${dsResponse.statusText}${errorBody ? ` — ${errorBody}` : ''}${authHint}`,
          },
          origin,
        );
        return;
      }

      const dsReader = dsResponse.body?.getReader();
      if (!dsReader) {
        window.postMessage(
          { type: 'WEB_LLM_ERROR', requestId, error: 'No response body from DeepSeek' },
          origin,
        );
        return;
      }

      // ── Stream SSE response ──

      // Inject synthetic SSE event carrying the chat_session_id so the bridge can
      // extract it via extractConversationId and reuse it on the next turn.
      if (chatSessionId) {
        const idChunk = `data: ${JSON.stringify({ type: 'deepseek:chat_session_id', chat_session_id: chatSessionId })}\n\n`;
        window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: idChunk }, origin);
      }

      const dsDecoder = new TextDecoder();
      let dsBuffer = '';

      while (true) {
        const { done, value } = await dsReader.read();
        if (done) break;

        dsBuffer += dsDecoder.decode(value, { stream: true });

        // Process complete lines
        while (dsBuffer.includes('\n')) {
          const lineEnd = dsBuffer.indexOf('\n');
          const line = dsBuffer.slice(0, lineEnd).trim();
          dsBuffer = dsBuffer.slice(lineEnd + 1);

          if (line.startsWith('data: ')) {
            const sseChunk = `${line}\n\n`;
            window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: sseChunk }, origin);
          }
        }
      }

      // Flush remaining data from decoder
      const dsFinal = dsDecoder.decode();
      if (dsFinal) dsBuffer += dsFinal;
      // Process any remaining complete lines
      while (dsBuffer.includes('\n')) {
        const lineEnd = dsBuffer.indexOf('\n');
        const line = dsBuffer.slice(0, lineEnd).trim();
        dsBuffer = dsBuffer.slice(lineEnd + 1);
        if (line.startsWith('data: ')) {
          window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: `${line}\n\n` }, origin);
        }
      }
      // Handle final line with no trailing newline
      const dsRemaining = dsBuffer.trim();
      if (dsRemaining.startsWith('data: ')) {
        window.postMessage(
          { type: 'WEB_LLM_CHUNK', requestId, chunk: `${dsRemaining}\n\n` },
          origin,
        );
      }

      window.postMessage({ type: 'WEB_LLM_DONE', requestId }, origin);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ROUTING — dispatch to provider-specific handler or fall through to shared
    // ═══════════════════════════════════════════════════════════════════════════

    if (binaryProtocol === 'gemini-chunks') {
      await handleGemini();
      return;
    }

    if (binaryProtocol === 'glm-intl') {
      await handleGlmIntl();
      return;
    }

    if (binaryProtocol === 'deepseek') {
      await handleDeepSeek();
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SHARED INFRASTRUCTURE — Connect Protocol + standard SSE (not provider-specific)
    // ═══════════════════════════════════════════════════════════════════════════

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
      const authHint =
        response.status === 401 || response.status === 403
          ? ` Please visit ${origin} to verify your account is active and can use this model, then log out and log back in via Settings → Models.`
          : '';
      window.postMessage(
        {
          type: 'WEB_LLM_ERROR',
          requestId,
          error: `HTTP ${response.status}: ${response.statusText}${errorDetail}${authHint}`,
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
