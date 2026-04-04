/**
 * MAIN world content script for GLM International (chat.z.ai).
 *
 * Requires localStorage JWT, browser fingerprint telemetry, and X-Signature
 * (HMAC-SHA256 with derived key). Creates chat sessions dynamically and
 * streams SSE response back to the extension via window.postMessage().
 *
 * NOTE: This function is executed via chrome.scripting.executeScript({func}).
 * Chrome serializes ONLY the function body — module-scope imports and closures
 * are NOT captured. The function must be entirely self-contained.
 */

import type { ContentFetchRequest } from './content-fetch-main';

export const glmIntlMainWorldFetch = async (request: ContentFetchRequest): Promise<void> => {
  const { requestId, init } = request;
  const origin = window.location.origin;

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
};
