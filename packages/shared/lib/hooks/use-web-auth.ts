/**
 * Auth-only React hook for web providers (both LLM and speech).
 *
 * Extracted from `use-web-provider-auth.ts` so the STT config panel can
 * drive login/logout/status from a minimal `WebAuthDefinition` subset
 * without needing the full LLM `WebProviderDefinition` (which carries
 * `buildRequest`/`parseSseDelta` etc.).
 *
 * The LLM hook can delegate to this for its auth logic if desired,
 * but today both are independent — no behavior change to LLM callers.
 */

import { webCredentialsStorage } from '@extension/storage';
import { useCallback, useEffect, useState } from 'react';

export type SpeechAuthStatus = 'not-logged-in' | 'checking' | 'logged-in' | 'expired';

export interface WebAuthDefinition {
  id: string;
  cookieDomain: string;
  sessionIndicators: string[];
  loginUrl: string;
}

export interface UseWebAuthOptions {
  definition: WebAuthDefinition | undefined;
  /** Changing this value triggers a re-check (e.g. pass dialogOpen). */
  recheckKey?: unknown;
}

export interface UseWebAuthReturn {
  status: SpeechAuthStatus;
  loginLoading: boolean;
  error: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useWebAuth = (opts: UseWebAuthOptions): UseWebAuthReturn => {
  const { definition, recheckKey } = opts;

  const [status, setStatus] = useState<SpeechAuthStatus>('not-logged-in');
  const [loginLoading, setLoginLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check auth status when definition changes or recheckKey triggers
  useEffect(() => {
    if (!definition) {
      setStatus('not-logged-in');
      setError(null);
      return;
    }

    let cancelled = false;
    const check = async () => {
      setStatus('checking');
      try {
        const cookies = await chrome.cookies.getAll({ domain: definition.cookieDomain });
        const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
        const hasSession = definition.sessionIndicators.some(name => !!cookieMap[name]);

        if (cancelled) return;

        if (hasSession) {
          // Check stored credential for expiry
          const creds = await webCredentialsStorage.get();
          const stored = creds[definition.id];
          if (stored?.expiresAt && stored.expiresAt < Date.now()) {
            setStatus('expired');
          } else {
            setStatus('logged-in');
          }
        } else {
          // Fall back to stored credentials
          const creds = await webCredentialsStorage.get();
          const stored = creds[definition.id];
          if (stored) {
            if (stored.expiresAt && stored.expiresAt < Date.now()) {
              setStatus('expired');
            } else {
              setStatus('logged-in');
            }
          } else {
            setStatus('not-logged-in');
          }
        }
      } catch {
        if (!cancelled) setStatus('not-logged-in');
      }
    };
    check();
    return () => {
      cancelled = true;
    };
  }, [definition, recheckKey]);

  const login = useCallback(async () => {
    if (!definition) return;

    setLoginLoading(true);
    setError(null);
    try {
      const tab = await chrome.tabs.create({ url: definition.loginUrl, active: true });
      const tabId = tab.id!;

      const MIN_WAIT_MS = 5_000;
      const startTime = Date.now();
      const TIMEOUT = 5 * 60 * 1000;
      const INTERVAL = 2000;

      const poll = async (): Promise<boolean> => {
        if (Date.now() - startTime > TIMEOUT) return false;
        try {
          await chrome.tabs.get(tabId);
        } catch {
          return false; // tab closed
        }

        if (Date.now() - startTime < MIN_WAIT_MS) {
          return new Promise(resolve => setTimeout(() => resolve(poll()), INTERVAL));
        }

        const cookies = await chrome.cookies.getAll({ domain: definition.cookieDomain });
        const cookieMap = Object.fromEntries(
          cookies.map((c: chrome.cookies.Cookie) => [c.name, c.value]),
        );
        const hasSession = definition.sessionIndicators.some((name: string) => !!cookieMap[name]);

        if (hasSession) {
          const sessionCookies: Record<string, string> = {};
          for (const name of definition.sessionIndicators) {
            if (cookieMap[name]) sessionCookies[name] = cookieMap[name];
          }

          const creds = await webCredentialsStorage.get();
          creds[definition.id] = {
            providerId: definition.id,
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
  }, [definition]);

  const logout = useCallback(async () => {
    if (!definition) return;
    const creds = await webCredentialsStorage.get();
    delete creds[definition.id];
    await webCredentialsStorage.set(creds);
    setStatus('not-logged-in');
  }, [definition]);

  return { status, loginLoading, error, login, logout };
};
