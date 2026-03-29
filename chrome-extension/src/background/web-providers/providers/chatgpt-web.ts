/**
 * ChatGPT (chatgpt.com) — web provider using Sentinel antibot challenges.
 *
 * Uses binaryProtocol: 'chatgpt' to trigger MAIN world request building
 * (same pattern as DeepSeek), since:
 * - Sentinel challenge must be solved in-page (dynamic import of oaistatic scripts)
 * - Access token fetched from /api/auth/session with session cookies
 * - Special per-request headers (oai-device-id, sentinel tokens, etc.)
 *
 * The lightweight stub body ({ prompt, chatId }) is parsed by the MAIN world
 * handler in content-fetch-main.ts, which builds the real API request.
 */

import type { WebProviderDefinition } from '../types';

const chatgptWeb: WebProviderDefinition = {
  id: 'chatgpt-web',
  name: 'ChatGPT (Web)',
  loginUrl: 'https://chatgpt.com',
  cookieDomain: '.chatgpt.com',
  // ChatGPT uses __Secure-next-auth.session-token (may be split into .0 / .1)
  sessionIndicators: ['__Secure-next-auth.session-token', '__Secure-next-auth.session-token.0'],
  defaultModelId: 'auto',
  defaultModelName: 'ChatGPT',
  supportsTools: true,
  supportsReasoning: true,
  contextWindow: 128_000,
  refreshAuth: async ({ tabId }) => {
    // ChatGPT stores its access token in the session endpoint.
    // Fetch it from /api/auth/session in the MAIN world (needs session cookies).
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        try {
          const res = await fetch('https://chatgpt.com/api/auth/session', {
            credentials: 'include',
          });
          if (!res.ok) return null;
          const data = (await res.json()) as Record<string, unknown>;
          const accessToken = data.accessToken as string | undefined;
          return accessToken || null;
        } catch {
          return null;
        }
      },
    });
    const token = results?.[0]?.result as string | null;
    return token ? { token } : null;
  },
  buildRequest: opts => {
    // Strategy builds the full prompt in opts.messages[0].content
    const prompt = opts.messages[0]?.content ?? '';
    const chatId = opts.conversationId;

    return {
      url: 'https://chatgpt.com/backend-api/conversation',
      binaryProtocol: 'chatgpt',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Lightweight body — real request is built in MAIN world (content-fetch-main.ts)
        body: JSON.stringify({ prompt, chatId }),
        credentials: 'include' as RequestCredentials,
      },
    };
  },
  parseSseDelta: () => null, // Handled by chatgpt stream adapter
};

export { chatgptWeb };
