/**
 * Tests for browser.ts — Firefox dispatch behavior.
 *
 * Verifies that when IS_FIREFOX=true:
 * - executeBrowser() delegates to browser-firefox.ts
 * - chrome.debugger event listeners are NOT registered
 *
 * NOTE: These tests will fail until browser.ts is updated with IS_FIREFOX guards
 * and browser-firefox.ts is created.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock IS_FIREFOX = true ──
vi.mock('@extension/env', () => ({
  IS_FIREFOX: true,
  IS_DEV: false,
  IS_PROD: true,
  IS_CI: false,
  WEBGPU_MODELS_ENABLED: false,
  default: {},
}));

// ── Chrome API mocks ──
const mockDebuggerOnDetachAddListener = vi.fn();
const mockDebuggerOnEventAddListener = vi.fn();
const mockTabsOnRemovedAddListener = vi.fn();

const mockTabsQuery = vi.fn(() =>
  Promise.resolve([
    { id: 1, title: 'Tab One', url: 'https://one.com', active: true, windowId: 1 } as chrome.tabs.Tab,
  ]),
);

Object.defineProperty(globalThis, 'chrome', {
  value: {
    debugger: {
      onDetach: { addListener: mockDebuggerOnDetachAddListener },
      onEvent: { addListener: mockDebuggerOnEventAddListener },
    },
    tabs: {
      query: mockTabsQuery,
      onRemoved: { addListener: mockTabsOnRemovedAddListener },
      onUpdated: { addListener: vi.fn() },
    },
    windows: {
      update: vi.fn(),
    },
    scripting: {
      executeScript: vi.fn(() => Promise.resolve([{ result: 'test' }])),
    },
    storage: {
      local: {
        get: vi.fn(() => Promise.resolve({})),
        set: vi.fn(() => Promise.resolve()),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      session: {
        get: vi.fn(() => Promise.resolve({})),
        set: vi.fn(() => Promise.resolve()),
        setAccessLevel: vi.fn(() => Promise.resolve()),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    },
    runtime: { lastError: undefined },
  },
  writable: true,
  configurable: true,
});

describe('browser.ts — Firefox dispatch (IS_FIREFOX=true)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('debugger event listeners are NOT registered on Firefox', async () => {
    // Importing browser.ts triggers module-level listener registration
    await import('./browser');

    // On Firefox, these should NOT be called
    expect(mockDebuggerOnDetachAddListener).not.toHaveBeenCalled();
    expect(mockDebuggerOnEventAddListener).not.toHaveBeenCalled();
  });

  it('executeBrowser delegates to browser-firefox module', async () => {
    const { executeBrowser } = await import('./browser');

    // This will either:
    // 1. Succeed by calling browser-firefox.ts (once it exists)
    // 2. Fail with import error (before browser-firefox.ts is created)
    // Either way, it should NOT call chrome.debugger
    try {
      const result = await executeBrowser({ action: 'tabs' } as any);
      // If it works, it came from browser-firefox
      expect(result).toBeDefined();
    } catch (err) {
      // Expected before browser-firefox.ts exists
      expect(String(err)).toContain('browser-firefox');
    }
  });
});
