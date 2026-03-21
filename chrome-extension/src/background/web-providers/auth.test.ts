/**
 * Tests for auth.ts — web provider authentication via chrome.cookies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebProviderDefinition } from './types';

// ── Mocks ──────────────────────────────────────

let credStore: Record<string, unknown> = {};

vi.mock('@extension/storage', () => ({
  webCredentialsStorage: {
    get: vi.fn(async () => credStore),
    set: vi.fn(async (val: Record<string, unknown>) => { credStore = val; }),
  },
}));

vi.mock('../logging/logger-buffer', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  }),
}));

vi.stubGlobal('chrome', {
  cookies: {
    getAll: vi.fn(async () => []),
  },
  tabs: {
    create: vi.fn(async () => ({ id: 42 })),
    remove: vi.fn(async () => {}),
    get: vi.fn(async () => ({ id: 42 })),
  },
});

import { checkWebAuth, getWebCredential, clearWebCredential } from './auth';
import { webCredentialsStorage } from '@extension/storage';

// ── Test Provider ──────────────────────────────

const testProvider: WebProviderDefinition = {
  id: 'claude-web',
  name: 'Claude Web',
  loginUrl: 'https://claude.ai',
  cookieDomain: '.claude.ai',
  sessionIndicators: ['sessionKey'],
  defaultModelId: 'claude-sonnet-4-5-20250929',
  defaultModelName: 'Claude Sonnet 4.5',
  supportsTools: true,
  supportsReasoning: true,
  contextWindow: 200_000,
  buildRequest: () => ({ url: '', init: {} }),
  parseSseDelta: () => null,
};

// ── Tests ──────────────────────────────────────

describe('checkWebAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credStore = {};
  });

  it('returns not-logged-in when no session cookies exist', async () => {
    vi.mocked(chrome.cookies.getAll).mockResolvedValueOnce([]);
    const status = await checkWebAuth(testProvider);
    expect(status).toBe('not-logged-in');
  });

  it('returns logged-in when session cookie exists', async () => {
    vi.mocked(chrome.cookies.getAll).mockResolvedValueOnce([
      { name: 'sessionKey', value: 'sk-ant-sid-test' },
    ] as any);
    const status = await checkWebAuth(testProvider);
    expect(status).toBe('logged-in');
  });

  it('returns expired when credential has expired', async () => {
    vi.mocked(chrome.cookies.getAll).mockResolvedValueOnce([
      { name: 'sessionKey', value: 'sk-ant-sid-test' },
    ] as any);
    credStore = {
      'claude-web': {
        providerId: 'claude-web',
        cookies: {},
        expiresAt: Date.now() - 1000,
        capturedAt: Date.now() - 100_000,
      },
    };
    const status = await checkWebAuth(testProvider);
    expect(status).toBe('expired');
  });

  it('returns not-logged-in when chrome.cookies throws', async () => {
    vi.mocked(chrome.cookies.getAll).mockRejectedValueOnce(new Error('Permission denied'));
    const status = await checkWebAuth(testProvider);
    expect(status).toBe('not-logged-in');
  });

  it('checks correct cookie domain', async () => {
    vi.mocked(chrome.cookies.getAll).mockResolvedValueOnce([]);
    await checkWebAuth(testProvider);
    expect(chrome.cookies.getAll).toHaveBeenCalledWith({ domain: '.claude.ai' });
  });
});

describe('getWebCredential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credStore = {};
  });

  it('returns null when no credential exists', async () => {
    const result = await getWebCredential('claude-web');
    expect(result).toBeNull();
  });

  it('returns credential when it exists', async () => {
    credStore = {
      'claude-web': {
        providerId: 'claude-web',
        cookies: { sessionKey: 'test' },
        capturedAt: 12345,
      },
    };
    const result = await getWebCredential('claude-web');
    expect(result).toBeDefined();
    expect(result!.providerId).toBe('claude-web');
  });
});

describe('clearWebCredential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credStore = {
      'claude-web': { providerId: 'claude-web', cookies: {}, capturedAt: Date.now() },
    };
  });

  it('removes credential from storage', async () => {
    await clearWebCredential('claude-web');
    expect(webCredentialsStorage.set).toHaveBeenCalledWith({});
  });
});
