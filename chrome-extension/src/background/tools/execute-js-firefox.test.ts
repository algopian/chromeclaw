/**
 * Tests for execute-js-firefox.ts — Firefox executeCode via chrome.scripting.executeScript.
 *
 * Mirrors structure of execute-js.test.ts but mocks chrome.scripting.executeScript
 * instead of chrome.debugger.
 */

// eslint-disable-next-line import-x/order -- vitest must be imported first for vi.mock hoisting
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Chrome API mocks — must be set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

const SANDBOX_TAB_ID = 999;

// In Node.js, `window` is not defined but the console capture code uses it.
(globalThis as any).window = globalThis;

/**
 * executeScript mock: takes the `func` from the call, runs it locally with
 * `args`, and wraps the return value in the `[{ result }]` shape that
 * chrome.scripting.executeScript returns.
 */
const mockExecuteScript = vi.fn(
  async (injection: {
    target: { tabId: number };
    world: string;
    func: (...a: unknown[]) => Promise<unknown>;
    args: unknown[];
  }) => {
    const result = await injection.func(...injection.args);
    return [{ result }];
  },
);

const mockTabsCreate = vi.fn(() => Promise.resolve({ id: SANDBOX_TAB_ID } as chrome.tabs.Tab));
const mockTabsGet = vi.fn(() => Promise.resolve({ id: SANDBOX_TAB_ID } as chrome.tabs.Tab));
const mockTabsQuery = vi.fn(() => Promise.resolve([] as chrome.tabs.Tab[]));

const tabsOnRemovedListeners: Array<(tabId: number) => void> = [];

Object.defineProperty(globalThis, 'chrome', {
  value: {
    tabs: {
      create: mockTabsCreate,
      get: mockTabsGet,
      query: mockTabsQuery,
      onRemoved: {
        addListener: (fn: (tabId: number) => void) => {
          tabsOnRemovedListeners.push(fn);
        },
      },
    },
    scripting: {
      executeScript: mockExecuteScript,
    },
    runtime: {
      getURL: (path: string) => `moz-extension://test-id/${path}`,
    },
  },
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Now import the module under test (after chrome mocks are set up)
// ---------------------------------------------------------------------------

/* eslint-disable import-x/first -- imports must come after chrome mock setup */
import { executeCodeFirefox, _resetSandboxFirefox } from './execute-js-firefox';
/* eslint-enable import-x/first */

beforeEach(() => {
  _resetSandboxFirefox();
  vi.clearAllMocks();

  // Clean up globals set by console capture and module registry
  delete (globalThis as any).__cc;
  delete (globalThis as any).__cl;
  delete (globalThis as any).__modules;
});

// ── executeCodeFirefox ──────────────────────────

describe('executeCodeFirefox', () => {
  it('executes simple JS and returns result', async () => {
    const result = await executeCodeFirefox('return 2 + 2');
    expect(result).toBe('4');
  });

  it('handles string results directly', async () => {
    const result = await executeCodeFirefox('return "hello world"');
    expect(result).toBe('hello world');
  });

  it('serializes objects to JSON', async () => {
    const result = await executeCodeFirefox('return { a: 1, b: "two" }');
    expect(JSON.parse(result)).toEqual({ a: 1, b: 'two' });
  });

  it('executes async code', async () => {
    const result = await executeCodeFirefox(
      'const p = new Promise(r => setTimeout(() => r(42), 10)); return await p;',
    );
    expect(result).toBe('42');
  });

  it('passes arguments correctly', async () => {
    const result = await executeCodeFirefox('return args.x + args.y', { x: 10, y: 20 });
    expect(result).toBe('30');
  });

  it('handles undefined return (no return statement)', async () => {
    const result = await executeCodeFirefox('const x = 1;');
    expect(result).toBe('undefined');
  });

  it('handles null return', async () => {
    const result = await executeCodeFirefox('return null');
    expect(result).toBe('null');
  });

  it('returns error message on exception', async () => {
    await expect(executeCodeFirefox('throw new Error("boom")')).rejects.toThrow('boom');
  });

  it('args variable is available even with no args passed', async () => {
    const result = await executeCodeFirefox('return typeof args');
    expect(result).toBe('object');
  });

  it('args is empty object when no args passed', async () => {
    const result = await executeCodeFirefox('return JSON.stringify(args)');
    expect(result).toBe('{}');
  });
});

// ── Sandbox tab lifecycle ───────────────────────

describe('sandbox tab lifecycle', () => {
  it('creates sandbox tab on first call', async () => {
    await executeCodeFirefox('return 1');
    expect(mockTabsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com', active: false }),
    );
  });

  it('reuses sandbox tab on subsequent calls', async () => {
    await executeCodeFirefox('return 1');
    await executeCodeFirefox('return 2');
    // Only one tab.create call
    expect(mockTabsCreate).toHaveBeenCalledTimes(1);
  });

  it('creates new sandbox tab if previous one was closed', async () => {
    await executeCodeFirefox('return 1');
    expect(mockTabsCreate).toHaveBeenCalledTimes(1);

    // Simulate tab closed: tabs.get rejects once, then succeeds
    mockTabsGet.mockRejectedValueOnce(new Error('No tab with id'));

    await executeCodeFirefox('return 3');
    expect(mockTabsCreate).toHaveBeenCalledTimes(2);
  });

  it('reuses orphan sandbox tab from previous SW lifecycle', async () => {
    const ORPHAN_TAB_ID = 777;
    // Return an existing sandbox tab from tabs.query
    mockTabsQuery.mockResolvedValueOnce([{ id: ORPHAN_TAB_ID } as chrome.tabs.Tab]);

    await executeCodeFirefox('return 42');

    // Should NOT have called tabs.create since it reused the orphan
    expect(mockTabsCreate).not.toHaveBeenCalled();
    // Should have executed on the orphan tab
    expect(mockExecuteScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: ORPHAN_TAB_ID } }),
    );
  });
});

// ── Console capture ─────────────────────────────

describe('console capture', () => {
  it('captures console.log output', async () => {
    const result = await executeCodeFirefox('console.log("hello"); return 42');
    expect(result).toContain('42');
    expect(result).toContain('Console Output');
    expect(result).toContain('hello');
  });

  it('captures console.warn and console.error', async () => {
    const result = await executeCodeFirefox(
      'console.warn("a warning"); console.error("an error"); return "ok"',
    );
    expect(result).toContain('ok');
    expect(result).toContain('[WARN] a warning');
    expect(result).toContain('[ERROR] an error');
  });

  it('includes console output in error messages', async () => {
    await expect(
      executeCodeFirefox('console.log("step 1"); throw new Error("boom")'),
    ).rejects.toThrow(/boom[\s\S]*step 1/);
  });

  it('returns clean output when no console calls', async () => {
    const result = await executeCodeFirefox('return "clean"');
    expect(result).toBe('clean');
    expect(result).not.toContain('Console Output');
  });
});

// ── Timeout ─────────────────────────────────────

describe('timeout', () => {
  it('passes effectiveTimeout to injected function', async () => {
    await executeCodeFirefox('return 42', undefined, 60000);
    // The third arg passed to the injected function should be the timeout
    const call = mockExecuteScript.mock.calls[0][0];
    expect(call.args[2]).toBe(60000);
  });

  it('clamps timeout exceeding max to 300000', async () => {
    await executeCodeFirefox('return 1', undefined, 999999);
    const call = mockExecuteScript.mock.calls[0][0];
    expect(call.args[2]).toBe(300000);
  });

  it('uses default timeout when not specified', async () => {
    await executeCodeFirefox('return 1');
    const call = mockExecuteScript.mock.calls[0][0];
    expect(call.args[2]).toBe(30000);
  });

  it('clamps timeout below minimum to 1000', async () => {
    await executeCodeFirefox('return 1', undefined, 100);
    const call = mockExecuteScript.mock.calls[0][0];
    expect(call.args[2]).toBe(1000);
  });
});

// ── Module registry (exportAs) ──────────────────

describe('module registry (exportAs)', () => {
  it('stores return value on window.__modules', async () => {
    await executeCodeFirefox('return { foo: 42 }', undefined, undefined, undefined, 'testMod');
    const result = await executeCodeFirefox('return window.__modules.testMod.foo');
    expect(result).toContain('42');
  });

  it('subsequent executions can read exported modules', async () => {
    await executeCodeFirefox('return { add: "fn" }', undefined, undefined, undefined, 'math');
    const result = await executeCodeFirefox('return typeof window.__modules.math');
    expect(result).toContain('object');
  });
});

// ── Target tab (tabId) ──────────────────────────

describe('target tab (tabId)', () => {
  const TARGET_TAB_ID = 42;

  it('uses specified tab instead of sandbox', async () => {
    mockTabsGet.mockResolvedValueOnce({ id: TARGET_TAB_ID } as chrome.tabs.Tab);

    await executeCodeFirefox('return "in-tab"', undefined, undefined, TARGET_TAB_ID);

    // Should have executed on the target tab
    expect(mockExecuteScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: TARGET_TAB_ID } }),
    );
    // Should NOT have created a sandbox tab
    expect(mockTabsCreate).not.toHaveBeenCalled();
  });

  it('throws error when tab not found', async () => {
    mockTabsGet.mockRejectedValueOnce(new Error('No tab with id'));

    await expect(
      executeCodeFirefox('return 1', undefined, undefined, 12345),
    ).rejects.toThrow('Tab 12345 not found');
  });
});

// ── executeScript returns no result ─────────────

describe('edge cases', () => {
  it('throws when executeScript returns empty results', async () => {
    mockExecuteScript.mockResolvedValueOnce([]);
    await expect(executeCodeFirefox('return 1')).rejects.toThrow(
      'executeScript returned no result',
    );
  });

  it('throws when executeScript returns undefined result', async () => {
    mockExecuteScript.mockResolvedValueOnce([{ result: undefined }]);
    await expect(executeCodeFirefox('return 1')).rejects.toThrow(
      'executeScript returned no result',
    );
  });
});

// ── Concurrent creation guard ───────────────────

describe('concurrent creation guard', () => {
  it('only creates one sandbox tab when called concurrently', async () => {
    const [r1, r2] = await Promise.all([
      executeCodeFirefox('return 1'),
      executeCodeFirefox('return 2'),
    ]);
    expect(r1).toBe('1');
    expect(r2).toBe('2');
    // Should only have created the tab once despite concurrent calls
    expect(mockTabsCreate).toHaveBeenCalledTimes(1);
  });

  it('clears sandbox state when tab is removed via onRemoved listener', async () => {
    // First call creates sandbox
    await executeCodeFirefox('return 1');
    expect(mockTabsCreate).toHaveBeenCalledTimes(1);

    // Simulate tab removal via the onRemoved listener
    for (const listener of tabsOnRemovedListeners) {
      listener(SANDBOX_TAB_ID);
    }

    // Next call should create a new sandbox
    await executeCodeFirefox('return 2');
    expect(mockTabsCreate).toHaveBeenCalledTimes(2);
  });
});
