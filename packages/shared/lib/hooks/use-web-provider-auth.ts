import { useCallback, useEffect, useState } from 'react';
import { webCredentialsStorage } from '@extension/storage';
import { WEB_PROVIDER_OPTIONS } from '../chat-types.js';

export type WebAuthStatus = 'unknown' | 'checking' | 'logged-in' | 'not-logged-in';

export interface UseWebProviderAuthOptions {
  provider: string;
  webProviderId: string | undefined;
  /** Changing this value triggers a re-check of auth status (e.g. pass dialogOpen). */
  recheckKey?: unknown;
}

export interface UseWebProviderAuthReturn {
  status: WebAuthStatus;
  loginLoading: boolean;
  error: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

export function useWebProviderAuth(opts: UseWebProviderAuthOptions): UseWebProviderAuthReturn {
  const { provider, webProviderId, recheckKey } = opts;

  const [status, setStatus] = useState<WebAuthStatus>('unknown');
  const [loginLoading, setLoginLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check web auth status when provider or webProviderId changes
  useEffect(() => {
    if (provider !== 'web' || !webProviderId) {
      setStatus('unknown');
      return;
    }
    const wp = WEB_PROVIDER_OPTIONS.find(p => p.value === webProviderId);
    if (!wp) {
      setStatus('unknown');
      return;
    }

    setStatus('checking');
    (async () => {
      try {
        // Check stored credentials first
        const creds = await webCredentialsStorage.get();
        if (creds[webProviderId]) {
          setStatus('logged-in');
          return;
        }
        // Check cookies directly (skip for localStorage-based providers where
        // session indicators won't be in cookies — stored credentials above are
        // the canonical check for those).
        if ('checkLocalStorage' in wp && wp.checkLocalStorage) {
          setStatus('not-logged-in');
          return;
        }
        const cookies = await chrome.cookies.getAll({ domain: wp.cookieDomain });
        const cookieMap = Object.fromEntries(
          cookies.map((c: chrome.cookies.Cookie) => [c.name, c.value]),
        );
        const hasSession = wp.sessionIndicators.some((name: string) => !!cookieMap[name]);
        setStatus(hasSession ? 'logged-in' : 'not-logged-in');
      } catch {
        setStatus('not-logged-in');
      }
    })();
  }, [provider, webProviderId, recheckKey]);

  const login = useCallback(async () => {
    const wp = WEB_PROVIDER_OPTIONS.find(p => p.value === webProviderId);
    if (!wp) return;

    setLoginLoading(true);
    setError(null);
    try {
      const tab = await chrome.tabs.create({ url: wp.loginUrl, active: false });
      const tabId = tab.id!;

      // Poll for session cookies
      const startTime = Date.now();
      const TIMEOUT = 5 * 60 * 1000;
      const INTERVAL = 2000;

      const poll = async (): Promise<boolean> => {
        if (Date.now() - startTime > TIMEOUT) return false;
        try {
          await chrome.tabs.get(tabId);
        } catch {
          return false;
        }

        const cookies = await chrome.cookies.getAll({ domain: wp.cookieDomain });
        const cookieMap = Object.fromEntries(
          cookies.map((c: chrome.cookies.Cookie) => [c.name, c.value]),
        );
        let hasSession = wp.sessionIndicators.some((name: string) => !!cookieMap[name]);

        // Some providers (e.g., Kimi, GLM Intl) store tokens in localStorage instead of cookies.
        // Route through background service worker which can reliably access MAIN world localStorage.
        if (!hasSession && 'checkLocalStorage' in wp && wp.checkLocalStorage) {
          try {
            const response = await chrome.runtime.sendMessage({
              type: 'CHECK_LOCAL_STORAGE',
              tabId,
              keys: wp.sessionIndicators as unknown as string[],
            });
            const lsTokens = response?.tokens as Record<string, string> | null;
            if (lsTokens) {
              hasSession = true;
              Object.assign(cookieMap, lsTokens);
            }
          } catch {
            /* background may not be ready */
          }
        }

        if (hasSession) {
          // Store only session cookies + localStorage tokens
          const sessionCookies: Record<string, string> = {};
          for (const name of wp.sessionIndicators) {
            if (cookieMap[name]) sessionCookies[name] = cookieMap[name];
          }
          for (const name of ['lastActiveOrg', 'XSRF-TOKEN', 'csrf_token']) {
            if (cookieMap[name]) sessionCookies[name] = cookieMap[name];
          }

          // Provider-specific token refresh (e.g., GLM access token exchange)
          if ('refreshUrl' in wp && wp.refreshUrl) {
            const refreshToken =
              sessionCookies['chatglm_refresh_token'] || sessionCookies['refresh_token'];
            if (refreshToken && !sessionCookies['chatglm_token']) {
              try {
                const results = await chrome.scripting.executeScript({
                  target: { tabId },
                  func: async (refreshUrl: string, token: string) => {
                    try {
                      const res = await fetch(refreshUrl, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          Authorization: `Bearer ${token}`,
                          'App-Name': 'chatglm',
                          'X-App-Platform': 'pc',
                          'X-App-Version': '0.0.1',
                        },
                        body: JSON.stringify({}),
                        credentials: 'include',
                      });
                      if (!res.ok) return null;
                      const data = await res.json();
                      return (
                        data?.result?.access_token ??
                        data?.result?.accessToken ??
                        data?.accessToken ??
                        null
                      );
                    } catch {
                      return null;
                    }
                  },
                  args: [wp.refreshUrl, refreshToken],
                });
                const accessToken = results?.[0]?.result as string | null;
                if (accessToken) {
                  sessionCookies['chatglm_token'] = accessToken;
                }
              } catch {
                /* token refresh failed — will retry at request time */
              }
            }
          }

          const creds = await webCredentialsStorage.get();
          creds[wp.value] = {
            providerId: wp.value,
            cookies: sessionCookies,
            capturedAt: Date.now(),
          };
          await webCredentialsStorage.set(creds);
          try {
            await chrome.tabs.remove(tabId);
          } catch {
            /* ok */
          }
          return true;
        }
        return new Promise(resolve => setTimeout(() => resolve(poll()), INTERVAL));
      };

      const success = await poll();
      setStatus(success ? 'logged-in' : 'not-logged-in');
      if (!success) setError('Login timed out or tab was closed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setStatus('not-logged-in');
    } finally {
      setLoginLoading(false);
    }
  }, [webProviderId]);

  const logout = useCallback(async () => {
    if (!webProviderId) return;
    const creds = await webCredentialsStorage.get();
    delete creds[webProviderId];
    await webCredentialsStorage.set(creds);
    setStatus('not-logged-in');
  }, [webProviderId]);

  return { status, loginLoading, error, login, logout };
}
