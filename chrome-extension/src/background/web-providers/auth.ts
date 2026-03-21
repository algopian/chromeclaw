/**
 * Web provider authentication — uses chrome.cookies to capture browser sessions.
 * Replaces zero-token's Playwright-based auth with native Chrome extension APIs.
 */

import { createLogger } from '../logging/logger-buffer';
import { webCredentialsStorage } from '@extension/storage';
import type { WebProviderDefinition, WebAuthStatus } from './types';
import type { WebProviderCredential } from '@extension/storage';

const authLog = createLogger('web-auth');

/** Poll interval for checking session cookies after login tab opens. */
const POLL_INTERVAL_MS = 2_000;
/** Max time to wait for login completion. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Check whether the user is logged into a web provider by reading cookies.
 */
const checkWebAuth = async (provider: WebProviderDefinition): Promise<WebAuthStatus> => {
  try {
    const cookies = await chrome.cookies.getAll({ domain: provider.cookieDomain });
    const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
    const hasSession = provider.sessionIndicators.some(name => !!cookieMap[name]);

    if (!hasSession) return 'not-logged-in';

    // Check if stored credential is expired
    const stored = await getWebCredential(provider.id);
    if (stored?.expiresAt && stored.expiresAt < Date.now()) return 'expired';

    return 'logged-in';
  } catch (err) {
    authLog.error('Failed to check web auth', { provider: provider.id, error: String(err) });
    return 'not-logged-in';
  }
};

/**
 * Open a login tab for the provider and poll for session cookies.
 * Resolves when session is detected or rejects on timeout.
 */
const initiateWebLogin = async (
  provider: WebProviderDefinition,
): Promise<WebProviderCredential> => {
  authLog.info('Initiating web login', { provider: provider.id, url: provider.loginUrl });

  const tab = await chrome.tabs.create({ url: provider.loginUrl, active: true });
  const tabId = tab.id!;

  return new Promise<WebProviderCredential>((resolve, reject) => {
    const startTime = Date.now();
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout>;

    const stop = () => {
      stopped = true;
      clearTimeout(pollTimer);
    };

    const poll = async () => {
      if (stopped) return;

      // Check timeout
      if (Date.now() - startTime > LOGIN_TIMEOUT_MS) {
        stop();
        try {
          await chrome.tabs.remove(tabId);
        } catch {
          /* tab may already be closed */
        }
        reject(new Error(`Login timed out after ${LOGIN_TIMEOUT_MS / 1000}s for ${provider.id}`));
        return;
      }

      // Check if tab was closed by user
      try {
        await chrome.tabs.get(tabId);
      } catch {
        stop();
        reject(new Error(`Login tab was closed before session was detected for ${provider.id}`));
        return;
      }

      try {
        const cookies = await chrome.cookies.getAll({ domain: provider.cookieDomain });
        const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
        const hasSession = provider.sessionIndicators.some(name => !!cookieMap[name]);

        if (hasSession) {
          stop();

          // Only store session-relevant cookies, not the entire cookie jar
          const sessionCookies: Record<string, string> = {};
          for (const name of provider.sessionIndicators) {
            if (cookieMap[name]) sessionCookies[name] = cookieMap[name];
          }
          // Also capture common auth-related cookies that providers may need
          for (const name of ['lastActiveOrg', 'XSRF-TOKEN', 'csrf_token']) {
            if (cookieMap[name]) sessionCookies[name] = cookieMap[name];
          }

          // Provider-specific auth refresh (e.g., GLM token exchange)
          if (provider.refreshAuth) {
            try {
              const extra = await provider.refreshAuth({ tabId, cookies: sessionCookies });
              if (extra) {
                Object.assign(sessionCookies, extra);
                authLog.info('Auth refreshed during login', { provider: provider.id });
              }
            } catch (err) {
              authLog.warn('Auth refresh failed during login', {
                provider: provider.id,
                error: String(err),
              });
            }
          }

          const credential: WebProviderCredential = {
            providerId: provider.id,
            cookies: sessionCookies,
            capturedAt: Date.now(),
          };

          await storeWebCredential(credential);

          try {
            await chrome.tabs.remove(tabId);
          } catch {
            /* tab may already be closed */
          }

          authLog.info('Web login successful', { provider: provider.id });
          resolve(credential);
          return;
        }
      } catch (err) {
        authLog.warn('Error polling cookies', { provider: provider.id, error: String(err) });
      }

      // Schedule next poll (sequential — avoids overlapping async calls)
      if (!stopped) {
        pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    // Run first check immediately
    poll();
  });
};

/**
 * Get stored credential for a provider.
 */
const getWebCredential = async (providerId: string): Promise<WebProviderCredential | null> => {
  const credentials = await webCredentialsStorage.get();
  return credentials[providerId] ?? null;
};

/**
 * Store a credential for a provider.
 */
const storeWebCredential = async (credential: WebProviderCredential): Promise<void> => {
  const credentials = await webCredentialsStorage.get();
  credentials[credential.providerId] = credential;
  await webCredentialsStorage.set(credentials);
};

/**
 * Clear stored credential for a provider.
 */
const clearWebCredential = async (providerId: string): Promise<void> => {
  const credentials = await webCredentialsStorage.get();
  delete credentials[providerId];
  await webCredentialsStorage.set(credentials);
  authLog.info('Web credential cleared', { provider: providerId });
};

/**
 * Test connection for a web provider by verifying auth status and stored credentials.
 */
const testWebConnection = async (
  webProviderId: string | undefined,
): Promise<{ success: true } | { error: string }> => {
  if (!webProviderId) return { error: 'Web provider ID is required' };

  const { getWebProvider } = await import('./registry');
  const provider = getWebProvider(webProviderId as import('./types').WebProviderId);
  if (!provider) return { error: `Unknown web provider: ${webProviderId}` };

  const status = await checkWebAuth(provider);
  if (status !== 'logged-in') {
    return { error: `Not logged in to ${provider.name}. Please log in first.` };
  }
  const credential = await getWebCredential(webProviderId);
  if (!credential) {
    return { error: `No stored credentials for ${provider.name}. Please log in first.` };
  }
  return { success: true };
};

export { checkWebAuth, initiateWebLogin, getWebCredential, storeWebCredential, clearWebCredential, testWebConnection };
