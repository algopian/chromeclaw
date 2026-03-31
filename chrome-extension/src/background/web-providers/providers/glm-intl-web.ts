/**
 * GLM International (chat.z.ai) — SvelteKit-based provider.
 *
 * chat.z.ai is completely different from chatglm.cn:
 * - Endpoint: /api/v2/chat/completions (NOT /chatglm/backend-api/assistant/stream)
 * - Auth: JWT in localStorage (NOT cookie-based)
 * - Signing: HMAC-SHA256 X-Signature (NOT MD5 X-Sign)
 * - SSE: incremental delta_content with phase field (NOT cumulative parts)
 * - Requires browser fingerprint telemetry as query params
 *
 * Uses binaryProtocol: 'glm-intl' to trigger MAIN world request building
 * (like Gemini), since the X-Signature requires the page's obfuscated
 * HMAC key and telemetry params require browser globals.
 */

import type { WebProviderDefinition } from '../types';

const glmIntlWeb: WebProviderDefinition = {
  id: 'glm-intl-web',
  name: 'GLM Intl (Web)',
  loginUrl: 'https://chat.z.ai',
  cookieDomain: '.z.ai',
  // z.ai stores auth in localStorage, not cookies. Use analytics cookies
  // that are always present to detect that the user has visited the site.
  sessionIndicators: ['_ga', '_gcl_au'],
  defaultModelId: 'GLM-5-Turbo',
  defaultModelName: 'GLM-5-Turbo',
  supportsTools: true,
  supportsReasoning: true,
  contextWindow: 128_000,
  refreshAuth: async ({ tabId }) => {
    // Extract JWT from localStorage (only accessible in MAIN world)
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => localStorage.getItem('token'),
    });
    const token = results?.[0]?.result as string | null;
    return token ? { token } : null;
  },
  buildRequest: opts => {
    // Strategy builds the full prompt in opts.messages[0].content
    const prompt = opts.messages[0]?.content ?? '';
    const chatId = opts.conversationId;

    return {
      url: 'https://chat.z.ai/api/v2/chat/completions',
      binaryProtocol: 'glm-intl',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Lightweight body — real request is built in MAIN world (content-fetch-main.ts)
        body: JSON.stringify({ prompt, chatId, model: glmIntlWeb.defaultModelId, thinkingLevel: opts.thinkingLevel }),
        credentials: 'include' as RequestCredentials,
      },
    };
  },
  parseSseDelta: data => {
    // SSE format: {"type":"chat:completion","data":{"delta_content":"...","phase":"thinking"|"answer"|"other"}}
    const obj = data as Record<string, unknown>;
    if (obj.type !== 'chat:completion') return null;
    const d = obj.data as Record<string, unknown> | undefined;
    return (d?.delta_content as string) ?? null;
  },
};

export { glmIntlWeb };
