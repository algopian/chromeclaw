/**
 * Rakuten AI MAIN world content script — extracted from content-fetch-main.ts.
 *
 * Injected via chrome.scripting.executeScript into the MAIN world of a
 * Rakuten AI tab. Uses WebSocket for real-time chat streaming, REST with
 * HMAC-SHA256 signing for thread management, and converts WebSocket messages
 * to SSE-compatible events.
 *
 * IMPORTANT: This function is serialized via chrome.scripting.executeScript({func}).
 * Chrome serializes ONLY the function body — module-scope imports and closures are
 * NOT captured. Everything must be self-contained within the function.
 */

import type { ContentFetchRequest } from './content-fetch-main';

export const rakutenMainWorldFetch = async (request: ContentFetchRequest): Promise<void> => {
  const { requestId, init } = request;
  const origin = window.location.origin;

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
  const cacheValid = cached && Date.now() - cached.ts < CACHE_TTL;

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
          try {
            XMLHttpRequest.prototype.setRequestHeader = origSetReqHeader;
          } catch {
            /* ignore */
          }
          try {
            window.fetch = origFetch;
          } catch {
            /* ignore */
          }
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
            if (
              headers &&
              typeof headers === 'object' &&
              !Array.isArray(headers) &&
              !(headers instanceof Headers)
            ) {
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
          } catch {
            /* ignore header extraction errors */
          }
          return origFetch.call(window, input, initArg);
        } as typeof window.fetch;

        // Trigger the SPA to make an API call so our hooks can capture headers.
        // The SPA refreshes thread list on focus/visibility events.
        try {
          window.dispatchEvent(new Event('focus'));
        } catch {
          /* ignore */
        }
        try {
          window.dispatchEvent(new Event('online'));
        } catch {
          /* ignore */
        }
        try {
          Object.defineProperty(document, 'hidden', { value: false, configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
        } catch {
          /* ignore */
        }
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
      } catch {
        /* ignore */
      }
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
      } catch {
        /* localStorage not accessible */
      }
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
      } catch {
        /* not JSON */
      }

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
        } catch {
          /* ignore */
        }
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
        try {
          const keys: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k) keys.push(k);
          }
          return keys;
        } catch {
          return [];
        }
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
        dbg('Anonymous auth response', {
          status: anonRes.status,
          body: anonText.slice(0, 400),
        });
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
          } catch {
            /* parse error */
          }
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
    bearer,
    deviceId,
    source: bearerSource,
    ts: Date.now(),
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
        const freshToken = await new Promise<string | null>(resolve => {
          const timeout = setTimeout(() => {
            try {
              document.body.removeChild(iframe);
            } catch {
              /* ignore */
            }
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
                try {
                  document.body.removeChild(iframe);
                } catch {
                  /* ignore */
                }
                resolve(at);
                return;
              }
            } catch {
              /* ignore */
            }
            if (checks > 40) {
              // 40 * 200ms = 8s
              clearInterval(poll);
              clearTimeout(timeout);
              try {
                document.body.removeChild(iframe);
              } catch {
                /* ignore */
              }
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
          bearer,
          deviceId,
          source: bearerSource,
          ts: Date.now(),
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
            bearer,
            deviceId,
            source: bearerSource,
            ts: Date.now(),
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
      dbg('WebSocket opened, sending message', {
        chatRequestType: thinkingLevel === 'thinking' ? 'DEEP_THINK' : 'USER_INPUT',
      });
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
        timezoneString: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles',
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
        if (
          status === 'DONE' ||
          status === 'COMPLETED' ||
          status === 'FAILED' ||
          status === 'CANCELLED'
        ) {
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
    ws.onerror = _ev => {
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
        tokenType: wsToken.startsWith('@St.')
          ? 'SSO'
          : wsToken.startsWith('at_')
            ? 'API'
            : 'unknown',
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
};
