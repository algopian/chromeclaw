/**
 * Rakuten AI (ai.rakuten.co.jp) — web provider using WebSocket streaming.
 *
 * Uses binaryProtocol: 'rakuten' to trigger MAIN world WebSocket handling
 * (similar to DeepSeek/Doubao pattern), since:
 * - HMAC-SHA256 request signing requires crypto.subtle in page context
 * - Bearer token needs MAIN world access (localStorage)
 * - Thread creation via REST API with signed headers
 * - WebSocket connection with signed URL for streaming
 *
 * The lightweight stub body ({ prompt, chatId, thinkingLevel }) is parsed by
 * the MAIN world handler in content-fetch-main.ts, which builds the real
 * WebSocket connection and thread management requests.
 *
 * Thinking levels:
 * - 'fast'     → chatRequestType: "USER_INPUT" (TEXT only)
 * - 'thinking' → chatRequestType: "DEEP_THINK" (SUMMARY_TEXT + TEXT)
 */

import type { WebProviderDefinition } from '../types';

const rakutenWeb: WebProviderDefinition = {
  id: 'rakuten-web',
  name: 'Rakuten AI (Web)',
  loginUrl: 'https://ai.rakuten.co.jp',
  cookieDomain: '.rakuten.co.jp',
  sessionIndicators: ['Rp', 'Rz'],
  defaultModelId: 'rakuten-ai',
  defaultModelName: 'Rakuten AI',
  supportsTools: false, // Rakuten's model doesn't follow external tool-call XML; uses built-in native tools (e.g. web search)
  supportsReasoning: true,
  contextWindow: 32_000,
  refreshAuth: async ({ tabId }) => {
    // Rakuten AI stores its bearer token in localStorage with an @St. prefix.
    // All API calls (including anonymous auth) require HMAC-SHA256 signing.
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const HMAC_KEY = '4f0465bfea7761a510dda451ff86a935bf0c8ed6fb37f80441509c64328788c8';
        const hmacSign = async (message: string, key: string): Promise<string> => {
          const enc = new TextEncoder();
          const ck = await crypto.subtle.importKey(
            'raw',
            enc.encode(key),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
          );
          const sig = await crypto.subtle.sign('HMAC', ck, enc.encode(message));
          const bytes = new Uint8Array(sig);
          return btoa(Array.from(bytes, c => String.fromCharCode(c)).join(''))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
        };
        const signHeaders = async (
          method: string,
          apiUrl: string,
        ): Promise<Record<string, string>> => {
          const u = new URL(apiUrl);
          const ts = Math.floor(Date.now() / 1000).toString();
          const nonce = crypto.randomUUID();
          const params: Record<string, string> = {};
          u.searchParams.forEach((v, k) => {
            params[k] = v;
          });
          const sorted = Object.keys(params)
            .sort()
            .map(k => `${k}=${params[k]}`)
            .join('');
          const sig = await hmacSign(`${method}${u.pathname}${sorted}${ts}${nonce}`, HMAC_KEY);
          return { 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': sig };
        };

        // 1. Try the accessToken key directly
        let bearer = '';
        try {
          const at = localStorage.getItem('accessToken');
          if (at && at.startsWith('@St.')) bearer = at;
        } catch {
          /* ignore */
        }

        // 2. Scan localStorage for @St. prefix tokens
        if (!bearer) {
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (!key) continue;
              const val = localStorage.getItem(key);
              if (!val) continue;
              if (val.startsWith('@St.')) {
                bearer = val;
                break;
              }
              try {
                const parsed = JSON.parse(val);
                if (typeof parsed === 'string' && parsed.startsWith('@St.')) {
                  bearer = parsed;
                  break;
                }
                if (typeof parsed === 'object' && parsed !== null) {
                  const tok = parsed.accessToken ?? parsed.token ?? parsed.access_token ?? '';
                  if (typeof tok === 'string' && tok.startsWith('@St.')) {
                    bearer = tok;
                    break;
                  }
                }
              } catch {
                /* not JSON */
              }
            }
          } catch {
            /* localStorage not accessible */
          }
        }

        // 3. Try refreshing the token
        if (!bearer) {
          try {
            const rt = localStorage.getItem('refreshToken');
            if (rt && rt.length > 10) {
              const refreshUrl = 'https://ai.rakuten.co.jp/api/v2/auth/refresh';
              const sig = await signHeaders('POST', refreshUrl);
              const res = await fetch(refreshUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...sig },
                body: JSON.stringify({ refreshToken: rt }),
                credentials: 'include',
              });
              if (res.ok) {
                const data = (await res.json()) as Record<string, unknown>;
                if (data.code === '0') {
                  const inner = data.data as Record<string, string> | undefined;
                  if (inner?.accessToken) {
                    bearer = inner.accessToken;
                    try {
                      localStorage.setItem('accessToken', bearer);
                      if (inner.refreshToken) localStorage.setItem('refreshToken', inner.refreshToken);
                    } catch {
                      /* ignore */
                    }
                  }
                }
              }
            }
          } catch {
            /* ignore */
          }
        }

        // 4. Fallback: anonymous auth (also requires HMAC signing)
        if (!bearer) {
          try {
            const anonUrl = 'https://ai.rakuten.co.jp/api/v2/auth/anonymous';
            const sig = await signHeaders('GET', anonUrl);
            const res = await fetch(anonUrl, {
              headers: { Accept: 'application/json, text/plain, */*', ...sig },
              credentials: 'include',
            });
            if (res.ok) {
              const data = (await res.json()) as Record<string, unknown>;
              if (data.code === '0') {
                const inner = data.data as Record<string, string> | undefined;
                if (inner?.accessToken) bearer = inner.accessToken;
              }
            }
          } catch {
            /* ignore */
          }
        }

        return bearer || null;
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
      url: 'https://ai.rakuten.co.jp/api/v1/thread',
      binaryProtocol: 'rakuten',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Lightweight body — real request is built in MAIN world (content-fetch-main.ts)
        body: JSON.stringify({
          prompt,
          chatId,
          thinkingLevel: opts.thinkingLevel ?? 'fast',
        }),
        credentials: 'include' as RequestCredentials,
      },
    };
  },
  parseSseDelta: () => null, // Handled by rakuten stream adapter
};

export { rakutenWeb };
