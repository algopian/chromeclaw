/**
 * MAIN world content script for Doubao (www.doubao.com).
 *
 * Uses Samantha API with non-standard SSE format: each line is a JSON object
 * with `event_type` (number) and `event_data` (JSON string).
 * We reformat into standard SSE for the bridge's SSE parser and stream the
 * result back to the extension via window.postMessage().
 *
 * NOTE: This function is executed via chrome.scripting.executeScript({func}).
 * Chrome serializes ONLY the function body — module-scope imports and closures
 * are NOT captured. The function must be entirely self-contained.
 */

import type { ContentFetchRequest } from './content-fetch-main';

export const doubaoMainWorldFetch = async (request: ContentFetchRequest): Promise<void> => {
  const { requestId, init } = request;
  const origin = window.location.origin;

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
  const processSamanthaJson = (jsonStr: string): void => {
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
  };

  /** Process a single trimmed, non-empty line from the Samantha stream. */
  const processDoubaoLine = (line: string): void => {
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
  };

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
};
