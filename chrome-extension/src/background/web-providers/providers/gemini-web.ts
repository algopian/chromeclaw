import type { WebProviderDefinition } from '../types';

/**
 * Gemini web provider — uses Google's internal BardFrontendService API.
 *
 * Key differences from other providers:
 * - Request body is URL-encoded form data (`f.req` + `at`), not JSON.
 * - Response uses length-prefixed JSON chunks, not SSE.
 * - Session state (`f.sid`, `at`, `bl`) extracted from page JS globals.
 * - Text in response is cumulative (like GLM) — stream adapter computes deltas.
 *
 * The MAIN world script (content-fetch-main.ts) extracts page state and
 * builds the request body, since `WIZ_global_data` is only accessible
 * from the page context. The provider's `buildRequest` returns a
 * `gemini-chunks` binary protocol marker so the bridge uses the correct parser.
 */

const geminiWeb: WebProviderDefinition = {
  id: 'gemini-web',
  name: 'Gemini (Web)',
  loginUrl: 'https://gemini.google.com',
  cookieDomain: '.google.com',
  sessionIndicators: ['__Secure-1PSID', 'SID'],
  defaultModelId: 'gemini-3-flash',
  defaultModelName: 'Gemini 3 Flash',
  supportsTools: true,
  supportsReasoning: true,
  contextWindow: 1_000_000,
  buildRequest: opts => {
    // geminiToolStrategy.buildPrompt aggregates all history into a single user message
    const prompt = opts.messages[0]?.content ?? '';

    return {
      url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
      binaryProtocol: 'gemini-chunks' as 'connect-json',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: JSON.stringify({ prompt }),
        credentials: 'include' as RequestCredentials,
      },
    };
  },
  parseSseDelta: data => {
    // The stream adapter handles cumulative text deduplication — this just extracts
    // the raw cumulative text from the deeply nested response structure.
    // Outer: [["wrb.fr", null, "<inner_json>"]]
    // Inner[4][0][1] = text segments array
    try {
      const arr = data as unknown[];
      if (!Array.isArray(arr) || !arr[0] || !Array.isArray(arr[0])) return null;
      const inner = arr[0][2];
      if (typeof inner !== 'string') return null;
      const parsed = JSON.parse(inner);
      const candidates = parsed?.[4];
      if (!Array.isArray(candidates) || candidates.length === 0) return null;
      const firstCandidate = candidates[0];
      if (!Array.isArray(firstCandidate)) return null;
      const textArr = firstCandidate[1];
      if (Array.isArray(textArr) && textArr.length > 0) {
        return textArr.join('');
      }
      return null;
    } catch {
      return null;
    }
  },
};

export { geminiWeb };
