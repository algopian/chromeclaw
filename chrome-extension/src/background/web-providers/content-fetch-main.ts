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
  binaryProtocol?:
    | 'connect-json'
    | 'gemini-chunks'
    | 'glm-intl'
    | 'deepseek'
    | 'doubao'
    | 'chatgpt'
    | 'rakuten';
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
      let glmModel = 'GLM-5-Turbo';
      let glmThinkingLevel = 'thinking'; // default: thinking on
      try {
        const bodyObj = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
          string,
          string
        >;
        glmPrompt = bodyObj.prompt ?? '';
        existingChatId = bodyObj.chatId ?? '';
        if (bodyObj.model) glmModel = bodyObj.model;
        if (bodyObj.thinkingLevel) glmThinkingLevel = bodyObj.thinkingLevel;
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
          auto_web_search: glmThinkingLevel === 'thinking',
          preview_mode: true,
          flags: [],
          vlm_tools_enable: false,
          vlm_web_search_enable: false,
          vlm_website_mode: false,
          enable_thinking: glmThinkingLevel === 'thinking',
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
        'X-FE-Version': 'prod-fe-1.0.288',
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
              if (
                lk.includes('token') ||
                lk.includes('auth') ||
                lk.includes('jwt') ||
                lk.includes('bearer')
              ) {
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
        const biz =
          dataObj && typeof dataObj === 'object'
            ? (dataObj.biz_data as Record<string, unknown> | undefined)
            : undefined;

        // Try nested challenge object first
        let raw: unknown = biz?.challenge ?? dataObj?.challenge ?? powData.challenge;
        // If biz_data itself has challenge fields (algorithm + salt)
        if ((!raw || typeof raw !== 'object') && biz?.algorithm && biz?.salt) {
          raw = biz;
        }
        // If data itself has challenge fields (flat structure)
        if (
          (!raw || typeof raw !== 'object') &&
          dataObj &&
          typeof dataObj === 'object' &&
          dataObj.algorithm &&
          dataObj.salt
        ) {
          raw = dataObj;
        }

        if (!raw || typeof raw !== 'object') return null;
        const candidate = raw as Record<string, unknown>;
        // Validate required fields exist before casting
        if (
          typeof candidate.algorithm !== 'string' ||
          typeof candidate.challenge !== 'string' ||
          typeof candidate.difficulty !== 'number' ||
          typeof candidate.salt !== 'string' ||
          typeof candidate.signature !== 'string'
        ) {
          return null;
        }
        return candidate as unknown as PowChallenge;
      };

      // ── Helper: Solve SHA256 PoW challenge ──
      const solveSha256Pow = async (
        salt: string,
        challenge: string,
        difficulty: number,
      ): Promise<number> => {
        // DeepSeek's API sends difficulty as either:
        // - A small number (e.g. 18) meaning "18 leading zero bits" directly, OR
        // - A large target value (e.g. 262144 = 2^18) from which we derive bit count.
        // Heuristic: values >64 can't be bit counts (SHA-256 is only 256 bits), so
        // they must be target values. Use log2 to convert back to bit count.
        const targetDifficulty = difficulty > 64 ? Math.floor(Math.log2(difficulty)) : difficulty;
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
      const solveDeepSeekHashV1 = async (powCh: PowChallenge): Promise<number> => {
        // Embedded SHA3 WASM module as base64 (from openclaw-zero-token reference impl)
        const WASM_B64 =
          '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ADYCAEGEocAAQfigwAA2AgBBgKHAAEH4oMAANgIAQYyhwABBgKHAADYCAEGIocAAQYChwAA2AgBBlKHAAEGIocAANgIAQZChwABBiKHAADYCAEGcocAAQZChwAA2AgBBpKHAAEGYocAANgIAQZihwABBkKHAADYCAEGsocAAQaChwAA2AgBBoKHAAEGYocAANgIAQbShwABBqKHAADYCAEGoocAAQaChwAA2AgBBvKHAAEGwocAANgIAQbChwABBqKHAADYCAEHEocAAQbihwAA2AgBBuKHAAEGwocAANgIAQcyhwABBwKHAADYCAEHAocAAQbihwAA2AgBB1KHAAEHIocAANgIAQcihwABBwKHAADYCAEHcocAAQdChwAA2AgBB0KHAAEHIocAANgIAQeShwABB2KHAADYCAEHYocAAQdChwAA2AgBB7KHAAEHgocAANgIAQeChwABB2KHAADYCAEH0ocAAQeihwAA2AgBB6KHAAEHgocAANgIAQfyhwABB8KHAADYCAEHwocAAQeihwAA2AgBBhKLAAEH4ocAANgIAQfihwABB8KHAADYCAEGMosAAQYCiwAA2AgBBgKLAAEH4ocAANgIAQZSiwABBiKLAADYCAEGIosAAQYCiwAA2AgBBrKLAACABNgIAQZCiwABBiKLAADYCAEGkosAAIANBKGsiADYCACABIABBAXI2AgQgACABakEoNgIEQbiiwABBgICAATYCAAwHCyACIARJIAEgAk1yDQAgACgCDEUNAwtBvKLAAEG8osAAKAIAIgAgASAAIAFJGzYCACABIANqIQRBgKDAACEAAkACQANAIAQgACgCACIGRwRAIAAoAggiAA0BDAILCyAAKAIMRQ0BC0GAoMAAIQADQAJAIAIgACgCACIETwRAIAIgBCAAKAIEaiIGSQ0BCyAAKAIIIQAMAQsLQayiwAAgATYCAEGkosAAIANBKGsiADYCACABIABBAXI2AgQgACABakEoNgIEQbiiwABBgICAATYCACACIAZBIGtBeHFBCGsiACAAIAJBEGpJGyIEQRs2AgRBgKDAACkCACEJIARBEGpBiKDAACkCADcCACAEIAk3AghBhKDAACADNgIAQYCgwAAgATYCAEGIoMAAIARBCGo2AgBBjKDAAEEANgIAIARBHGohAANAIABBBzYCACAAQQRqIgAg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QZyiwABBnKLAACgCACADcjYCAA8LAkACQCABIAQoAgAiAygCBEF4cUYEQCADIQIMAQsgAUEZIAJBAXZrQQAgAkEfRxt0IQUDQCADIAVBHXZBBHFqQRBqIgQoAgAiAkUNAiAFQQF0IQUgAiEDIAIoAgRBeHEgAUcNAAsLIAIoAggiASAANgIMIAIgADYCCCAAQQA2AhggACACNgIMIAAgATYCCA8LIAQgADYCACAAIAM2AhggACAANgIMIAAgADYCCAuBAgEFfyMAQYABayIEJAACfwJAAkAgASgCHCICQRBxRQRAIAJBIHENASAAIAEQDwwDC0H/ACECA0AgBCACIgNqIgUgAEEPcSICQTByIAJB1wBqIAJBCkkbOgAAIANBAWshAiAAQRBJIABBBHYhAEUNAAsMAQtB/wAhAgNAIAQgAiIDaiIFIABBD3EiAkEwciACQTdqIAJBCkkbOgAAIANBAWshAiAAQRBJIABBBHYhAEUNAAsgA0GBAU8EQCADEBgACyABQYCEwABBAiAFQYABIANrEAkMAQsgA0GBAU8EQCADEBgACyABQYCEwABBAiAFQYABIANrEAkLIARBgAFqJAALuQIAIAIEQCABIAJBiAFsaiECA0AgACAAKQMAIAEpAACFNwMAIAAgACkDCCABKQAIhTcDCCAAIAApAxAgASkAEIU3AxAgACAAKQMYIAEpABiFNwMYIAAgACkDICABKQAghTcDICAAIAApAyggASkAKIU3AyggACAAKQMwIAEpADCFNwMwIAAgACkDOCABKQA4hTcDOCAAIAApA0AgASkAQIU3A0AgACAAKQNIIAEpAEiFNwNIIAAgACkDUCABKQBQhTcDUCAAIAApA1ggASkAWIU3A1ggACAAKQNgIAEpAGCFNwNgIAAgACkDaCABKQBohTcDaCAAIAApA3AgASkAcIU3A3AgACAAKQN4IAEpAHiFNwN4IAAgACkDgAEgASkAgAGFNwOAASAAEAQgAUGIAWoiASACRw0ACwsLsAEBAn8jAEEgayIDJAAgASABIAJqIgJLBEBBAEEAECgAC0EIIAAoAgAiAUEBdCIEIAIgAiAESRsiAiACQQhNGyIEQQBIBEBBAEEAECgACyADIAEEfyADIAE2AhwgAyAAKAIENgIUQQEFQQALNgIYIANBCGogBCADQRRqEB0gAygCCEEBRgRAIAMoAgwgAygCEBAoAAsgAygCDCEBIAAgBDYCACAAIAE2AgQgA0EgaiQAC7ABAQR/IwBBIGsiASQAIAAoAgAiAkF/RgRAQQBBABAoAAtBCCACQQF0IgMgAkEBaiIEIAMgBEsbIgMgA0EITRsiA0EASARAQQBBABAoAAsgASACBH8gASACNgIcIAEgACgCBDYCFEEBBUEACzYCGCABQQhqIAMgAUEUahAdIAEoAghBAUYEQCABKAIMIAEoAhAQKAALIAEoAgwhAiAAIAM2AgAgACACNgIEIAFBIGokAAuOAQECfyABQRBPBEAgAEEAIABrQQNxIgNqIQIgAwRAA0AgAEEAOgAAIABBAWoiACACSQ0ACwsgAiABIANrIgFBfHEiA2ohACADQQBKBEADQCACQQA2AgAgAkEEaiICIABJDQALCyABQQNxIQELIAEEQCAAIAFqIQEDQCAAQQA6AAAgAEEBaiIAIAFJDQALCwtsAQN/AkACQCAAKAIAIgIEQCAAKAIEIgBBBGsoAgAiAUF4cSIDQQRBCCABQQNxIgEbIAJqSQ0BIAFBACADIAJBJ2pLGw0CIAAQBQsPC0H5ncAAQS5BqJ7AABAgAAtBuJ7AAEEuQeiewAAQIAALewEBfyMAQRBrIgMkAEH8nsAAQfyewAAoAgAiBEEBajYCAAJAIARBAEgNAAJAQciiwAAtAABFBEBBxKLAAEHEosAAKAIAQQFqNgIAQfiewAAoAgBBAE4NAQwCCyADQQhqIAAgARECAAALQciiwABBADoAACACRQ0AAAsAC2wCAX8BfiMAQTBrIgEkACABIAA2AgAgAUGAATYCBCABQQI2AgwgAUGAhsAANgIIIAFCAjcCFCABQoCAgIAwIgIgAUEEaq2ENwMoIAEgAiABrYQ3AyAgASABQSBqNgIQIAFBCGpB8IPAABAkAAtoAgF/AX4jAEEwayIDJAAgAyABNgIEIAMgADYCACADQQI2AgwgA0G4g8AANgIIIANCAjcCFCADQoCAgIAwIgQgA62ENwMoIAMgBCADQQRqrYQ3AyAgAyADQSBqNgIQIANBCGogAhAkAAtoAgF/AX4jAEEwayIDJAAgAyAANgIAIAMgATYCBCADQQI2AgwgA0HUhsAANgIIIANCAjcCFCADQoCAgIAwIgQgA0EEaq2ENwMoIAMgBCADrYQ3AyAgAyADQSBqNgIQIANBCGogAhAkAAtiAQF/AkACQCABBEAgAEEEaygCACICQXhxIgNBBEEIIAJBA3EiAhsgAWpJDQEgAkEAIAMgAUEnaksbDQIgABAFCw8LQfmdwABBLkGonsAAECAAC0G4nsAAQS5B6J7AABAgAAtbAQJ/AkAgAEEEaygCACICQXhxIgNBBEEIIAJBA3EiAhsgAWpPBEAgAkEAIAMgAUEnaksbDQEgABAFDwtB+Z3AAEEuQaiewAAQIAALQbiewABBLkHonsAAECAAC1gBAX8CfyACKAIEBEACQCACKAIIIgNFBEAMAQsgAigCACADQQEgARAHDAILC0HJosAALQAAGiABEAALIQIgACABNgIIIAAgAkEBIAIbNgIEIAAgAkU2AgALSAACQCABaUEBR0GAgICAeCABayAASXINACAABEBByaLAAC0AABoCfyABQQlPBEAgASAAEAoMAQsgABAACyIBRQ0BCyABDwsAC0EBAX8gAiAAKAIAIAAoAggiA2tLBEAgACADIAIQEyAAKAIIIQMLIAAoAgQgA2ogASACEA0aIAAgAiADajYCCEEAC0EBAX8jAEEgayIDJAAgA0EANgIQIANBATYCBCADQgQ3AgggAyABNgIcIAMgADYCGCADIANBGGo2AgAgAyACECQACzgAAkAgAkGAgMQARg0AIAAgAiABKAIQEQAARQ0AQQEPCyADRQRAQQAPCyAAIAMgBCABKAIMEQEACzwBAX9BASECAkAgACgCACABEBENACABKAIUQciCwABBAiABKAIYKAIMEQEADQAgACgCBCABEBEhAgsgAgstAAJAIANpQQFHQYCAgIB4IANrIAFJckUEQCAAIAEgAyACEAciAA0BCwALIAAL6gECAn8BfiMAQRBrIgIkACACQQE7AQwgAiABNgIIIAIgADYCBCMAQRBrIgEkACACQQRqIgApAgAhBCABIAA2AgwgASAENwIEIwBBEGsiACQAIAFBBGoiASgCACICKAIMIQMCQAJAAkACQCACKAIEDgIAAQILIAMNAUEBIQJBACEDDAILIAMNACACKAIAIgIoAgQhAyACKAIAIQIMAQsgAEGAgICAeDYCACAAIAE2AgwgAEEGIAEoAggiAC0ACCAALQAJEBcACyAAIAM2AgQgACACNgIAIABBByABKAIIIgAtAAggAC0A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AgAgBkEDdGoiACgCACAAKAIEIAIoAiQoAgwRAQBFDQELQQEMAQtBAAsgAkEwaiQACwsAIAAoAgAgARAPCwwAIAAgASkCADcDAAsJACAAQQA2AgALC/weAgBBgIDAAAtBRXJyb3IAAAAIAAAADAAAAAQAAAAJAAAACgAAAAsAAABzaGEzLXdhc20vc3JjL2xpYi5ycyAAEAAUAAAASQAAADMAQcyAwAALqR4BAAAADAAAAGEgRGlzcGxheSBpbXBsZW1lbnRhdGlvbiByZXR1cm5lZCBhbiBlcnJvciB1bmV4cGVjdGVkbHkvVXNlcnMvcnoucGFuLy5ydXN0dXAvdG9vbGNoYWlucy9zdGFibGUtYWFyY2g2NC1hcHBsZS1kYXJ3aW4vbGliL3J1c3RsaWIvc3JjL3J1c3QvbGlicmFyeS9hbGxvYy9zcmMvc3RyaW5nLnJziwAQAG0AAAB7CgAADgAAAGNhcGFjaXR5IG92ZXJmbG93AAAACAEQABEAAABhbGxvYy9zcmMvcmF3X3ZlYy5ycyQBEAAUAAAAGAAAAAUAAAAuLjAxMjM0NTY3ODlhYmNkZWZjYWxsZWQgYE9wdGlvbjo6dW53cmFwKClgIG9uIGEgYE5vbmVgIHZhbHVlaW5kZXggb3V0IG9mIGJvdW5kczogdGhlIGxlbiBpcyAgYnV0IHRoZSBpbmRleCBpcyAAhQEQACAAAAClARAAEgAAADogAAABAAAAAAAAAMgBEAACAAAAY29yZS9zcmMvZm10L251bS5ycwDcARAAEwAAAGYAAAAXAAAAMHgwMDAxMDIwMzA0MDUwNjA3MDgwOTEwMTExMjEzMTQxNTE2MTcxODE5MjAyMTIyMjMyNDI1MjYyNzI4MjkzMDMxMzIzMzM0MzUzNjM3MzgzOTQwNDE0MjQzNDQ0NTQ2NDc0ODQ5NTA1MTUyNTM1NDU1NTY1NzU4NTk2MDYxNjI2MzY0NjU2NjY3Njg2OTcwNzE3MjczNzQ3NTc2Nzc3ODc5ODA4MTgyODM4NDg1ODY4Nzg4ODk5MDkxOTI5Mzk0OTU5Njk3OTg5OXJhbmdlIHN0YXJ0IGluZGV4ICBvdXQgb2YgcmFuZ2UgZm9yIHNsaWNlIG9mIGxlbmd0aCAAAMoCEAASAAAA3AIQACIAAAByYW5nZSBlbmQgaW5kZXggEAMQABAA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';

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
          retptr: number,
          ptrC: number,
          lenC: number,
          ptrP: number,
          lenP: number,
          difficulty: number,
        ) => void;

        const prefix = `${powCh.salt}_${powCh.expire_at ?? 0}_`;
        const challengeStr = powCh.challenge;

        const encodeString = (str: string, ptr: number): number => {
          const buf = new TextEncoder().encode(str);
          // Re-read memory.buffer AFTER alloc — a prior alloc may have grown memory,
          // detaching the old ArrayBuffer. Always use fresh reference.
          new Uint8Array(memory.buffer).set(buf, ptr);
          return buf.length;
        };

        // Allocate BOTH buffers first, THEN write data.
        // This avoids the detached ArrayBuffer bug: if alloc() triggers memory.grow(),
        // data written to a pointer from a previous alloc would be lost.
        const challengeBuf = new TextEncoder().encode(challengeStr);
        const prefixBuf = new TextEncoder().encode(prefix);
        const ptrC = alloc(challengeBuf.length, 1);
        const ptrP = alloc(prefixBuf.length, 1);
        const lenC = encodeString(challengeStr, ptrC);
        const lenP = encodeString(prefix, ptrP);
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
          if (ut) utPreview = `len=${ut.length}`;
        } catch {
          /* ignore */
        }

        window.postMessage(
          {
            type: 'WEB_LLM_ERROR',
            requestId,
            error: `No auth token found for DeepSeek. userToken: ${utPreview}. Please visit https://chat.deepseek.com, log in, then reconnect via Settings → Models.`,
          },
          origin,
        );
        return;
      }

      // Extract client version from the page if possible (avoid hardcoded stale values)
      let clientVersion = '1.7.0';
      let appVersion = '20241129.1';
      try {
        // DeepSeek injects version info into script tags or window globals
        const versionMeta = document.querySelector('meta[name="version"]');
        if (versionMeta?.getAttribute('content')) {
          appVersion = versionMeta.getAttribute('content')!;
        }
        // Check for __NEXT_DATA__ or similar build manifest
        const nextData = (window as unknown as Record<string, unknown>).__NEXT_DATA__ as
          | { buildId?: string }
          | undefined;
        if (nextData?.buildId) {
          appVersion = nextData.buildId;
        }
        // Check for window.__APP_VERSION__ or similar globals
        const appVer = (window as unknown as Record<string, unknown>).__APP_VERSION__ as
          | string
          | undefined;
        if (appVer) appVersion = appVer;
        const clientVer = (window as unknown as Record<string, unknown>).__CLIENT_VERSION__ as
          | string
          | undefined;
        if (clientVer) clientVersion = clientVer;
      } catch {
        /* use defaults */
      }

      // Common headers for all DeepSeek API calls
      const dsHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: '*/*',
        Referer: 'https://chat.deepseek.com/',
        Origin: 'https://chat.deepseek.com',
        'x-client-platform': 'web',
        'x-client-version': clientVersion,
        'x-app-version': appVersion,
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
          const bizData = (sessionBizData?.biz_data ?? sessionBizData) as
            | Record<string, string>
            | undefined;
          chatSessionId = bizData?.id ?? bizData?.chat_session_id ?? '';
        } catch (err) {
          window.postMessage(
            {
              type: 'WEB_LLM_ERROR',
              requestId,
              error: `Chat session creation error: ${String(err)}`,
            },
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
          const dataKeys =
            dataObj && typeof dataObj === 'object' ? Object.keys(dataObj) : String(dataObj);
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
        powAnswer = await solveSha256Pow(
          powChallenge.salt,
          powChallenge.challenge,
          powChallenge.difficulty,
        );
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
          {
            type: 'WEB_LLM_ERROR',
            requestId,
            error: `PoW solve failed (${powChallenge.algorithm}) — no solution found`,
          },
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

    // ── Doubao (www.doubao.com) ──────────────────────────────────────────────
    // Uses Samantha API with non-standard SSE format: each line is a JSON object
    // with `event_type` (number) and `event_data` (JSON string).
    // We reformat into standard SSE for the bridge's SSE parser.
    async function handleDoubao(): Promise<void> {
      // Parse the lightweight stub body from the provider definition
      let prompt = '';
      let conversationId: string | undefined;
      try {
        const stub = JSON.parse(init.body as string) as {
          prompt?: string;
          conversationId?: string;
        };
        prompt = stub.prompt ?? '';
        conversationId = stub.conversationId;
      } catch {
        /* use defaults */
      }

      const isFirstTurn = !conversationId;

      // ── Build query params ──
      const queryParams = new URLSearchParams({
        aid: '497858',
        device_platform: 'web',
        language: 'zh',
        pkg_type: 'release_version',
        real_aid: '497858',
        region: 'CN',
        samantha_web: '1',
        sys_region: 'CN',
        use_olympus_account: '1',
        version_code: '20800',
      }).toString();

      // ── Build Samantha API request body ──
      const apiBody = JSON.stringify({
        messages: [
          {
            content: JSON.stringify({ text: prompt }),
            content_type: 2001,
            attachments: [],
            references: [],
          },
        ],
        completion_option: {
          is_regen: false,
          with_suggest: true,
          need_create_conversation: isFirstTurn,
          launch_stage: 1,
          is_replace: false,
          is_delete: false,
          message_from: 0,
          event_id: '0',
        },
        conversation_id: conversationId ?? '0',
        // Doubao's web client uses `local_16` + 13-digit timestamp as local IDs.
        // Date.now() is 13 digits (until ~2286), so slice(-14) keeps all digits.
        local_conversation_id: `local_16${Date.now().toString().slice(-14)}`,
        local_message_id: crypto.randomUUID(),
      });

      // ── Fetch from Samantha API ──
      const doubaoUrl = `https://www.doubao.com/samantha/chat/completion?${queryParams}`;
      const doubaoResp = await fetch(doubaoUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Agw-js-conv': 'str',
          Referer: 'https://www.doubao.com/chat/',
        },
        body: apiBody,
        credentials: 'include',
      });

      if (!doubaoResp.ok) {
        let errorBody = '';
        try {
          errorBody = await doubaoResp.text();
          if (errorBody.length > 500) errorBody = errorBody.slice(0, 500);
        } catch {
          /* ignore */
        }
        const errorDetail = errorBody ? ` — ${errorBody}` : '';
        const authHint =
          doubaoResp.status === 401 || doubaoResp.status === 403
            ? ' Please visit https://www.doubao.com/chat/ to verify your account is active, then log out and log back in via Settings → Models.'
            : '';
        window.postMessage(
          {
            type: 'WEB_LLM_ERROR',
            requestId,
            error: `HTTP ${doubaoResp.status}: ${doubaoResp.statusText}${errorDetail}${authHint}`,
          },
          origin,
        );
        return;
      }

      const doubaoReader = doubaoResp.body?.getReader();
      if (!doubaoReader) {
        window.postMessage({ type: 'WEB_LLM_ERROR', requestId, error: 'No response body' }, origin);
        return;
      }

      // ── Stream and reformat Samantha lines into standard SSE ──
      // Samantha API returns lines in one of these formats:
      //   data: {"event_type":2001,"event_data":"{\"message\":{...}}"}   (standard SSE with Samantha wrapper)
      //   {"event_type":2001,"event_data":"{\"message\":{...}}"}         (raw JSON line)
      //   id: 123 event: CHUNK_DELTA data: {"text":"..."}               (single-line SSE, legacy)
      //
      // In all cases, the actual content is nested inside event_data as a JSON string.
      // We unwrap event_data and forward just the inner JSON as standard SSE: data: {...}\n\n
      // so the bridge's SSE parser + stream adapter receives the message object directly.
      const doubaoDecoder = new TextDecoder();
      let doubaoBuffer = '';
      let capturedConversationId: string | undefined;

      /** Parse a Samantha outer wrapper and post the inner event_data as SSE. */
      function processSamanthaJson(jsonStr: string): void {
        try {
          const raw = JSON.parse(jsonStr) as {
            event_type?: number;
            event_data?: string;
            code?: number;
            conversation_id?: string;
          };

          // Error response
          if (raw.code != null && raw.code !== 0) return;

          // Stream end — skip
          if (raw.event_type === 2003) return;

          // Unwrap event_data for content events (2001) and metadata (2002)
          if (raw.event_data) {
            try {
              const inner = JSON.parse(raw.event_data) as Record<string, unknown>;

              // Capture conversation_id from metadata events (event_type 2002)
              if (inner.conversation_id && inner.conversation_id !== '0') {
                capturedConversationId = inner.conversation_id as string;
              }

              // Only forward content events (event_type 2001) to the stream adapter
              if (raw.event_type === 2001) {
                window.postMessage(
                  { type: 'WEB_LLM_CHUNK', requestId, chunk: `data: ${raw.event_data}\n\n` },
                  origin,
                );
              }
            } catch {
              // event_data is not valid JSON — skip
            }
          }
        } catch {
          // Not valid JSON — ignore
        }
      }

      /** Process a single trimmed, non-empty line from the Samantha stream. */
      function processDoubaoLine(line: string): void {
        // Format 1: Standard SSE `data: {...}` lines — unwrap Samantha wrapper
        if (line.startsWith('data: ')) {
          const dataContent = line.slice(6).trim();
          // Check if it's a Samantha wrapper (has event_type/event_data)
          if (dataContent.startsWith('{') && dataContent.includes('"event_type"')) {
            processSamanthaJson(dataContent);
          } else {
            // Non-Samantha SSE data — pass through as-is
            window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: `${line}\n\n` }, origin);
          }
          return;
        }

        // Format 2: Single-line SSE `id: NNN event: XXX data: {...}`
        const singleMatch = line.match(/^id:\s*\d+\s+event:\s*(\S+)\s+data:\s*(.+)/);
        if (singleMatch) {
          const eventData = singleMatch[2].trim();
          window.postMessage(
            { type: 'WEB_LLM_CHUNK', requestId, chunk: `data: ${eventData}\n\n` },
            origin,
          );
          return;
        }

        // Format 3: Samantha raw JSON `{"event_type":2001,"event_data":"..."}`
        if (line.startsWith('{')) {
          processSamanthaJson(line);
        }
      }

      while (true) {
        const { done, value } = await doubaoReader.read();
        if (done) break;

        doubaoBuffer += doubaoDecoder.decode(value, { stream: true });

        let lineEnd: number;
        while ((lineEnd = doubaoBuffer.indexOf('\n')) !== -1) {
          const line = doubaoBuffer.slice(0, lineEnd).trim();
          doubaoBuffer = doubaoBuffer.slice(lineEnd + 1);
          if (!line) continue;

          processDoubaoLine(line);
        }
      }

      // Handle any remaining data in the buffer
      const doubaoRemaining = doubaoBuffer.trim();
      if (doubaoRemaining) {
        processDoubaoLine(doubaoRemaining);
      }

      // Inject synthetic conversation_id event so the bridge can cache it
      // for stateful conversation continuation.
      if (capturedConversationId) {
        const idChunk = `data: ${JSON.stringify({ type: 'doubao:conversation_id', conversation_id: capturedConversationId })}\n\n`;
        window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: idChunk }, origin);
      }

      window.postMessage({ type: 'WEB_LLM_DONE', requestId }, origin);
    }

    // ── ChatGPT (chatgpt.com) ──────────────────────────────────────────────
    // Requires Sentinel antibot challenge solving, access token from session,
    // and stateful conversation management (conversation_id + parent_message_id).
    async function handleChatGPT(): Promise<void> {
      // ── Keep-alive: prevent inactivity detection ──
      // ChatGPT's client tracks mouse/keyboard events, Page Visibility API, and
      // telemetry heartbeats. A background tab with zero activity gets flagged as
      // stale, causing token refresh failures and 403s. Simulate periodic activity
      // and override visibility state for the duration of this request.
      const keepAliveInterval = setInterval(() => {
        document.dispatchEvent(
          new MouseEvent('mousemove', {
            clientX: Math.random() * window.innerWidth,
            clientY: Math.random() * window.innerHeight,
          }),
        );
      }, 30_000);
      const origHiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      const origVisibilityDesc = Object.getOwnPropertyDescriptor(
        Document.prototype,
        'visibilityState',
      );
      try {
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        Object.defineProperty(document, 'visibilityState', {
          get: () => 'visible',
          configurable: true,
        });
      } catch {
        /* non-configurable in some contexts */
      }

      const cleanupKeepAlive = () => {
        clearInterval(keepAliveInterval);
        try {
          if (origHiddenDesc) Object.defineProperty(document, 'hidden', origHiddenDesc);
          if (origVisibilityDesc)
            Object.defineProperty(document, 'visibilityState', origVisibilityDesc);
        } catch {
          /* ignore */
        }
      };

      try {
        // Parse the prompt and optional composite chatId from the lightweight stub body
        let cgPrompt = '';
        let existingConversationId = '';
        let existingParentMsgId = '';
        try {
          const bodyObj = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
            string,
            string
          >;
          cgPrompt = bodyObj.prompt ?? '';
          // chatId may be a composite "conversationId|parentMessageId"
          const chatId = bodyObj.chatId ?? '';
          if (chatId.includes('|')) {
            const parts = chatId.split('|');
            existingConversationId = parts[0] ?? '';
            existingParentMsgId = parts[1] ?? '';
          } else {
            existingConversationId = chatId;
          }
        } catch {
          /* use defaults */
        }

        // ── Step 1: Fetch access token and device ID from /api/auth/session ──
        let accessToken = '';
        let deviceId = '';
        try {
          const sessionRes = await fetch('https://chatgpt.com/api/auth/session', {
            credentials: 'include',
          });
          if (sessionRes.ok) {
            const sessionData = (await sessionRes.json()) as Record<string, unknown>;
            accessToken = (sessionData.accessToken ?? '') as string;
            deviceId = ((sessionData as { oaiDeviceId?: string }).oaiDeviceId ?? '') as string;
          }
        } catch {
          /* ignore */
        }

        if (!deviceId) {
          deviceId = crypto.randomUUID();
        }

        if (!accessToken) {
          window.postMessage(
            {
              type: 'WEB_LLM_ERROR',
              requestId,
              error:
                'No access token found for ChatGPT. Please visit https://chatgpt.com, log in, then reconnect via Settings \u2192 Models.',
            },
            origin,
          );
          return;
        }

        // ── Step 2: Base headers ──
        const baseHeaders = (at: string | undefined, did: string): Record<string, string> => ({
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'oai-device-id': did,
          'oai-language': 'en-US',
          // These rotate with each OpenAI deploy. Not exposed as page globals — baked
          // into the bundled JS on cdn.oaistatic.com. Optional but reduce 403 risk.
          // Update if ChatGPT requests start returning 403 after sentinel passes.
          'OAI-Client-Version': 'prod-80cda9c7df3122f53ffea02ee38084601d19d627',
          'OAI-Client-Build-Number': '5623993',
          Referer: window.location.href || 'https://chatgpt.com/',
          Origin: 'https://chatgpt.com',
          'sec-ch-ua': (
            navigator as Navigator & {
              userAgentData?: { brands?: { brand: string; version: string }[] };
            }
          ).userAgentData?.brands
            ? (
                navigator as Navigator & {
                  userAgentData: { brands: { brand: string; version: string }[] };
                }
              ).userAgentData.brands
                .map(b => `"${b.brand}";v="${b.version}"`)
                .join(', ')
            : '"Chromium";v="131", "Not_A Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': (navigator as Navigator & { userAgentData?: { platform?: string } })
            .userAgentData?.platform
            ? `"${(navigator as Navigator & { userAgentData: { platform: string } }).userAgentData.platform}"`
            : '"Unknown"',
          ...(at ? { Authorization: `Bearer ${at}` } : {}),
        });

        const cgHeaders = baseHeaders(accessToken, deviceId);

        // ── Sentinel module discovery & auto-fingerprinting ──
        // The sentinel module's export names are minified and rotate on each OpenAI
        // deploy. Instead of hardcoding names, we discover functions by structural
        // signature (arity, shape) with a fast-path for currently known names.

        interface SentinelExports {
          chatRequirements: () => Promise<Record<string, unknown>>;
          turnstileSolver?: (key: unknown) => Promise<unknown>;
          arkoseEnforcer?: { getEnforcementToken: (reqs: unknown) => Promise<unknown> };
          powEnforcer?: unknown; // enforcer object OR PoW solver {answers, ...}
          headerBuilder: (...args: unknown[]) => Promise<Record<string, string>>;
        }

        const KNOWN_NAMES = {
          chatRequirements: 'bk',
          turnstileSolver: 'bi',
          arkoseEnforcer: 'bl',
          powEnforcer: 'bm',
          headerBuilder: 'fX',
        };

        /** Discover sentinel function roles from module exports by structural fingerprinting. */
        const discoverSentinelExports = (
          mod: Record<string, unknown>,
          diag: string[],
        ): SentinelExports | null => {
          // Fast path — check known minified names first
          if (
            typeof mod[KNOWN_NAMES.chatRequirements] === 'function' &&
            typeof mod[KNOWN_NAMES.headerBuilder] === 'function'
          ) {
            diag.push('discovery=known-names');
            return {
              chatRequirements: mod[
                KNOWN_NAMES.chatRequirements
              ] as SentinelExports['chatRequirements'],
              turnstileSolver:
                typeof mod[KNOWN_NAMES.turnstileSolver] === 'function'
                  ? (mod[KNOWN_NAMES.turnstileSolver] as SentinelExports['turnstileSolver'])
                  : undefined,
              arkoseEnforcer:
                mod[KNOWN_NAMES.arkoseEnforcer] &&
                typeof (mod[KNOWN_NAMES.arkoseEnforcer] as Record<string, unknown>)
                  .getEnforcementToken === 'function'
                  ? (mod[KNOWN_NAMES.arkoseEnforcer] as SentinelExports['arkoseEnforcer'])
                  : undefined,
              powEnforcer: mod[KNOWN_NAMES.powEnforcer] ?? undefined,
              headerBuilder: mod[KNOWN_NAMES.headerBuilder] as SentinelExports['headerBuilder'],
            };
          }

          // Fallback — scan all exports by function body content + structural shape.
          // Minified function bodies still contain string literals (API paths, header
          // names) that survive name rotations. We match on those first, then fall back
          // to arity as a tie-breaker.
          diag.push('discovery=fingerprint');
          const exportKeys = Object.keys(mod);
          diag.push(`exports=[${exportKeys.join(',')}]`);

          let chatRequirements: SentinelExports['chatRequirements'] | undefined;
          let headerBuilder: SentinelExports['headerBuilder'] | undefined;
          let turnstileSolver: SentinelExports['turnstileSolver'] | undefined;
          let arkoseEnforcer: SentinelExports['arkoseEnforcer'] | undefined;
          let powEnforcer: unknown;

          // Phase 1: Body fingerprinting — scan fn.toString() for stable string patterns
          for (const key of exportKeys) {
            const val = mod[key];
            if (typeof val === 'function') {
              const fn = val as (...args: unknown[]) => unknown;
              let body = '';
              try {
                body = fn.toString();
              } catch {
                /* toString may fail on native code */
              }

              if (body && !body.startsWith('[')) {
                // chatRequirements: references the sentinel API endpoint but NOT the header name
                if (
                  !chatRequirements &&
                  body.includes('chat-requirements') &&
                  !body.includes('requirements-token')
                ) {
                  chatRequirements = fn as SentinelExports['chatRequirements'];
                  diag.push(`chatRequirements=${key}(body-match)`);
                }
                // headerBuilder: references the sentinel header name
                else if (
                  !headerBuilder &&
                  (body.includes('requirements-token') || body.includes('openai-sentinel'))
                ) {
                  headerBuilder = fn as SentinelExports['headerBuilder'];
                  diag.push(`headerBuilder=${key}(body-match)`);
                }
                // turnstileSolver: references turnstile (case-insensitive), arity ≤ 2
                else if (!turnstileSolver && fn.length <= 2 && /turnstile/i.test(body)) {
                  turnstileSolver = fn as SentinelExports['turnstileSolver'];
                  diag.push(`turnstileSolver=${key}(body-match)`);
                }
              }
            } else if (val && typeof val === 'object') {
              const obj = val as Record<string, unknown>;
              if (typeof obj.getEnforcementToken === 'function') {
                if ((obj as Record<string, unknown>).answers === undefined && !arkoseEnforcer) {
                  arkoseEnforcer = obj as SentinelExports['arkoseEnforcer'];
                  diag.push(`arkoseEnforcer=${key}(hasGetEnforcementToken)`);
                } else if (!powEnforcer) {
                  powEnforcer = obj;
                  diag.push(`powEnforcer=${key}(enforcer)`);
                }
              } else if (obj.answers !== undefined && !powEnforcer) {
                powEnforcer = obj;
                diag.push(`powEnforcer=${key}(hasPowAnswers)`);
              }
            }
          }

          // Phase 1.5: Module-level source scan — if body fingerprinting missed chatRequirements
          // or headerBuilder, check whether the *combined* source of all exported functions
          // contains the target strings. This catches cases where minifiers hoist string
          // literals to module-scope variables (e.g. `const a = "chat-requirements";`),
          // making individual fn.toString() miss the match.
          if (!chatRequirements || !headerBuilder) {
            let combinedSource = '';
            for (const key of exportKeys) {
              const val = mod[key];
              if (typeof val === 'function') {
                try {
                  combinedSource += (val as (...a: unknown[]) => unknown).toString() + '\n';
                } catch {
                  /* ignore */
                }
              }
            }
            if (combinedSource) {
              const moduleHasChatReqs = combinedSource.includes('chat-requirements');
              const moduleHasHeader =
                combinedSource.includes('requirements-token') ||
                combinedSource.includes('openai-sentinel');
              if (moduleHasChatReqs || moduleHasHeader) {
                diag.push(
                  `module-source-scan=hit(chatReqs=${moduleHasChatReqs},header=${moduleHasHeader})`,
                );
              }
            }
          }

          // Phase 2: Arity fallback — if body fingerprinting missed chatRequirements or headerBuilder
          if (!headerBuilder) {
            for (const key of exportKeys) {
              const val = mod[key];
              if (typeof val === 'function' && (val as (...a: unknown[]) => unknown).length === 5) {
                headerBuilder = val as SentinelExports['headerBuilder'];
                diag.push(`headerBuilder=${key}(arity5)`);
                break;
              }
            }
          }
          if (!chatRequirements) {
            const arity0Fns: Array<{ name: string; fn: (...args: unknown[]) => unknown }> = [];
            for (const key of exportKeys) {
              const val = mod[key];
              if (
                typeof val === 'function' &&
                (val as (...a: unknown[]) => unknown).length === 0 &&
                val !== headerBuilder &&
                val !== turnstileSolver
              ) {
                arity0Fns.push({ name: key, fn: val as (...a: unknown[]) => unknown });
              }
            }
            if (arity0Fns.length === 1) {
              chatRequirements = arity0Fns[0]!.fn as SentinelExports['chatRequirements'];
              diag.push(`chatRequirements=${arity0Fns[0]!.name}(arity0-unique)`);
            } else if (arity0Fns.length > 1) {
              // Filter out well-known non-sentinel exports and prefer async functions
              // (chatRequirements is always async — it fetches from /sentinel/chat-requirements)
              const EXCLUDED_NAMES = new Set(['__esModule', 'default']);
              const filtered = arity0Fns.filter(f => !EXCLUDED_NAMES.has(f.name));
              // Prefer async functions (their toString contains 'async')
              const asyncCandidates = filtered.filter(f => {
                try {
                  return f.fn.toString().includes('async');
                } catch {
                  return false;
                }
              });
              const best = asyncCandidates.length > 0 ? asyncCandidates : filtered;
              if (best.length === 1) {
                chatRequirements = best[0]!.fn as SentinelExports['chatRequirements'];
                diag.push(`chatRequirements=${best[0]!.name}(arity0-filtered)`);
              } else if (best.length > 1) {
                // Still ambiguous — pick the first candidate but log the ambiguity
                chatRequirements = best[0]!.fn as SentinelExports['chatRequirements'];
                diag.push(
                  `chatRequirements=${best[0]!.name}(arity0-ambiguous,${best.length}-candidates)`,
                );
              }
            }
          }
          if (!turnstileSolver) {
            for (const key of exportKeys) {
              const val = mod[key];
              if (
                typeof val === 'function' &&
                (val as (...a: unknown[]) => unknown).length === 1 &&
                val !== chatRequirements &&
                val !== headerBuilder
              ) {
                turnstileSolver = val as SentinelExports['turnstileSolver'];
                diag.push(`turnstileSolver=${key}(arity1)`);
                break;
              }
            }
          }

          if (!chatRequirements || !headerBuilder) {
            diag.push(
              `missing: chatRequirements=${!!chatRequirements}, headerBuilder=${!!headerBuilder}`,
            );
            return null;
          }

          return { chatRequirements, turnstileSolver, arkoseEnforcer, powEnforcer, headerBuilder };
        };

        // ── Multi-strategy sentinel module URL discovery ──
        // Try multiple strategies to find the oaistatic.com sentinel script URL.

        const findSentinelAssetUrl = async (diag: string[]): Promise<string | null> => {
          // Collect all oaistatic.com JS URLs from multiple sources, then validate
          // each by importing and running discoverSentinelExports(). ChatGPT loads
          // many scripts from oaistatic.com — only the sentinel module will have
          // exports matching our fingerprints.

          const collectCandidateUrls = (): string[] => {
            const urls: string[] = [];
            const seen = new Set<string>();
            const add = (url: string) => {
              if (url && !seen.has(url)) {
                seen.add(url);
                urls.push(url);
              }
            };

            // DOM <script> tags
            for (const s of Array.from(document.scripts)) {
              if (s.src?.includes('oaistatic.com') && s.src.endsWith('.js')) add(s.src);
            }

            // <link rel="modulepreload">
            for (const l of Array.from(document.querySelectorAll('link[rel="modulepreload"]'))) {
              const href = (l as HTMLLinkElement).href;
              if (href?.includes('oaistatic.com') && href.endsWith('.js')) add(href);
            }

            // Performance API (catches dynamically import()-loaded scripts)
            try {
              const entries = performance.getEntriesByType(
                'resource',
              ) as PerformanceResourceTiming[];
              for (const e of entries
                .filter(e => e.name.includes('oaistatic.com') && e.name.endsWith('.js'))
                .sort((a, b) => b.startTime - a.startTime)) {
                add(e.name);
              }
            } catch {
              /* Performance API may be restricted */
            }

            return urls;
          };

          // Try-import a candidate URL and check for sentinel exports.
          // Pre-filter: sentinel modules typically have <50 exports. Large app bundles
          // (200+ exports) are skipped to avoid slow parse + potential side effects.
          const MAX_SENTINEL_EXPORTS = 50;

          const tryCandidate = async (url: string): Promise<boolean> => {
            try {
              const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
              if (Object.keys(mod).length > MAX_SENTINEL_EXPORTS) return false;
              const testDiag: string[] = [];
              const exports = discoverSentinelExports(mod, testDiag);
              return exports !== null;
            } catch {
              return false;
            }
          };

          // Quick scan — check candidates without waiting
          let candidates = collectCandidateUrls();
          if (candidates.length > 0) {
            diag.push(`asset=candidates(${candidates.length})`);
            for (const url of candidates) {
              if (await tryCandidate(url)) {
                diag.push(`asset=verified(${url.split('/').pop()})`);
                return url;
              }
            }
            diag.push('asset=candidates-no-sentinel');
          }

          // Poll DOM/performance for up to 5s (the SPA may still be hydrating)
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 500));
            const newCandidates = collectCandidateUrls();
            // Only check newly discovered URLs
            const fresh = newCandidates.filter(u => !candidates.includes(u));
            if (fresh.length > 0) {
              candidates = newCandidates;
              for (const url of fresh) {
                if (await tryCandidate(url)) {
                  diag.push(`asset=poll-verified(${url.split('/').pop()})`);
                  return url;
                }
              }
            }
          }

          // Strategy 4: Fetch HTML page and extract oaistatic URLs from the response.
          // Background tabs may never fully hydrate the Next.js SPA, so DOM-based
          // discovery fails. The HTML response may contain asset URLs directly or
          // reference a build manifest. ChatGPT may also serve the HTML with
          // relative paths or different CDN subdomains — match broadly.
          try {
            diag.push('asset=trying-html-fetch');
            const htmlRes = await fetch('https://chatgpt.com/', { credentials: 'include' });
            if (htmlRes.ok) {
              const html = await htmlRes.text();
              // Match any oaistatic.com JS URL (full or protocol-relative)
              const urlMatches = html.match(
                /(?:https?:)?\/\/[a-z0-9.-]*oaistatic\.com\/[^"'\s<>]+\.js/g,
              );
              if (urlMatches && urlMatches.length > 0) {
                const uniqueUrls = [
                  ...new Set(urlMatches.map(u => (u.startsWith('//') ? `https:${u}` : u))),
                ];
                diag.push(`asset=html-candidates(${uniqueUrls.length})`);
                // Try each candidate — import and check for sentinel exports
                for (const candidateUrl of uniqueUrls) {
                  try {
                    const candidateModule = (await import(
                      /* @vite-ignore */ candidateUrl
                    )) as Record<string, unknown>;
                    const testDiag: string[] = [];
                    const exports = discoverSentinelExports(candidateModule, testDiag);
                    if (exports) {
                      diag.push(`asset=html-verified(${candidateUrl.split('/').pop()})`);
                      return candidateUrl;
                    }
                  } catch {
                    // Not the sentinel module or import failed — continue
                  }
                }
                diag.push('asset=html-no-sentinel');
              } else {
                // Also try extracting from inline script that references asset paths
                const assetPathMatch = html.match(/["']\/assets\/[a-zA-Z0-9_-]+\.js["']/g);
                if (assetPathMatch && assetPathMatch.length > 0) {
                  const paths = [...new Set(assetPathMatch.map(m => m.replace(/["']/g, '')))];
                  diag.push(`asset=html-relative-paths(${paths.length})`);
                  for (const path of paths) {
                    const fullUrl = `https://cdn.oaistatic.com${path}`;
                    try {
                      const candidateModule = (await import(/* @vite-ignore */ fullUrl)) as Record<
                        string,
                        unknown
                      >;
                      const testDiag: string[] = [];
                      const exports = discoverSentinelExports(candidateModule, testDiag);
                      if (exports) {
                        diag.push(`asset=html-relative-verified(${path})`);
                        return fullUrl;
                      }
                    } catch {
                      // Not the sentinel module — continue
                    }
                  }
                  diag.push('asset=html-relative-no-sentinel');
                } else {
                  diag.push('asset=html-no-urls');
                }
              }
            } else {
              diag.push(`asset=html-fetch-${htmlRes.status}`);
            }
          } catch (e) {
            diag.push(`asset=html-err(${e instanceof Error ? e.message : 'unknown'})`);
          }

          // Strategy 5: Last-resort known fallback URL.
          // This URL may go stale when OpenAI deploys, but it's better than failing
          // completely. The discoverSentinelExports() validation will catch if the
          // module's export names have rotated.
          const FALLBACK_SENTINEL_URL = 'https://cdn.oaistatic.com/assets/i5bamk05qmvsi6c3.js';
          try {
            const fallbackModule = (await import(
              /* @vite-ignore */ FALLBACK_SENTINEL_URL
            )) as Record<string, unknown>;
            const testDiag: string[] = [];
            const exports = discoverSentinelExports(fallbackModule, testDiag);
            if (exports) {
              diag.push(`asset=fallback-verified(${FALLBACK_SENTINEL_URL.split('/').pop()})`);
              return FALLBACK_SENTINEL_URL;
            }
            diag.push('asset=fallback-no-sentinel-exports');
          } catch {
            diag.push('asset=fallback-import-failed');
          }

          diag.push('asset=not-found');
          return null;
        };

        // ── Resolve sentinel headers (warmup + challenge solving) ──
        // Extracted as inner function to enable retry on 403.

        const resolveSentinelHeaders = async (
          headers: Record<string, string>,
          diag: string[],
        ): Promise<{ sentinelHeaders: Record<string, string>; sentinelError: string }> => {
          let sentinelHeaders: Record<string, string> = {};
          let sentinelError = '';

          // Warmup Sentinel endpoints (must complete BEFORE challenge solving).
          // These prime server-side sentinel state; skipping them causes 403 "unusual activity".
          const warmupUrls = [
            'https://chatgpt.com/backend-api/conversation/init',
            'https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare',
            'https://chatgpt.com/backend-api/sentinel/chat-requirements/finalize',
          ];
          for (const warmupUrl of warmupUrls) {
            try {
              const r = await fetch(warmupUrl, {
                method: 'POST',
                headers,
                body: '{}',
                credentials: 'include',
              });
              diag.push(`warmup:${warmupUrl.split('/').pop()}=${r.status}`);
            } catch (e) {
              diag.push(
                `warmup:${warmupUrl.split('/').pop()}=err(${e instanceof Error ? e.message : 'unknown'})`,
              );
            }
          }

          // Sentinel antibot challenge solving
          try {
            const assetUrl = await findSentinelAssetUrl(diag);
            if (!assetUrl) {
              sentinelError =
                'Sentinel oaistatic script not found on page. The ChatGPT page may not have fully loaded.';
              return { sentinelHeaders, sentinelError };
            }

            const sentinelModule = (await import(/* @vite-ignore */ assetUrl)) as Record<
              string,
              unknown
            >;

            // Discover function roles by structural fingerprinting
            const exports = discoverSentinelExports(sentinelModule, diag);
            if (!exports) {
              const exportNames = Object.keys(sentinelModule).join(', ');
              sentinelError = `Sentinel function discovery failed — could not identify chatRequirements/headerBuilder from exports: [${exportNames}]. Function names may have been rotated.`;
              return { sentinelHeaders, sentinelError };
            }

            // Call chatRequirements to get challenge parameters
            const chatReqs = await Promise.race([
              exports.chatRequirements(),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error('chat-requirements timed out after 15s')),
                  15_000,
                ),
              ),
            ]);

            // Validate the response looks like real chat-requirements
            const turnstile = chatReqs?.turnstile as Record<string, unknown> | undefined;
            const turnstileKey = turnstile?.bx ?? turnstile?.dx;

            if (!turnstileKey) {
              sentinelError = 'Sentinel chat-requirements response missing turnstile key (bx/dx)';
              return { sentinelHeaders, sentinelError };
            }

            // Solve Turnstile challenge
            let turnstileToken: unknown = null;
            try {
              if (exports.turnstileSolver) {
                turnstileToken = await Promise.race([
                  exports.turnstileSolver(turnstileKey),
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () => reject(new Error('Turnstile solver timed out after 15s')),
                      15_000,
                    ),
                  ),
                ]);
              }
            } catch (e) {
              diag.push(`turnstile-err=${e instanceof Error ? e.message : 'unknown'}`);
            }

            // Solve Arkose challenge
            let arkoseToken: unknown = null;
            try {
              if (exports.arkoseEnforcer?.getEnforcementToken) {
                arkoseToken = await Promise.race([
                  exports.arkoseEnforcer.getEnforcementToken(chatReqs),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Arkose timed out after 15s')), 15_000),
                  ),
                ]);
              }
            } catch (e) {
              diag.push(`arkose-err=${e instanceof Error ? e.message : 'unknown'}`);
            }

            // Resolve proof-of-work token. powEnforcer may be:
            // - An enforcer object with getEnforcementToken() (older API)
            // - A PoW solver object with {answers, maxAttempts, requirementsSeed, sid}
            //   which headerBuilder uses directly to build the Proof-Token header
            let proofToken: unknown = null;
            try {
              if (exports.powEnforcer && typeof exports.powEnforcer === 'object') {
                const pow = exports.powEnforcer as Record<string, unknown>;
                if (typeof pow.getEnforcementToken === 'function') {
                  proofToken = await Promise.race([
                    (pow.getEnforcementToken as (r: unknown) => Promise<unknown>)(chatReqs),
                    new Promise<never>((_, reject) =>
                      setTimeout(
                        () => reject(new Error('Proof token timed out after 15s')),
                        15_000,
                      ),
                    ),
                  ]);
                } else if (pow.answers !== undefined) {
                  proofToken = exports.powEnforcer;
                }
              }
            } catch (e) {
              diag.push(`pow-err=${e instanceof Error ? e.message : 'unknown'}`);
            }

            // Build sentinel headers
            const extraHeaders = await Promise.race([
              exports.headerBuilder(chatReqs, arkoseToken, turnstileToken, proofToken, null),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('headerBuilder timed out after 15s')), 15_000),
              ),
            ]);
            if (typeof extraHeaders === 'object' && extraHeaders !== null) {
              sentinelHeaders = extraHeaders as Record<string, string>;
            }
          } catch (e) {
            sentinelError = `Sentinel challenge failed: ${e instanceof Error ? e.message : String(e)}`;
          }

          // Check for Signal Orchestrator (behavioral biometrics) — informational only
          try {
            const soKeys = Object.keys(window).filter(k => k.startsWith('__oai_so_'));
            diag.push(
              `signal-orchestrator=${soKeys.length > 0 ? `${soKeys.length}-props` : 'absent'}`,
            );
          } catch {
            /* ignore */
          }

          return { sentinelHeaders, sentinelError };
        };

        // ── Step 3: Resolve sentinel headers ──
        const diag: string[] = [];
        let { sentinelHeaders, sentinelError } = await resolveSentinelHeaders(cgHeaders, diag);

        // ── Step 4: Build conversation request body ──
        const messageId = crypto.randomUUID();
        const parentMessageId = existingParentMsgId || crypto.randomUUID();

        const conversationBody: Record<string, unknown> = {
          action: 'next',
          messages: [
            {
              id: messageId,
              author: { role: 'user' },
              create_time: Date.now() / 1000,
              content: {
                content_type: 'text',
                parts: [cgPrompt],
              },
              metadata: {
                serialization_metadata: { custom_symbol_offsets: [] },
              },
            },
          ],
          parent_message_id: parentMessageId,
          model: 'auto',
          timezone_offset_min: new Date().getTimezoneOffset(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          conversation_mode: { kind: 'primary_assistant' },
          enable_message_followups: true,
          system_hints: [],
          supports_buffering: true,
          client_contextual_info: {
            is_dark_mode: window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false,
            time_since_loaded: Math.floor(performance.now() / 1000),
            page_height: window.innerHeight,
            page_width: window.innerWidth,
            pixel_ratio: window.devicePixelRatio || 1,
            screen_height: screen.height,
            screen_width: screen.width,
            app_name: 'chatgpt.com',
          },
          paragen_cot_summary_display_override: 'allow',
          force_parallel_switch: 'auto',
        };

        // Include conversation_id for continuation turns
        if (existingConversationId) {
          conversationBody.conversation_id = existingConversationId;
        }

        // ── Step 5: Send conversation request (with sentinel headers if available) ──
        // On 403, retry once with freshly resolved sentinel tokens + refreshed access token.

        const sendConversation = async (headers: Record<string, string>): Promise<Response> => {
          const finalHeaders =
            Object.keys(sentinelHeaders).length > 0 ? { ...headers, ...sentinelHeaders } : headers;
          return fetch('https://chatgpt.com/backend-api/conversation', {
            method: 'POST',
            headers: finalHeaders,
            credentials: 'include',
            body: JSON.stringify(conversationBody),
          });
        };

        let cgResponse: Response;
        try {
          cgResponse = await sendConversation(cgHeaders);
        } catch {
          // Network error — retry without sentinel headers
          cgResponse = await fetch('https://chatgpt.com/backend-api/conversation', {
            method: 'POST',
            headers: cgHeaders,
            credentials: 'include',
            body: JSON.stringify(conversationBody),
          });
        }

        // ── 403 Retry: refresh access token + re-solve sentinel challenges ──
        if (cgResponse.status === 403) {
          diag.push('retry=403');

          // Refresh access token
          try {
            const retrySession = await fetch('https://chatgpt.com/api/auth/session', {
              credentials: 'include',
            });
            if (retrySession.ok) {
              const retryData = (await retrySession.json()) as Record<string, unknown>;
              const newToken = (retryData.accessToken ?? '') as string;
              if (newToken) {
                accessToken = newToken;
                diag.push('retry-token=refreshed');
              }
            }
          } catch {
            /* use existing token */
          }

          const retryHeaders = baseHeaders(accessToken, deviceId);
          const retryDiag: string[] = [];
          const retryResult = await resolveSentinelHeaders(retryHeaders, retryDiag);
          diag.push(...retryDiag.map(d => `retry:${d}`));

          sentinelHeaders = retryResult.sentinelHeaders;
          sentinelError = retryResult.sentinelError;

          try {
            cgResponse = await sendConversation(retryHeaders);
          } catch {
            cgResponse = await fetch('https://chatgpt.com/backend-api/conversation', {
              method: 'POST',
              headers: retryHeaders,
              credentials: 'include',
              body: JSON.stringify(conversationBody),
            });
          }
        }

        if (!cgResponse.ok) {
          let errorBody = '';
          try {
            errorBody = await cgResponse.text();
            if (errorBody.length > 500) errorBody = errorBody.slice(0, 500);
          } catch {
            /* ignore */
          }
          const diagStr = diag.length > 0 ? ` [diag: ${diag.join('; ')}]` : '';
          const sentinelHint = sentinelError
            ? ` Sentinel: ${sentinelError}${diagStr}`
            : Object.keys(sentinelHeaders).length === 0
              ? ` Sentinel headers were not available — the oaistatic script may not have loaded on this page.${diagStr}`
              : diagStr;
          const authHint =
            cgResponse.status === 401 || cgResponse.status === 403
              ? ` Please visit https://chatgpt.com to verify your account is active, then log out and log back in via Settings → Models.${sentinelHint}`
              : sentinelHint;
          window.postMessage(
            {
              type: 'WEB_LLM_ERROR',
              requestId,
              error: `HTTP ${cgResponse.status}: ${cgResponse.statusText}${errorBody ? ` — ${errorBody}` : ''}${authHint}`,
            },
            origin,
          );
          return;
        }

        const cgReader = cgResponse.body?.getReader();
        if (!cgReader) {
          window.postMessage(
            { type: 'WEB_LLM_ERROR', requestId, error: 'No response body from ChatGPT' },
            origin,
          );
          return;
        }

        // ── Stream SSE response ──

        // Track conversation_id and last assistant message ID for continuation
        let capturedConversationId = existingConversationId;
        let capturedParentMsgId = '';

        const cgDecoder = new TextDecoder();
        let cgBuffer = '';

        while (true) {
          const { done, value } = await cgReader.read();
          if (done) break;

          cgBuffer += cgDecoder.decode(value, { stream: true });

          // Process complete lines
          while (cgBuffer.includes('\n')) {
            const lineEnd = cgBuffer.indexOf('\n');
            const line = cgBuffer.slice(0, lineEnd).trim();
            cgBuffer = cgBuffer.slice(lineEnd + 1);

            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();

              // Extract conversation_id and message ID for continuity
              if (dataStr !== '[DONE]') {
                try {
                  const parsed = JSON.parse(dataStr) as Record<string, unknown>;
                  if (parsed.conversation_id && typeof parsed.conversation_id === 'string') {
                    capturedConversationId = parsed.conversation_id;
                  }
                  const msg = parsed.message as Record<string, unknown> | undefined;
                  if (msg?.id && typeof msg.id === 'string') {
                    const author = msg.author as Record<string, string> | undefined;
                    if (author?.role === 'assistant') {
                      capturedParentMsgId = msg.id;
                    }
                  }
                } catch {
                  /* ignore parse errors */
                }
              }

              const sseChunk = `${line}\n\n`;
              window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: sseChunk }, origin);
            }
          }
        }

        // Flush remaining data from decoder
        const cgFinal = cgDecoder.decode();
        if (cgFinal) cgBuffer += cgFinal;
        // Process any remaining complete lines
        while (cgBuffer.includes('\n')) {
          const lineEnd = cgBuffer.indexOf('\n');
          const line = cgBuffer.slice(0, lineEnd).trim();
          cgBuffer = cgBuffer.slice(lineEnd + 1);
          if (line.startsWith('data: ')) {
            window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: `${line}\n\n` }, origin);
          }
        }
        // Handle final line with no trailing newline
        const cgRemaining = cgBuffer.trim();
        if (cgRemaining.startsWith('data: ')) {
          window.postMessage(
            { type: 'WEB_LLM_CHUNK', requestId, chunk: `${cgRemaining}\n\n` },
            origin,
          );
        }

        // Inject synthetic conversation state event so the bridge can cache
        // conversation_id + parent_message_id for the next turn.
        if (capturedConversationId) {
          const compositeId = capturedParentMsgId
            ? `${capturedConversationId}|${capturedParentMsgId}`
            : capturedConversationId;
          const idChunk = `data: ${JSON.stringify({ type: 'chatgpt:conversation_state', conversation_id: compositeId })}\n\n`;
          window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: idChunk }, origin);
        }

        window.postMessage({ type: 'WEB_LLM_DONE', requestId }, origin);
      } finally {
        cleanupKeepAlive();
      }
    }

    // ── Rakuten AI (ai.rakuten.co.jp) ────────────────────────────────────────
    // Uses WebSocket for real-time chat streaming, REST with HMAC-SHA256 signing
    // for thread management. Converts WebSocket messages to SSE-compatible events.
    async function handleRakuten(): Promise<void> {
      // Emit diagnostic info as SSE events — bridge logs these at TRACE level
      const dbg = (msg: string, detail?: unknown) => {
        const info = detail !== undefined ? JSON.stringify(detail) : '';
        window.postMessage(
          {
            type: 'WEB_LLM_CHUNK',
            requestId,
            chunk: `data: ${JSON.stringify({ type: 'rakuten:debug', msg, detail: info.slice(0, 500) })}\n\n`,
          },
          origin,
        );
      };

      // ── Parse stub body ──
      let prompt = '';
      let chatId: string | undefined;
      let thinkingLevel = 'fast';
      try {
        const bodyObj = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >;
        prompt = (bodyObj.prompt as string) ?? '';
        chatId = bodyObj.chatId as string | undefined;
        thinkingLevel = (bodyObj.thinkingLevel as string) ?? 'fast';
      } catch {
        /* ignore parse errors */
      }

      dbg('Starting', {
        promptLen: prompt.length,
        chatId,
        thinkingLevel,
        tabUrl: window.location.href,
        hasBmSv: document.cookie.includes('bm_sv'),
      });

      // ── HMAC-SHA256 Signing (inline — cannot import modules in serialized context) ──
      // ⚠ SYNC: HMAC key also in rakuten-signing.ts and rakuten-web.ts (refreshAuth)
      const HMAC_KEY = '4f0465bfea7761a510dda451ff86a935bf0c8ed6fb37f80441509c64328788c8';

      const hmacSign = async (message: string, key: string): Promise<string> => {
        const enc = new TextEncoder();
        const cryptoKey = await crypto.subtle.importKey(
          'raw',
          enc.encode(key),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
        const bytes = new Uint8Array(sig);
        return btoa(Array.from(bytes, c => String.fromCharCode(c)).join(''))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=/g, '');
      };

      const signRestHeaders = async (
        method: string,
        apiUrl: string,
      ): Promise<Record<string, string>> => {
        const parsed = new URL(apiUrl);
        const params: Record<string, string> = {};
        parsed.searchParams.forEach((v, k) => {
          params[k] = v;
        });
        const ts = Math.floor(Date.now() / 1000).toString();
        const nonce = crypto.randomUUID();
        const sortedParamStr = Object.keys(params)
          .sort()
          .map(k => `${k}=${params[k]}`)
          .join('');
        const sigStr = `${method}${parsed.pathname}${sortedParamStr}${ts}${nonce}`;
        const sig = await hmacSign(sigStr, HMAC_KEY);
        return { 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': sig };
      };

      // ══════════════════════════════════════════════════════════════════════
      // Token + Device-Id extraction
      //
      // The Rakuten server BINDS the SSO token to the Device-Id used when the
      // session was created.  Using a mismatched pair returns 5001000
      // "System unavailable".  We MUST capture BOTH from the SPA's own
      // outgoing requests (Axios → XHR) to guarantee they are paired.
      //
      // Strategy 0: Reuse cached credentials from a previous turn (same page)
      // Strategy 1: Intercept XHR + fetch headers from SPA's Axios requests
      // Strategy 2: Read from localStorage (fast but may be stale)
      // Strategy 3: Anonymous auth (creates fresh paired token + device-id)
      // ══════════════════════════════════════════════════════════════════════

      // Page-level credential cache — persists across turns within the same tab.
      // Anonymous tokens expire in 1 hour, so we cache for 50 minutes.
      type RakutenCache = { bearer: string; deviceId: string; source: string; ts: number };
      const CACHE_KEY = '__chromeclaw_rakuten_creds';
      const CACHE_TTL = 50 * 60 * 1000; // 50 minutes
      const cached = (window as unknown as Record<string, RakutenCache | undefined>)[CACHE_KEY];
      const cacheValid = cached && (Date.now() - cached.ts) < CACHE_TTL;

      let bearer = cacheValid ? cached.bearer : '';
      let deviceId = cacheValid ? cached.deviceId : '';
      let bearerSource = cacheValid ? cached.source : '';

      if (cacheValid) {
        dbg('Using cached credentials', {
          source: bearerSource,
          tokenPrefix: bearer.slice(0, 20) + '...',
          deviceId,
          ageMs: Date.now() - cached.ts,
        });
      }

      // Skip token acquisition if we already have cached credentials
      if (!bearer) {

      // ── Strategy 1: Intercept paired token + device-id from SPA's XHR ──
      // The Rakuten SPA uses Axios (which uses XMLHttpRequest).  We hook
      // XHR.setRequestHeader to capture both Authorization and Device-Id
      // headers from the same request, guaranteeing they are paired.
      try {
        const intercepted = await new Promise<{ token: string; did: string } | null>(resolve => {
          let capturedToken = '';
          let capturedDeviceId = '';
          let resolved = false;

          const done = (result: { token: string; did: string } | null) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeout);
            // Restore hooks
            try { XMLHttpRequest.prototype.setRequestHeader = origSetReqHeader; } catch { /* ignore */ }
            try { window.fetch = origFetch; } catch { /* ignore */ }
            resolve(result);
          };

          const timeout = setTimeout(() => done(null), 5000);

          // Hook XHR setRequestHeader (Axios path)
          const origSetReqHeader = XMLHttpRequest.prototype.setRequestHeader;
          XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
            if (name === 'Authorization' && typeof value === 'string' && value.length > 20) {
              capturedToken = value.startsWith('Bearer ') ? value.slice(7) : value;
            }
            if (name === 'Device-Id' && typeof value === 'string' && value.length > 10) {
              capturedDeviceId = value;
            }
            if (capturedToken && capturedDeviceId) {
              done({ token: capturedToken, did: capturedDeviceId });
            }
            return origSetReqHeader.call(this, name, value);
          };

          // Hook fetch (some SPA paths may use fetch instead of XHR)
          const origFetch = window.fetch;
          window.fetch = function (input: RequestInfo | URL, initArg?: RequestInit) {
            try {
              const headers = initArg?.headers;
              let authH = '';
              let didH = '';
              if (headers && typeof headers === 'object' && !Array.isArray(headers) && !(headers instanceof Headers)) {
                const h = headers as Record<string, string>;
                authH = h.Authorization ?? h.authorization ?? '';
                didH = h['Device-Id'] ?? h['device-id'] ?? '';
              } else if (headers instanceof Headers) {
                authH = headers.get('Authorization') ?? '';
                didH = headers.get('Device-Id') ?? '';
              }
              if (authH.length > 20 && !capturedToken) {
                capturedToken = authH.startsWith('Bearer ') ? authH.slice(7) : authH;
              }
              if (didH.length > 10 && !capturedDeviceId) {
                capturedDeviceId = didH;
              }
              if (capturedToken && capturedDeviceId) {
                done({ token: capturedToken, did: capturedDeviceId });
              }
            } catch { /* ignore header extraction errors */ }
            return origFetch.call(window, input, initArg);
          } as typeof window.fetch;

          // Trigger the SPA to make an API call so our hooks can capture headers.
          // The SPA refreshes thread list on focus/visibility events.
          try { window.dispatchEvent(new Event('focus')); } catch { /* ignore */ }
          try { window.dispatchEvent(new Event('online')); } catch { /* ignore */ }
          try {
            Object.defineProperty(document, 'hidden', { value: false, configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
          } catch { /* ignore */ }
        });

        if (intercepted) {
          bearer = intercepted.token;
          deviceId = intercepted.did;
          bearerSource = 'intercepted';
          dbg('Intercepted paired token + device-id from SPA', {
            tokenPrefix: bearer.slice(0, 20) + '...',
            deviceId,
          });
        }
      } catch {
        /* ignore intercept errors */
      }

      // ── Strategy 2: Read from localStorage ──
      // The token may be stale, but if we can also find the matching device-id,
      // the pair might still work.
      if (!bearer) {
        try {
          const at = localStorage.getItem('accessToken');
          if (at && at.length > 10) {
            bearer = at;
            bearerSource = 'accessToken';
          }
        } catch { /* ignore */ }
      }
      if (!bearer) {
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || key === 'accessToken') continue;
            const val = localStorage.getItem(key);
            if (val && val.startsWith('@St.')) {
              bearer = val;
              bearerSource = key;
              break;
            }
          }
        } catch { /* localStorage not accessible */ }
      }

      // If we have a localStorage token but NO device-id yet, we CANNOT safely
      // use that token — the server will reject the mismatched pair.
      // Try to find the SPA's device-id from ninja-global Zustand store.
      if (bearer && !deviceId) {
        try {
          const ninjaGlobal = localStorage.getItem('ninja-global');
          if (ninjaGlobal) {
            const ng = JSON.parse(ninjaGlobal) as Record<string, unknown>;
            const state = (ng.state ?? ng) as Record<string, unknown>;
            const did = (state.tempUserId ?? state.deviceId) as string | undefined;
            if (did && did.length > 10) deviceId = did;
          }
        } catch { /* not JSON */ }

        // Scan for keys containing "device" and "id"
        if (!deviceId) {
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (!key) continue;
              const lk = key.toLowerCase();
              if (lk.includes('device') && lk.includes('id')) {
                const val = localStorage.getItem(key);
                if (val && val.length > 10) {
                  deviceId = val.replace(/^"|"$/g, '');
                  break;
                }
              }
            }
          } catch { /* ignore */ }
        }

        // If we STILL have no device-id, the localStorage token is unusable —
        // discard it and fall through to anonymous auth with a fresh device-id.
        if (!deviceId) {
          dbg('localStorage token found but no matching device-id — discarding', {
            tokenPrefix: bearer.slice(0, 20) + '...',
          });
          bearer = '';
          bearerSource = '';
        }
      }

      dbg('Token search', {
        found: !!bearer,
        source: bearerSource,
        tokenPrefix: bearer ? bearer.slice(0, 20) + '...' : 'none',
        deviceId: deviceId || 'none',
        localStorageKeys: (() => {
          try { const keys: string[] = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k) keys.push(k); } return keys; } catch { return []; }
        })(),
      });

      // ── Strategy 3: Anonymous auth (creates fresh paired token + device-id) ──
      if (!bearer) {
        if (!deviceId) {
          deviceId = `${crypto.randomUUID()}-${Math.random().toString(36).slice(2, 8)}`;
        }
        dbg('No usable token, trying anonymous auth...', { deviceId });
        try {
          const anonUrl = 'https://ai.rakuten.co.jp/api/v2/auth/anonymous';
          const anonSig = await signRestHeaders('GET', anonUrl);
          const anonRes = await fetch(anonUrl, {
            headers: {
              Accept: 'application/json, text/plain, */*',
              'X-Platform': 'WEB',
              'X-Country-Code': 'US',
              'Device-Id': deviceId,
              'Accept-Language': 'en',
              ...anonSig,
            },
            credentials: 'include',
          });
          const anonText = await anonRes.text();
          dbg('Anonymous auth response', { status: anonRes.status, body: anonText.slice(0, 400) });
          if (anonRes.ok) {
            try {
              const anonData = JSON.parse(anonText) as Record<string, unknown>;
              if (anonData.code === '0') {
                const anonInner = anonData.data as Record<string, string> | undefined;
                if (anonInner?.accessToken) {
                  bearer = anonInner.accessToken;
                  bearerSource = 'anonymous';
                }
              }
            } catch { /* parse error */ }
          }
        } catch (e) {
          dbg('Anonymous auth failed', e);
        }
      }

      } // end: if (!bearer) — skip token acquisition when cached

      if (!bearer) {
        dbg('No token found after all attempts');
        window.postMessage(
          {
            type: 'WEB_LLM_ERROR',
            requestId,
            error:
              'Rakuten AI: No access token found. Please visit https://ai.rakuten.co.jp and log in, then try again.',
          },
          origin,
        );
        return;
      }

      dbg('Final credentials', {
        source: bearerSource,
        tokenPrefix: bearer.slice(0, 20) + '...',
        deviceId,
      });

      // Cache credentials for reuse on subsequent turns (same tab)
      (window as unknown as Record<string, RakutenCache>)[CACHE_KEY] = {
        bearer, deviceId, source: bearerSource, ts: Date.now(),
      };

      // ── Common REST headers ──
      // Note: Do NOT include Content-Type on GET requests (matches SPA behavior)
      const baseHeaders = (extras: Record<string, string> = {}, method = 'GET') => {
        const h: Record<string, string> = {
          Accept: 'application/json, text/plain, */*',
          'X-Platform': 'WEB',
          'X-Country-Code': 'US',
          Authorization: `Bearer ${bearer}`,
          'Device-Id': deviceId,
          'Accept-Language': 'en',
          ...extras,
        };
        if (method !== 'GET') h['Content-Type'] = 'application/json';
        return h;
      };

      // ── Helper: make a signed REST call and return parsed JSON ──
      const signedFetch = async (
        method: string,
        apiUrl: string,
        body?: string,
      ): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; raw: string }> => {
        const sigHeaders = await signRestHeaders(method, apiUrl);
        const res = await fetch(apiUrl, {
          method,
          headers: baseHeaders(sigHeaders, method),
          body,
          credentials: 'include',
        });
        const raw = await res.text();
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          /* not JSON */
        }
        return { ok: res.ok, status: res.status, data, raw };
      };

      // ── Create or reuse thread ──
      let threadId = chatId ?? '';
      if (threadId) {
        dbg('Reusing cached thread', { threadId });
      } else {
        // Try to discover the scenarioAgentId dynamically.
        // The Rakuten web app may change this ID on updates.
        const FALLBACK_AGENT_ID = '6812e64f9dfaf301f7000001';
        let scenarioAgentId = FALLBACK_AGENT_ID;

        // Check if the Rakuten app stored the agent ID in its state
        try {
          // The app's Zustand store may be accessible on window.__NEXT_DATA__ or similar
          // Also check for any DOM element that contains the agent ID
          const appRoot = document.querySelector('[data-scenario-agent-id]');
          if (appRoot) {
            const id = appRoot.getAttribute('data-scenario-agent-id');
            if (id) scenarioAgentId = id;
          }
        } catch {
          /* ignore */
        }

        dbg('Creating thread', { scenarioAgentId });

        // Helper: attempt thread creation with current bearer token
        const tryCreateThread = async (): Promise<{
          threadId: string | null;
          error: string | null;
        }> => {
          try {
            const result = await signedFetch(
              'POST',
              'https://ai.rakuten.co.jp/api/v1/thread',
              JSON.stringify({
                scenarioAgentId,
                title: 'Chat with Rakuten AI',
                multipleThreadMode: false,
              }),
            );
            dbg('Thread creation response', {
              status: result.status,
              code: result.data.code,
              message: result.data.message,
              hasData: !!result.data.data,
            });
            if (!result.ok) {
              return {
                threadId: null,
                error: `HTTP ${result.status}: ${result.raw.slice(0, 200)}`,
              };
            }
            const apiCode = result.data.code as string | undefined;
            if (apiCode && apiCode !== '0') {
              return {
                threadId: null,
                error: `${result.data.message ?? 'Unknown error'} (code ${apiCode})`,
              };
            }
            const inner = result.data.data as Record<string, string> | undefined;
            const tid = inner?.threadId ?? inner?.id ?? null;
            return { threadId: tid, error: tid ? null : 'No threadId in response' };
          } catch (err) {
            return {
              threadId: null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        };

        // Helper: try to refresh the bearer token
        const tryRefreshToken = async (): Promise<string | null> => {
          dbg('Attempting token refresh...');

          // 1. Try the dedicated refreshToken key first (Rakuten stores it as plain string)
          try {
            const rt = localStorage.getItem('refreshToken');
            if (rt && rt.length > 10) {
              dbg('Found refreshToken key, trying refresh...');
              const refreshUrl = 'https://ai.rakuten.co.jp/api/v2/auth/refresh';
              const refreshSig = await signRestHeaders('POST', refreshUrl);
              const refreshRes = await fetch(refreshUrl, {
                method: 'POST',
                headers: baseHeaders(refreshSig),
                body: JSON.stringify({ refreshToken: rt }),
                credentials: 'include',
              });
              const refreshText = await refreshRes.text();
              dbg('Refresh response', { status: refreshRes.status, body: refreshText });
              if (refreshRes.ok) {
                try {
                  const refreshData = JSON.parse(refreshText) as Record<string, unknown>;
                  const rCode = refreshData.code as string | undefined;
                  if (rCode === '0') {
                    const rInner = refreshData.data as Record<string, string> | undefined;
                    if (rInner?.accessToken) {
                      // Store the new tokens back so future calls use them
                      try {
                        localStorage.setItem('accessToken', rInner.accessToken);
                        if (rInner.refreshToken) {
                          localStorage.setItem('refreshToken', rInner.refreshToken);
                        }
                      } catch {
                        /* ignore storage errors */
                      }
                      return rInner.accessToken;
                    }
                  }
                } catch {
                  /* parse error */
                }
              }
            }
          } catch {
            /* ignore */
          }

          // 2. Try to get a fresh SSO token by calling the SPA's auth initialization.
          //    The Rakuten SPA writes tokens lazily — the valid token may only exist
          //    in the app's Zustand memory store. We can try to trigger a re-auth
          //    using an iframe that loads the page (shares localStorage + cookies).
          dbg('Trying iframe-based re-auth...');
          try {
            const freshToken = await new Promise<string | null>((resolve) => {
              const timeout = setTimeout(() => {
                try { document.body.removeChild(iframe); } catch { /* ignore */ }
                resolve(null);
              }, 8000);

              const iframe = document.createElement('iframe');
              iframe.style.display = 'none';
              iframe.src = 'https://ai.rakuten.co.jp';
              document.body.appendChild(iframe);

              // Poll localStorage for a new token written by the iframe's SPA
              const originalToken = bearer;
              let checks = 0;
              const poll = setInterval(() => {
                checks++;
                try {
                  const at = localStorage.getItem('accessToken');
                  if (at && at.length > 10 && at !== originalToken) {
                    clearInterval(poll);
                    clearTimeout(timeout);
                    try { document.body.removeChild(iframe); } catch { /* ignore */ }
                    resolve(at);
                    return;
                  }
                } catch { /* ignore */ }
                if (checks > 40) { // 40 * 200ms = 8s
                  clearInterval(poll);
                  clearTimeout(timeout);
                  try { document.body.removeChild(iframe); } catch { /* ignore */ }
                  resolve(null);
                }
              }, 200);
            });

            if (freshToken) {
              dbg('Got fresh token via iframe re-auth', {
                prefix: freshToken.slice(0, 20) + '...',
              });
              return freshToken;
            }
            dbg('No new token from iframe re-auth');
          } catch (iframeErr) {
            dbg('Iframe re-auth failed', iframeErr);
          }

          // 3. Fallback: anonymous auth (creates guest session with at_ token)
          dbg('Trying anonymous auth as fallback...');
          try {
            const anonUrl = 'https://ai.rakuten.co.jp/api/v2/auth/anonymous';
            const anonSig = await signRestHeaders('GET', anonUrl);
            const anonRes = await fetch(anonUrl, {
              headers: baseHeaders(anonSig),
              credentials: 'include',
            });
            const anonText = await anonRes.text();
            dbg('Anonymous auth response', { status: anonRes.status, body: anonText });
            if (anonRes.ok) {
              try {
                const anonData = JSON.parse(anonText) as Record<string, unknown>;
                const aCode = anonData.code as string | undefined;
                if (aCode === '0') {
                  const aInner = anonData.data as Record<string, string> | undefined;
                  if (aInner?.accessToken) return aInner.accessToken;
                }
              } catch {
                /* parse error */
              }
            }
          } catch (e) {
            dbg('Anonymous auth failed', e);
          }
          dbg('All refresh attempts failed');
          return null;
        };

        // First, verify the token works with a lightweight API call
        dbg('Verifying token with thread list...');
        let verifyOk = false;
        try {
          const verifyResult = await signedFetch(
            'GET',
            'https://ai.rakuten.co.jp/api/v1/thread/user?pageSize=1&pageNum=0',
          );
          dbg('Token verification', {
            status: verifyResult.status,
            code: verifyResult.data.code,
            ok: verifyResult.ok,
            raw: verifyResult.raw.slice(0, 300),
          });
          verifyOk = verifyResult.ok && (!verifyResult.data.code || verifyResult.data.code === '0');
        } catch (verifyErr) {
          dbg('Token verification threw', {
            error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
          });
        }

        // If the verify call fails, try refreshing first before any thread creation
        if (!verifyOk) {
          dbg('Token appears invalid, refreshing before thread creation...');
          const newToken = await tryRefreshToken();
          if (newToken) {
            bearer = newToken;
            // Update cache so subsequent turns use the refreshed token
            (window as unknown as Record<string, RakutenCache>)[CACHE_KEY] = {
              bearer, deviceId, source: bearerSource, ts: Date.now(),
            };
            dbg('Token refreshed successfully', { prefix: newToken.slice(0, 20) + '...' });
          } else {
            dbg('Token refresh failed — proceeding with existing token');
          }
        }

        let lastError = '';
        try {
          // First attempt
          const result1 = await tryCreateThread();
          threadId = result1.threadId ?? '';
          lastError = result1.error ?? '';

          // If first attempt fails, try refreshing the token and retry
          if (!threadId && !lastError.includes('HTTP 4')) {
            dbg('Thread creation failed, attempting token refresh...', { error: lastError });
            const newToken = await tryRefreshToken();
            if (newToken) {
              bearer = newToken;
              // Update cache so subsequent turns use the refreshed token
              (window as unknown as Record<string, RakutenCache>)[CACHE_KEY] = {
                bearer, deviceId, source: bearerSource, ts: Date.now(),
              };
              // baseHeaders closure captures `bearer` by reference, so updating it works
              const result2 = await tryCreateThread();
              threadId = result2.threadId ?? '';
              lastError = result2.error ?? lastError;
            }
          }

          if (!threadId) {
            window.postMessage(
              {
                type: 'WEB_LLM_ERROR',
                requestId,
                error: `Rakuten AI: ${lastError || 'Failed to create thread'}. Please visit https://ai.rakuten.co.jp, refresh the page, then try again.`,
              },
              origin,
            );
            return;
          }
        } catch (err) {
          window.postMessage(
            {
              type: 'WEB_LLM_ERROR',
              requestId,
              error: `Rakuten AI: Thread creation error — ${err instanceof Error ? err.message : String(err)}`,
            },
            origin,
          );
          return;
        }
      }

      dbg('Thread ready', { threadId });

      // Emit thread ID so bridge can cache it for conversation continuity
      window.postMessage(
        {
          type: 'WEB_LLM_CHUNK',
          requestId,
          chunk: `data: ${JSON.stringify({ type: 'rakuten:thread_id', thread_id: threadId })}\n\n`,
        },
        origin,
      );

      // ── Determine WebSocket token ──
      // The WebSocket uses the same bearer token.  We use whatever token
      // was used to create the thread so they belong to the same session.
      // The @St. SSO token should work for both REST and WebSocket when
      // paired with the correct Device-Id.
      const wsToken = bearer;

      dbg('WebSocket token decision', {
        tokenPrefix: wsToken.slice(0, 20) + '...',
        tokenType: wsToken.startsWith('@St.') ? 'SSO' : wsToken.startsWith('at_') ? 'API' : 'unknown',
        tokenLength: wsToken.length,
        deviceId,
        threadId,
      });

      // ── Open signed WebSocket connection ──
      // SPA path: /ws/v1/chat?deviceId=X&platform=WEB&accessToken=TOKEN
      // Then signed with x-timestamp, x-nonce, x-signature (HMAC-SHA256)
      let ws: WebSocket;
      try {
        const wsUrl = new URL('wss://companion.ai.rakuten.co.jp/ws/v1/chat');
        wsUrl.searchParams.set('deviceId', deviceId);
        wsUrl.searchParams.set('platform', 'WEB');
        wsUrl.searchParams.set('accessToken', wsToken);

        // Sign: collect non-x- params, sort alphabetically, build sig input
        const nonXParams: Record<string, string> = {};
        wsUrl.searchParams.forEach((v, k) => {
          if (!k.startsWith('x-')) nonXParams[k] = v;
        });
        const wsTs = Math.floor(Date.now() / 1000).toString();
        const wsNonce = crypto.randomUUID();
        const wsSortedStr = Object.keys(nonXParams)
          .sort()
          .map(k => `${k}=${nonXParams[k]}`)
          .join('');
        const wsSigStr = `GET${wsUrl.pathname}${wsSortedStr}${wsTs}${wsNonce}`;
        const wsSig = await hmacSign(wsSigStr, HMAC_KEY);

        // Append signing params
        wsUrl.searchParams.set('x-timestamp', wsTs);
        wsUrl.searchParams.set('x-nonce', wsNonce);
        wsUrl.searchParams.set('x-signature', wsSig);

        const finalUrl = wsUrl.toString();

        dbg('Opening WebSocket', {
          host: wsUrl.host,
          path: wsUrl.pathname,
          tokenPrefix: wsToken.slice(0, 20) + '...',
          tokenType: wsToken.startsWith('@St.') ? 'SSO' : wsToken.startsWith('at_') ? 'API' : 'unknown',
          wsTs,
          wsNonce,
          wsSig,
          sigInput: wsSigStr.slice(0, 150) + (wsSigStr.length > 150 ? '...' : ''),
          sigInputLen: wsSigStr.length,
          sortedParamKeys: Object.keys(nonXParams).sort(),
          urlLength: finalUrl.length,
        });
        ws = new WebSocket(finalUrl);
      } catch (err) {
        dbg('WebSocket creation failed', err);
        window.postMessage(
          {
            type: 'WEB_LLM_ERROR',
            requestId,
            error: `Rakuten AI: WebSocket connection failed — ${err instanceof Error ? err.message : String(err)}`,
          },
          origin,
        );
        return;
      }

      // ── Handle WebSocket lifecycle ──
      const messageId = crypto.randomUUID();
      let streamDone = false;

      await new Promise<void>(resolve => {
        ws.onopen = () => {
          dbg('WebSocket opened, sending message', { chatRequestType: thinkingLevel === 'thinking' ? 'DEEP_THINK' : 'USER_INPUT' });
          // Send the chat message
          const chatRequestType = thinkingLevel === 'thinking' ? 'DEEP_THINK' : 'USER_INPUT';
          const nowMs = Date.now();
          const payload = {
            chatRequestType,
            role: 'user',
            deviceId,
            threadId,
            messageId,
            language: 'en',
            platform: 'WEB',
            detailedDeviceType: 'WEB',
            timestamp: nowMs,
            thinkDeeper: false,
            contents: [{ contentType: 'TEXT', textData: { text: prompt } }],
            retry: false,
            debug: false,
            timezoneString:
              Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles',
            explicitSearch: 'AUTO',
            countryCode: 'US',
            skipContextSave: false,
          };

          const envelope = {
            message: {
              type: 'CONVERSATION',
              payload: { action: chatRequestType, data: payload },
              metadata: { messageId, timestamp: nowMs },
            },
          };

          ws.send(JSON.stringify(envelope));
        };

        ws.onmessage = (event: MessageEvent) => {
          if (streamDone) return;

          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(typeof event.data === 'string' ? event.data : '{}') as Record<
              string,
              unknown
            >;
          } catch {
            return;
          }

          const wsData = msg.webSocket as Record<string, unknown> | undefined;
          if (!wsData) {
            dbg('WS message without webSocket field', { keys: Object.keys(msg) });
            return;
          }

          const wsType = wsData.type as string;

          // ACK messages — relay for debugging, filtered by adapter
          if (wsType === 'ACK') {
            const ackPayload = wsData.payload as Record<string, unknown> | undefined;
            const action = ackPayload?.action as string | undefined;
            window.postMessage(
              {
                type: 'WEB_LLM_CHUNK',
                requestId,
                chunk: `data: ${JSON.stringify({ type: 'rakuten:ack', action: action ?? 'ACK' })}\n\n`,
              },
              origin,
            );
            return;
          }

          // Error messages
          if (wsType === 'ERROR') {
            const errData = wsData.error as Record<string, unknown> | undefined;
            const errMsg = (errData?.message as string) ?? 'Unknown Rakuten AI error';
            const errCode = (errData?.code as string) ?? 'unknown';
            dbg('WS error message', { code: errCode, message: errMsg });
            window.postMessage(
              {
                type: 'WEB_LLM_CHUNK',
                requestId,
                chunk: `data: ${JSON.stringify({ type: 'rakuten:error', error: { code: errCode, message: errMsg } })}\n\n`,
              },
              origin,
            );
            streamDone = true;
            ws.close();
            window.postMessage({ type: 'WEB_LLM_DONE', requestId }, origin);
            resolve();
            return;
          }

          // Conversation messages (AI response streaming)
          if (wsType === 'CONVERSATION') {
            const convPayload = wsData.payload as Record<string, unknown> | undefined;
            const convData = convPayload?.data as Record<string, unknown> | undefined;
            if (!convData) return;

            const status = convData.chatResponseStatus as string;

            // Stream the chunk to bridge
            window.postMessage(
              {
                type: 'WEB_LLM_CHUNK',
                requestId,
                chunk: `data: ${JSON.stringify({ type: 'rakuten:conversation', data: convData })}\n\n`,
              },
              origin,
            );

            // Rakuten terminal statuses — signal stream completion
            if (status === 'DONE' || status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
              dbg('Stream terminal status', { status });
              streamDone = true;
              ws.close();
              window.postMessage({ type: 'WEB_LLM_DONE', requestId }, origin);
              resolve();
            }
            return;
          }

          // Notification and other types — log for diagnostics
          dbg('WS unhandled message type', { type: wsType });
        };

        // onerror always fires before onclose — just log it, let onclose handle the resolution
        ws.onerror = (ev) => {
          dbg('WebSocket error event (onclose will follow)', {
            readyState: ws.readyState,
            url: ws.url?.slice(0, 80),
          });
        };

        ws.onclose = (ev: CloseEvent) => {
          if (streamDone) return;
          streamDone = true;
          dbg('WebSocket closed', {
            code: ev.code,
            reason: ev.reason,
            wasClean: ev.wasClean,
            readyState: ws.readyState,
            tokenType: wsToken.startsWith('@St.') ? 'SSO' : wsToken.startsWith('at_') ? 'API' : 'unknown',
          });
          if (ev.code !== 1000) {
            // Abnormal close — report as error
            window.postMessage(
              {
                type: 'WEB_LLM_ERROR',
                requestId,
                error: `Rakuten AI: WebSocket closed (code ${ev.code}${ev.reason ? ': ' + ev.reason : ''})`,
              },
              origin,
            );
          } else {
            // Normal close without stream completing — treat as done
            window.postMessage({ type: 'WEB_LLM_DONE', requestId }, origin);
          }
          resolve();
        };
      });
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

    if (binaryProtocol === 'doubao') {
      await handleDoubao();
      return;
    }

    if (binaryProtocol === 'chatgpt') {
      await handleChatGPT();
      return;
    }

    if (binaryProtocol === 'rakuten') {
      await handleRakuten();
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
