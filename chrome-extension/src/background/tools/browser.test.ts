import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { BrowserArgs, CDPNode, SnapshotContext } from './browser';

// ---------------------------------------------------------------------------
// Chrome API mocks — must be set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

const mockDebuggerAttach = vi.fn((_target: unknown, _version: string, cb: () => void) => cb());
const mockDebuggerDetach = vi.fn((_target: unknown, cb: () => void) => cb());
const mockDebuggerSendCommand = vi.fn(
  (_target: unknown, _method: string, _params: unknown, cb: (result: unknown) => void) => cb({}),
);

const debuggerOnDetachListeners: Array<(source: { tabId?: number }, reason: string) => void> = [];
const debuggerOnEventListeners: Array<
  (source: { tabId?: number }, method: string, params: unknown) => void
> = [];

const tabsOnRemovedListeners: Array<(tabId: number) => void> = [];
const tabsOnUpdatedListeners: Array<(tabId: number, changeInfo: { status?: string }) => void> = [];

const mockTabsQuery = vi.fn<() => Promise<chrome.tabs.Tab[]>>(() =>
  Promise.resolve([
    { id: 1, title: 'Tab One', url: 'https://one.com', active: true } as chrome.tabs.Tab,
    { id: 2, title: 'Tab Two', url: 'https://two.com', active: false } as chrome.tabs.Tab,
  ]),
);
const mockTabsCreate = vi.fn<(opts: { url: string }) => Promise<chrome.tabs.Tab>>(opts =>
  Promise.resolve({ id: 99, title: '', url: opts.url, windowId: 1 } as chrome.tabs.Tab),
);
const mockTabsUpdate = vi.fn<(tabId: number, props: unknown) => Promise<chrome.tabs.Tab>>(
  (tabId, _props) =>
    Promise.resolve({
      id: tabId,
      title: 'Updated',
      url: 'https://updated.com',
      windowId: 1,
    } as chrome.tabs.Tab),
);
const mockTabsRemove = vi.fn(() => Promise.resolve());
const mockTabsGet = vi.fn<(tabId: number) => Promise<chrome.tabs.Tab>>(tabId =>
  Promise.resolve({ id: tabId, title: 'Test Page', url: 'https://test.com' } as chrome.tabs.Tab),
);

const mockWindowsUpdate = vi.fn(() => Promise.resolve());

const mockScriptingExecuteScript = vi.fn((_injection?: unknown) =>
  Promise.resolve([{ result: 'Hello world page text' }]),
);

// Set up the global chrome mock
Object.defineProperty(globalThis, 'chrome', {
  value: {
    debugger: {
      attach: mockDebuggerAttach,
      detach: mockDebuggerDetach,
      sendCommand: mockDebuggerSendCommand,
      onDetach: {
        addListener: (fn: (source: { tabId?: number }, reason: string) => void) => {
          debuggerOnDetachListeners.push(fn);
        },
        removeListener: (fn: (source: { tabId?: number }, reason: string) => void) => {
          const idx = debuggerOnDetachListeners.indexOf(fn);
          if (idx >= 0) debuggerOnDetachListeners.splice(idx, 1);
        },
      },
      onEvent: {
        addListener: (
          fn: (source: { tabId?: number }, method: string, params: unknown) => void,
        ) => {
          debuggerOnEventListeners.push(fn);
        },
        removeListener: (
          fn: (source: { tabId?: number }, method: string, params: unknown) => void,
        ) => {
          const idx = debuggerOnEventListeners.indexOf(fn);
          if (idx >= 0) debuggerOnEventListeners.splice(idx, 1);
        },
      },
    },
    tabs: {
      query: mockTabsQuery,
      create: mockTabsCreate,
      update: mockTabsUpdate,
      remove: mockTabsRemove,
      get: mockTabsGet,
      onRemoved: {
        addListener: (fn: (tabId: number) => void) => {
          tabsOnRemovedListeners.push(fn);
        },
      },
      onUpdated: {
        addListener: (fn: (tabId: number, changeInfo: { status?: string }) => void) => {
          tabsOnUpdatedListeners.push(fn);
        },
        removeListener: (fn: (tabId: number, changeInfo: { status?: string }) => void) => {
          const idx = tabsOnUpdatedListeners.indexOf(fn);
          if (idx >= 0) tabsOnUpdatedListeners.splice(idx, 1);
        },
      },
    },
    windows: {
      update: mockWindowsUpdate,
    },
    scripting: {
      executeScript: mockScriptingExecuteScript,
    },
    runtime: {
      lastError: undefined as { message: string } | undefined,
    },
  },
  writable: true,
  configurable: true,
});

// Now import the module under test
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let mod: typeof import('./browser');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;

  // Re-import fresh module to reset sessions state
  mod = await import('./browser');
});

afterEach(() => {
  // Clear sessions
  mod.sessions.clear();
});

// ---------------------------------------------------------------------------
// Helper: fire debugger onEvent
// ---------------------------------------------------------------------------
const fireDebuggerEvent = (tabId: number, method: string, params: unknown) => {
  for (const listener of debuggerOnEventListeners) {
    listener({ tabId }, method, params);
  }
};

const fireDebuggerDetach = (tabId: number, reason: string) => {
  for (const listener of debuggerOnDetachListeners) {
    listener({ tabId }, reason);
  }
};

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------
describe('browserSchema', () => {
  it('accepts valid tabs action', () => {
    const result = { success: Value.Check(mod.browserSchema, { action: 'tabs' }) };
    expect(result.success).toBe(true);
  });

  it('accepts valid open action with url', () => {
    const result = {
      success: Value.Check(mod.browserSchema, { action: 'open', url: 'https://example.com' }),
    };
    expect(result.success).toBe(true);
  });

  it('accepts valid snapshot action with tabId', () => {
    const result = { success: Value.Check(mod.browserSchema, { action: 'snapshot', tabId: 1 }) };
    expect(result.success).toBe(true);
  });

  it('accepts valid click action with tabId and ref', () => {
    const result = {
      success: Value.Check(mod.browserSchema, { action: 'click', tabId: 1, ref: 3 }),
    };
    expect(result.success).toBe(true);
  });

  it('accepts valid type action with tabId, ref, and text', () => {
    const result = {
      success: Value.Check(mod.browserSchema, {
        action: 'type',
        tabId: 1,
        ref: 3,
        text: 'hello',
      }),
    };
    expect(result.success).toBe(true);
  });

  it('accepts valid evaluate action with tabId and expression', () => {
    const result = {
      success: Value.Check(mod.browserSchema, {
        action: 'evaluate',
        tabId: 1,
        expression: 'document.title',
      }),
    };
    expect(result.success).toBe(true);
  });

  it('rejects invalid action name', () => {
    const result = { success: Value.Check(mod.browserSchema, { action: 'invalid_action' }) };
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tab actions (no debugger)
// ---------------------------------------------------------------------------
describe('executeBrowser — tab actions (no debugger)', () => {
  it('tabs: returns list of open tabs', async () => {
    const result = await mod.executeBrowser({ action: 'tabs' } as BrowserArgs);
    expect(result).toContain('Open tabs (2)');
    expect(result).toContain('[1]');
    expect(result).toContain('Tab One');
    expect(result).toContain('(active)');
    expect(result).toContain('Tab Two');
    expect(mockTabsQuery).toHaveBeenCalled();
  });

  it('open: creates new tab with url and returns tab info', async () => {
    const result = await mod.executeBrowser({
      action: 'open',
      url: 'https://example.com',
    } as BrowserArgs);
    expect(result).toContain('Opened tab [99]');
    expect(mockTabsCreate).toHaveBeenCalledWith({
      url: 'https://example.com',
      active: false,
    });
  });

  it('open: returns error when url is missing', async () => {
    const result = await mod.executeBrowser({ action: 'open' } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('url');
  });

  it('focus: activates tab and brings window to front', async () => {
    const result = await mod.executeBrowser({ action: 'focus', tabId: 1 } as BrowserArgs);
    expect(result).toContain('Focused tab [1]');
    expect(mockTabsUpdate).toHaveBeenCalledWith(1, { active: true });
    expect(mockWindowsUpdate).toHaveBeenCalledWith(1, { focused: true });
  });

  it('focus: returns error when tabId is missing', async () => {
    const result = await mod.executeBrowser({ action: 'focus' } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('tabId');
  });

  it('close: removes tab and cleans up session', async () => {
    // Pre-create a session
    mod.getOrCreateSession(5);
    expect(mod.sessions.has(5)).toBe(true);

    const result = await mod.executeBrowser({ action: 'close', tabId: 5 } as BrowserArgs);
    expect(result).toContain('Closed tab [5]');
    expect(mockTabsRemove).toHaveBeenCalledWith(5);
    expect(mod.sessions.has(5)).toBe(false);
  });

  it('close: returns error when tabId is missing', async () => {
    const result = await mod.executeBrowser({ action: 'close' } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('tabId');
  });
});

// ---------------------------------------------------------------------------
// Content action (no debugger)
// ---------------------------------------------------------------------------
describe('executeBrowser — content action (no debugger)', () => {
  it('content: returns page innerText via chrome.scripting', async () => {
    const result = await mod.executeBrowser({ action: 'content', tabId: 1 } as BrowserArgs);
    expect(result).toBe('Hello world page text');
    expect(mockScriptingExecuteScript).toHaveBeenCalled();
  });

  it('content: scopes extraction to CSS selector when provided', async () => {
    await mod.executeBrowser({
      action: 'content',
      tabId: 1,
      selector: '#main',
    } as BrowserArgs);
    const call = mockScriptingExecuteScript.mock.calls[0]?.[0] as { args?: unknown[] } | undefined;
    expect(call?.args).toEqual(['#main']);
  });

  it('content: truncates text exceeding 50,000 chars', async () => {
    const longText = 'x'.repeat(60000);
    mockScriptingExecuteScript.mockResolvedValueOnce([{ result: longText }]);
    const result = await mod.executeBrowser({ action: 'content', tabId: 1 } as BrowserArgs);
    expect(result.length).toBeLessThan(60000);
    expect(result).toContain('[truncated at 50,000 characters]');
  });

  it('content: returns error when tabId is missing', async () => {
    const result = await mod.executeBrowser({ action: 'content' } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('tabId');
  });
});

// ---------------------------------------------------------------------------
// Debugger actions
// ---------------------------------------------------------------------------
describe('executeBrowser — debugger actions', () => {
  it('navigate: attaches debugger and navigates to url', async () => {
    // Set up sendCommand to handle the various CDP calls
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.navigate') {
          // Simulate load event after navigation
          setTimeout(() => {
            fireDebuggerEvent(1, 'Page.loadEventFired', {});
          }, 10);
        }
        cb({});
      },
    );

    const result = await mod.executeBrowser({
      action: 'navigate',
      tabId: 1,
      url: 'https://example.com',
    } as BrowserArgs);

    expect(result).toContain('Navigated tab [1]');
    expect(mockDebuggerAttach).toHaveBeenCalled();
  });

  it('navigate: returns error when url is missing', async () => {
    const result = await mod.executeBrowser({
      action: 'navigate',
      tabId: 1,
    } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('url');
  });

  it('snapshot: returns compact DOM with numbered element refs', async () => {
    // Mock DOM.getDocument to return a simple tree
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'DOM.getDocument') {
          cb({
            root: {
              nodeId: 1,
              backendNodeId: 1,
              nodeType: 9, // Document
              nodeName: '#document',
              children: [
                {
                  nodeId: 2,
                  backendNodeId: 2,
                  nodeType: 1,
                  nodeName: 'HTML',
                  children: [
                    {
                      nodeId: 3,
                      backendNodeId: 3,
                      nodeType: 1,
                      nodeName: 'BODY',
                      children: [
                        {
                          nodeId: 4,
                          backendNodeId: 4,
                          nodeType: 1,
                          nodeName: 'NAV',
                          children: [
                            {
                              nodeId: 5,
                              backendNodeId: 5,
                              nodeType: 1,
                              nodeName: 'A',
                              attributes: ['href', '/home'],
                              children: [
                                {
                                  nodeId: 6,
                                  backendNodeId: 6,
                                  nodeType: 3,
                                  nodeName: '#text',
                                  nodeValue: 'Home',
                                },
                              ],
                            },
                          ],
                        },
                        {
                          nodeId: 7,
                          backendNodeId: 7,
                          nodeType: 1,
                          nodeName: 'BUTTON',
                          children: [
                            {
                              nodeId: 8,
                              backendNodeId: 8,
                              nodeType: 3,
                              nodeName: '#text',
                              nodeValue: 'Submit',
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs);

    expect(result).toContain('[page]');
    expect(result).toContain('[1] link "Home" href=/home');
    expect(result).toContain('[2] button "Submit"');
    expect(result).toContain('[nav]');
  });

  it('snapshot: skips script, style, noscript, svg, meta, link nodes', async () => {
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'DOM.getDocument') {
          cb({
            root: {
              nodeId: 1,
              backendNodeId: 1,
              nodeType: 9,
              nodeName: '#document',
              children: [
                {
                  nodeId: 2,
                  backendNodeId: 2,
                  nodeType: 1,
                  nodeName: 'HTML',
                  children: [
                    {
                      nodeId: 3,
                      backendNodeId: 3,
                      nodeType: 1,
                      nodeName: 'BODY',
                      children: [
                        {
                          nodeId: 10,
                          backendNodeId: 10,
                          nodeType: 1,
                          nodeName: 'SCRIPT',
                          children: [],
                        },
                        {
                          nodeId: 11,
                          backendNodeId: 11,
                          nodeType: 1,
                          nodeName: 'STYLE',
                          children: [],
                        },
                        {
                          nodeId: 12,
                          backendNodeId: 12,
                          nodeType: 1,
                          nodeName: 'NOSCRIPT',
                          children: [],
                        },
                        {
                          nodeId: 13,
                          backendNodeId: 13,
                          nodeType: 1,
                          nodeName: 'SVG',
                          children: [],
                        },
                        {
                          nodeId: 14,
                          backendNodeId: 14,
                          nodeType: 1,
                          nodeName: 'META',
                          children: [],
                        },
                        {
                          nodeId: 15,
                          backendNodeId: 15,
                          nodeType: 1,
                          nodeName: 'LINK',
                          children: [],
                        },
                        {
                          nodeId: 20,
                          backendNodeId: 20,
                          nodeType: 1,
                          nodeName: 'P',
                          children: [
                            {
                              nodeId: 21,
                              backendNodeId: 21,
                              nodeType: 3,
                              nodeName: '#text',
                              nodeValue: 'Visible text',
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs);
    expect(result).not.toContain('script');
    expect(result).not.toContain('style');
    expect(result).not.toContain('noscript');
    expect(result).not.toContain('svg');
    expect(result).not.toContain('meta');
    expect(result).not.toContain('link');
    expect(result).toContain('Visible text');
  });

  it('snapshot: assigns refs only to interactive elements', async () => {
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'DOM.getDocument') {
          cb({
            root: {
              nodeId: 1,
              backendNodeId: 1,
              nodeType: 9,
              nodeName: '#document',
              children: [
                {
                  nodeId: 2,
                  backendNodeId: 2,
                  nodeType: 1,
                  nodeName: 'HTML',
                  children: [
                    {
                      nodeId: 3,
                      backendNodeId: 3,
                      nodeType: 1,
                      nodeName: 'BODY',
                      children: [
                        {
                          nodeId: 4,
                          backendNodeId: 4,
                          nodeType: 1,
                          nodeName: 'DIV',
                          children: [
                            {
                              nodeId: 5,
                              backendNodeId: 5,
                              nodeType: 1,
                              nodeName: 'INPUT',
                              attributes: ['type', 'email', 'placeholder', 'Email'],
                              children: [],
                            },
                            {
                              nodeId: 6,
                              backendNodeId: 6,
                              nodeType: 1,
                              nodeName: 'SPAN',
                              children: [
                                {
                                  nodeId: 7,
                                  backendNodeId: 7,
                                  nodeType: 3,
                                  nodeName: '#text',
                                  nodeValue: 'Just text',
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs);
    // INPUT should have a ref
    expect(result).toContain('[1] input type=email');
    // SPAN should NOT have a ref (not interactive)
    expect(result).not.toMatch(/\[\d+\] span/);
    // But span text should still appear
    expect(result).toContain('Just text');
  });

  it('screenshot: returns fallback JSON when sanitization is unavailable', async () => {
    // In test env, OffscreenCanvas/createImageBitmap are not available,
    // so sanitizeImage throws and the fallback JSON.stringify path is used.
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.captureScreenshot') {
          cb({ data: 'iVBORw0KGgoAAAA' });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({ action: 'screenshot', tabId: 1 } as BrowserArgs);
    // Fallback path returns a JSON string
    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result as string);
    expect(parsed.base64).toBe('iVBORw0KGgoAAAA');
    expect(parsed.mimeType).toBe('image/png');
  });

  it('screenshot: returns ScreenshotResult when sanitization succeeds', async () => {
    // Mock the global APIs that sanitizeImage needs
    const mockClose = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1920, height: 1080, close: mockClose })),
    );
    const mockConvert = vi.fn(async () => new Blob(['jpeg-data'], { type: 'image/jpeg' }));
    class TestOffscreenCanvas {
      getContext() { return { drawImage: vi.fn() }; }
      convertToBlob = mockConvert;
    }
    vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas);

    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.captureScreenshot') {
          cb({ data: btoa('fake-png') });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({ action: 'screenshot', tabId: 1 } as BrowserArgs);

    // Should return ScreenshotResult object, not a string
    expect(typeof result).toBe('object');
    const ss = result as { __type: string; base64: string; mimeType: string; width: number; height: number };
    expect(ss.__type).toBe('screenshot');
    expect(ss.mimeType).toBe('image/jpeg');
    expect(ss.width).toBeLessThanOrEqual(1200);
    expect(ss.height).toBeLessThanOrEqual(1200);
    expect(ss.base64).toBeTruthy();

    // Cleanup globals
    vi.unstubAllGlobals();
  });

  it('click: resolves ref from snapshot and clicks element', async () => {
    // Pre-populate session ref map
    const session = mod.getOrCreateSession(1);
    session.attached = true;
    session.refMap.set(1, { nodeId: 5, backendNodeId: 5 });

    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'DOM.resolveNode') {
          cb({ object: { objectId: 'obj-1' } });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({ action: 'click', tabId: 1, ref: 1 } as BrowserArgs);
    expect(result).toContain('Clicked element [1]');
  });

  it('click: returns stale ref error when ref not found', async () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;

    const result = await mod.executeBrowser({ action: 'click', tabId: 1, ref: 999 } as BrowserArgs);
    expect(result).toContain('Ref [999] not found');
    expect(result).toContain('snapshot');
  });

  it('type: resolves ref, focuses element, and inserts text', async () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;
    session.refMap.set(3, { nodeId: 10, backendNodeId: 10 });

    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'DOM.resolveNode') {
          cb({ object: { objectId: 'obj-3' } });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({
      action: 'type',
      tabId: 1,
      ref: 3,
      text: 'hello world',
    } as BrowserArgs);
    expect(result).toContain('Typed "hello world"');
    expect(result).toContain('element [3]');
  });

  it('type: returns error when ref or text is missing', async () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;

    let result = await mod.executeBrowser({ action: 'type', tabId: 1 } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('ref');

    result = await mod.executeBrowser({ action: 'type', tabId: 1, ref: 1 } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('text');
  });

  it('evaluate: runs expression and returns result', async () => {
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Runtime.evaluate') {
          cb({ result: { type: 'string', value: 'My Page Title' } });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({
      action: 'evaluate',
      tabId: 1,
      expression: 'document.title',
    } as BrowserArgs);
    expect(result).toBe('My Page Title');
  });

  it('evaluate: returns error when expression is missing', async () => {
    const result = await mod.executeBrowser({ action: 'evaluate', tabId: 1 } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('expression');
  });

  it('console: returns buffered console messages', async () => {
    const session = mod.getOrCreateSession(1);
    session.consoleLogs.push(
      { type: 'log', text: 'hello', timestamp: 1 },
      { type: 'error', text: 'oops', timestamp: 2 },
    );

    const result = await mod.executeBrowser({ action: 'console', tabId: 1 } as BrowserArgs);
    expect(result).toContain('Console messages (2)');
    expect(result).toContain('[log] hello');
    expect(result).toContain('[error] oops');
  });

  it('network: returns buffered network requests', async () => {
    const session = mod.getOrCreateSession(1);
    session.networkRequests.push(
      {
        method: 'GET',
        url: 'https://api.com/data',
        status: 200,
        type: 'application/json',
        timestamp: 1,
      },
      { method: 'POST', url: 'https://api.com/submit', timestamp: 2 },
    );

    const result = await mod.executeBrowser({ action: 'network', tabId: 1 } as BrowserArgs);
    expect(result).toContain('Network requests (2)');
    expect(result).toContain('GET https://api.com/data');
    expect(result).toContain('200');
    expect(result).toContain('POST https://api.com/submit');
    expect(result).toContain('(pending)');
  });

  it('console/network: respects limit parameter', async () => {
    const session = mod.getOrCreateSession(1);
    for (let i = 0; i < 10; i++) {
      session.consoleLogs.push({ type: 'log', text: `msg-${i}`, timestamp: i });
    }

    const result = await mod.executeBrowser({
      action: 'console',
      tabId: 1,
      limit: 3,
    } as BrowserArgs);
    expect(result).toContain('Console messages (3)');
    expect(result).toContain('msg-7');
    expect(result).toContain('msg-8');
    expect(result).toContain('msg-9');
    expect(result).not.toContain('msg-6');
  });
});

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------
describe('session management', () => {
  it('ensureAttached: attaches debugger and enables Runtime + Network domains', async () => {
    const calledMethods: string[] = [];
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        calledMethods.push(method);
        cb({});
      },
    );

    // Trigger attach via a navigate action
    await mod.executeBrowser({
      action: 'evaluate',
      tabId: 10,
      expression: '1+1',
    } as BrowserArgs);

    expect(mockDebuggerAttach).toHaveBeenCalled();
    expect(calledMethods).toContain('Runtime.enable');
    expect(calledMethods).toContain('Network.enable');
    expect(calledMethods).toContain('Page.enable');
    expect(calledMethods).toContain('DOM.enable');
  });

  it('ensureAttached: is idempotent for already-attached tabs', async () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;

    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, _method: string, _params: unknown, cb: (result: unknown) => void) => {
        cb({ result: { type: 'number', value: 2 } });
      },
    );

    await mod.executeBrowser({
      action: 'evaluate',
      tabId: 1,
      expression: '1+1',
    } as BrowserArgs);

    // Should NOT call attach again
    expect(mockDebuggerAttach).not.toHaveBeenCalled();
  });

  it('ensureAttached: returns error for chrome:// pages', async () => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = { message: 'Cannot access a chrome:// URL' };
      cb();
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
    });

    const result = await mod.executeBrowser({
      action: 'snapshot',
      tabId: 1,
    } as BrowserArgs);
    expect(result).toContain('blocks programmatic access');
  });

  it('onDetach: cleans up session when user dismisses yellow bar', () => {
    mod.getOrCreateSession(42);
    expect(mod.sessions.has(42)).toBe(true);

    fireDebuggerDetach(42, 'canceled_by_user');
    expect(mod.sessions.has(42)).toBe(false);
  });

  it('onDetach: cleans up session when tab is closed', () => {
    mod.getOrCreateSession(7);
    expect(mod.sessions.has(7)).toBe(true);

    fireDebuggerDetach(7, 'target_closed');
    expect(mod.sessions.has(7)).toBe(false);
  });

  it('event buffering: stores console events in ring buffer (max 200)', () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;

    fireDebuggerEvent(1, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'test message' }],
    });

    expect(session.consoleLogs).toHaveLength(1);
    expect(session.consoleLogs[0].type).toBe('log');
    expect(session.consoleLogs[0].text).toContain('test message');
  });

  it('event buffering: stores network events in ring buffer (max 200)', () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;

    fireDebuggerEvent(1, 'Network.requestWillBeSent', {
      request: { method: 'GET', url: 'https://api.com/test' },
    });

    expect(session.networkRequests).toHaveLength(1);
    expect(session.networkRequests[0].method).toBe('GET');
    expect(session.networkRequests[0].url).toBe('https://api.com/test');
  });

  it('event buffering: oldest events evicted when buffer full', () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;

    // Fill buffer beyond max
    for (let i = 0; i < mod.MAX_BUFFER + 10; i++) {
      fireDebuggerEvent(1, 'Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ type: 'string', value: `msg-${i}` }],
      });
    }

    expect(session.consoleLogs).toHaveLength(mod.MAX_BUFFER);
    // Oldest should be evicted, newest should be present
    expect(session.consoleLogs[0].text).toContain(`msg-10`);
    expect(session.consoleLogs[session.consoleLogs.length - 1].text).toContain(
      `msg-${mod.MAX_BUFFER + 9}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Snapshot algorithm — walkNode
// ---------------------------------------------------------------------------
describe('snapshot algorithm — walkNode', () => {
  const makeCtx = (): SnapshotContext => ({
    refCounter: 0,
    nodeCount: 0,
    refMap: new Map(),
    lines: [],
  });

  const makeNode = (overrides: Partial<CDPNode>): CDPNode => ({
    nodeId: 1,
    backendNodeId: 1,
    nodeType: 1,
    nodeName: 'DIV',
    children: [],
    ...overrides,
  });

  it('assigns sequential refs to a, button, input, select, textarea elements', () => {
    const ctx = makeCtx();
    const root = makeNode({
      nodeName: 'DIV',
      children: [
        makeNode({
          nodeId: 2,
          backendNodeId: 2,
          nodeName: 'A',
          attributes: ['href', '/'],
          children: [
            {
              nodeId: 10,
              backendNodeId: 10,
              nodeType: 3,
              nodeName: '#text',
              nodeValue: 'Link',
            } as CDPNode,
          ],
        }),
        makeNode({
          nodeId: 3,
          backendNodeId: 3,
          nodeName: 'BUTTON',
          children: [
            {
              nodeId: 11,
              backendNodeId: 11,
              nodeType: 3,
              nodeName: '#text',
              nodeValue: 'Click',
            } as CDPNode,
          ],
        }),
        makeNode({ nodeId: 4, backendNodeId: 4, nodeName: 'INPUT', attributes: ['type', 'text'] }),
        makeNode({ nodeId: 5, backendNodeId: 5, nodeName: 'SELECT' }),
        makeNode({ nodeId: 6, backendNodeId: 6, nodeName: 'TEXTAREA' }),
      ],
    });

    mod.walkNode(root, 0, ctx);
    expect(ctx.refCounter).toBe(5);
    expect(ctx.refMap.size).toBe(5);
    expect(ctx.lines.join('\n')).toContain('[1] link');
    expect(ctx.lines.join('\n')).toContain('[2] button');
    expect(ctx.lines.join('\n')).toContain('[3] input');
    expect(ctx.lines.join('\n')).toContain('[4] select');
    expect(ctx.lines.join('\n')).toContain('[5] textarea');
  });

  it('assigns refs to elements with role=button, onclick, contenteditable', () => {
    const ctx = makeCtx();
    const root = makeNode({
      nodeName: 'DIV',
      children: [
        makeNode({
          nodeId: 2,
          backendNodeId: 2,
          nodeName: 'SPAN',
          attributes: ['role', 'button'],
          children: [
            {
              nodeId: 10,
              backendNodeId: 10,
              nodeType: 3,
              nodeName: '#text',
              nodeValue: 'Role button',
            } as CDPNode,
          ],
        }),
        makeNode({
          nodeId: 3,
          backendNodeId: 3,
          nodeName: 'DIV',
          attributes: ['onclick', 'handleClick()'],
          children: [
            {
              nodeId: 11,
              backendNodeId: 11,
              nodeType: 3,
              nodeName: '#text',
              nodeValue: 'Clickable',
            } as CDPNode,
          ],
        }),
        makeNode({
          nodeId: 4,
          backendNodeId: 4,
          nodeName: 'DIV',
          attributes: ['contenteditable', 'true'],
          children: [
            {
              nodeId: 12,
              backendNodeId: 12,
              nodeType: 3,
              nodeName: '#text',
              nodeValue: 'Editable',
            } as CDPNode,
          ],
        }),
      ],
    });

    mod.walkNode(root, 0, ctx);
    expect(ctx.refCounter).toBe(3);
    expect(ctx.lines.join('\n')).toContain('[1] button "Role button"');
  });

  it('includes structural tags (div, nav, form, h1-h6, p, li, table) without refs', () => {
    const ctx = makeCtx();
    const root = makeNode({
      nodeName: 'NAV',
      children: [
        makeNode({
          nodeId: 2,
          backendNodeId: 2,
          nodeName: 'P',
          children: [
            {
              nodeId: 3,
              backendNodeId: 3,
              nodeType: 3,
              nodeName: '#text',
              nodeValue: 'Paragraph text',
            } as CDPNode,
          ],
        }),
      ],
    });

    mod.walkNode(root, 0, ctx);
    const output = ctx.lines.join('\n');
    expect(output).toContain('[nav]');
    expect(output).toContain('[p]');
    expect(output).not.toMatch(/\[\d+\] nav/);
    expect(output).not.toMatch(/\[\d+\] p/);
    expect(ctx.refCounter).toBe(0);
  });

  it('handles nested structures with correct indentation', () => {
    const ctx = makeCtx();
    const root = makeNode({
      nodeName: 'DIV',
      children: [
        makeNode({
          nodeId: 2,
          backendNodeId: 2,
          nodeName: 'FORM',
          children: [
            makeNode({
              nodeId: 3,
              backendNodeId: 3,
              nodeName: 'INPUT',
              attributes: ['type', 'text'],
            }),
          ],
        }),
      ],
    });

    mod.walkNode(root, 0, ctx);
    const output = ctx.lines.join('\n');
    expect(output).toContain('[div]');
    expect(output).toContain('  [form]');
    expect(output).toContain('    [1] input type=text');
  });

  it('shows link href and input type/placeholder in output', () => {
    const ctx = makeCtx();
    const link = makeNode({
      nodeId: 2,
      backendNodeId: 2,
      nodeName: 'A',
      attributes: ['href', '/about'],
      children: [
        {
          nodeId: 3,
          backendNodeId: 3,
          nodeType: 3,
          nodeName: '#text',
          nodeValue: 'About',
        } as CDPNode,
      ],
    });
    const input = makeNode({
      nodeId: 4,
      backendNodeId: 4,
      nodeName: 'INPUT',
      attributes: ['type', 'email', 'placeholder', 'Enter email'],
    });

    mod.walkNode(link, 0, ctx);
    mod.walkNode(input, 0, ctx);

    const output = ctx.lines.join('\n');
    expect(output).toContain('href=/about');
    expect(output).toContain('type=email');
    expect(output).toContain('placeholder="Enter email"');
  });

  it('handles empty page gracefully', () => {
    const ctx = makeCtx();
    const root = makeNode({
      nodeType: 9,
      nodeName: '#document',
      children: [
        makeNode({
          nodeId: 2,
          backendNodeId: 2,
          nodeName: 'HTML',
          children: [makeNode({ nodeId: 3, backendNodeId: 3, nodeName: 'BODY', children: [] })],
        }),
      ],
    });

    mod.walkNode(root, 0, ctx);
    // Should not error, may produce minimal output
    expect(ctx.nodeCount).toBeGreaterThan(0);
  });

  it('caps depth at 15 levels', () => {
    // Build a deeply nested tree
    let current: CDPNode = makeNode({
      nodeId: 100,
      backendNodeId: 100,
      nodeName: 'BUTTON',
      children: [
        {
          nodeId: 101,
          backendNodeId: 101,
          nodeType: 3,
          nodeName: '#text',
          nodeValue: 'Deep button',
        } as CDPNode,
      ],
    });
    for (let i = 0; i < 20; i++) {
      current = makeNode({
        nodeId: i + 200,
        backendNodeId: i + 200,
        nodeName: 'DIV',
        children: [current],
      });
    }

    const ctx = makeCtx();
    mod.walkNode(current, 0, ctx);

    // The button at depth 21 should not appear (max depth is 15)
    const output = ctx.lines.join('\n');
    expect(output).not.toContain('Deep button');
  });

  it('shows cross-origin iframes as [iframe] src=... without refs', () => {
    const ctx = makeCtx();
    const root = makeNode({
      nodeName: 'DIV',
      children: [
        makeNode({
          nodeId: 2,
          backendNodeId: 2,
          nodeName: 'IFRAME',
          attributes: ['src', 'https://external.com/page'],
          children: [],
        }),
      ],
    });

    mod.walkNode(root, 0, ctx);
    const output = ctx.lines.join('\n');
    expect(output).toContain('[iframe] src=https://external.com/page');
    expect(ctx.refCounter).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------
describe('truncateText', () => {
  it('returns short text unchanged', () => {
    expect(mod.truncateText('hello')).toBe('hello');
  });

  it('truncates text longer than 80 chars', () => {
    const long = 'a'.repeat(100);
    const result = mod.truncateText(long);
    expect(result.length).toBe(mod.MAX_TEXT_LENGTH + 3); // +3 for "..."
    expect(result.endsWith('...')).toBe(true);
  });

  it('collapses whitespace', () => {
    expect(mod.truncateText('  hello   world  ')).toBe('hello world');
  });
});

describe('isInteractive', () => {
  const makeEl = (nodeName: string, attrs?: string[]): CDPNode => ({
    nodeId: 1,
    backendNodeId: 1,
    nodeType: 1,
    nodeName,
    attributes: attrs,
    children: [],
  });

  it('returns true for interactive HTML tags', () => {
    expect(mod.isInteractive(makeEl('A'))).toBe(true);
    expect(mod.isInteractive(makeEl('BUTTON'))).toBe(true);
    expect(mod.isInteractive(makeEl('INPUT'))).toBe(true);
    expect(mod.isInteractive(makeEl('SELECT'))).toBe(true);
    expect(mod.isInteractive(makeEl('TEXTAREA'))).toBe(true);
  });

  it('returns true for ARIA roles', () => {
    expect(mod.isInteractive(makeEl('DIV', ['role', 'button']))).toBe(true);
    expect(mod.isInteractive(makeEl('SPAN', ['role', 'checkbox']))).toBe(true);
  });

  it('returns true for onclick/contenteditable', () => {
    expect(mod.isInteractive(makeEl('DIV', ['onclick', 'fn()']))).toBe(true);
    expect(mod.isInteractive(makeEl('DIV', ['contenteditable', 'true']))).toBe(true);
  });

  it('returns false for plain structural elements', () => {
    expect(mod.isInteractive(makeEl('DIV'))).toBe(false);
    expect(mod.isInteractive(makeEl('SPAN'))).toBe(false);
    expect(mod.isInteractive(makeEl('P'))).toBe(false);
  });

  it('returns true for non-div/span with tabindex', () => {
    expect(mod.isInteractive(makeEl('LI', ['tabindex', '0']))).toBe(true);
  });

  it('returns false for div/span with tabindex (excluded)', () => {
    expect(mod.isInteractive(makeEl('DIV', ['tabindex', '0']))).toBe(false);
    expect(mod.isInteractive(makeEl('SPAN', ['tabindex', '0']))).toBe(false);
  });

  it('returns true for DETAILS and SUMMARY tags', () => {
    expect(mod.isInteractive(makeEl('DETAILS'))).toBe(true);
    expect(mod.isInteractive(makeEl('SUMMARY'))).toBe(true);
  });

  it('returns true for all INTERACTIVE_ROLES', () => {
    const roles = [
      'link',
      'checkbox',
      'radio',
      'tab',
      'menuitem',
      'switch',
      'combobox',
      'searchbox',
      'slider',
      'spinbutton',
      'textbox',
      'option',
    ];
    for (const role of roles) {
      expect(mod.isInteractive(makeEl('DIV', ['role', role]))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// formatInteractiveNode edge cases
// ---------------------------------------------------------------------------
describe('formatInteractiveNode', () => {
  const makeEl = (nodeName: string, attrs?: string[], children?: CDPNode[]): CDPNode => ({
    nodeId: 1,
    backendNodeId: 1,
    nodeType: 1,
    nodeName,
    attributes: attrs,
    children: children ?? [],
  });

  it('shows aria-label when no text content exists', () => {
    const node = makeEl('BUTTON', ['aria-label', 'Close dialog']);
    const result = mod.formatInteractiveNode(node, 1);
    expect(result).toContain('"Close dialog"');
  });

  it('does not show aria-label when text content exists', () => {
    const node = makeEl(
      'BUTTON',
      ['aria-label', 'Close'],
      [{ nodeId: 2, backendNodeId: 2, nodeType: 3, nodeName: '#text', nodeValue: 'X' } as CDPNode],
    );
    const result = mod.formatInteractiveNode(node, 1);
    expect(result).toContain('"X"');
    // aria-label should not be repeated since text exists
    expect(result).not.toContain('"Close"');
  });

  it('shows value for input elements', () => {
    const node = makeEl('INPUT', ['type', 'text', 'value', 'Hello']);
    const result = mod.formatInteractiveNode(node, 1);
    expect(result).toContain('value="Hello"');
  });

  it('shows name attribute', () => {
    const node = makeEl('INPUT', ['type', 'text', 'name', 'email']);
    const result = mod.formatInteractiveNode(node, 1);
    expect(result).toContain('name="email"');
  });

  it('shows disabled, readonly, required flags', () => {
    const node = makeEl('INPUT', ['type', 'text', 'disabled', '', 'readonly', '', 'required', '']);
    const result = mod.formatInteractiveNode(node, 1);
    expect(result).toContain('disabled');
    expect(result).toContain('readonly');
    expect(result).toContain('required');
  });

  it('shows select type', () => {
    const node = makeEl('SELECT');
    const result = mod.formatInteractiveNode(node, 1);
    expect(result).toContain('select');
  });

  it('shows textarea type', () => {
    const node = makeEl('TEXTAREA');
    const result = mod.formatInteractiveNode(node, 1);
    expect(result).toContain('textarea');
  });

  it('shows role fallback for non-standard interactive elements', () => {
    const node = makeEl('DIV', ['role', 'slider']);
    const result = mod.formatInteractiveNode(node, 1);
    expect(result).toContain('slider');
  });

  it('truncates long href', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(100);
    const node = makeEl(
      'A',
      ['href', longUrl],
      [
        {
          nodeId: 2,
          backendNodeId: 2,
          nodeType: 3,
          nodeName: '#text',
          nodeValue: 'Link',
        } as CDPNode,
      ],
    );
    const result = mod.formatInteractiveNode(node, 1);
    expect(result).toContain('href=');
    expect(result).toContain('...');
  });
});

// ---------------------------------------------------------------------------
// Additional CDP error paths
// ---------------------------------------------------------------------------
describe('executeBrowser — error paths', () => {
  it('click: falls back to coordinate click when DOM.resolveNode fails', async () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;
    session.refMap.set(1, { nodeId: 5, backendNodeId: 5 });

    let callCount = 0;
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        callCount++;
        if (method === 'DOM.resolveNode') {
          chrome.runtime.lastError = {
            message: 'Node not found',
          } as typeof chrome.runtime.lastError;
          cb({});
          chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
          return;
        }
        if (method === 'DOM.getBoxModel') {
          cb({ model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } });
          return;
        }
        cb({});
      },
    );

    const result = await mod.executeBrowser({ action: 'click', tabId: 1, ref: 1 } as BrowserArgs);
    expect(result).toContain('Clicked element [1] (via coordinates)');
  });

  it('click: returns error when both resolveNode and getBoxModel fail', async () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;
    session.refMap.set(1, { nodeId: 5, backendNodeId: 5 });

    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, _method: string, _params: unknown, cb: (result: unknown) => void) => {
        chrome.runtime.lastError = { message: 'Node not found' } as typeof chrome.runtime.lastError;
        cb({});
        chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      },
    );

    const result = await mod.executeBrowser({ action: 'click', tabId: 1, ref: 1 } as BrowserArgs);
    expect(result).toContain('Error clicking element [1]');
  });

  it('type: returns error when DOM.resolveNode fails', async () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;
    session.refMap.set(1, { nodeId: 5, backendNodeId: 5 });

    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, _method: string, _params: unknown, cb: (result: unknown) => void) => {
        chrome.runtime.lastError = { message: 'Node gone' } as typeof chrome.runtime.lastError;
        cb({});
        chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      },
    );

    const result = await mod.executeBrowser({
      action: 'type',
      tabId: 1,
      ref: 1,
      text: 'hello',
    } as BrowserArgs);
    expect(result).toContain('Error typing into element [1]');
  });

  it('type: truncates long text in success message', async () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;
    session.refMap.set(1, { nodeId: 5, backendNodeId: 5 });

    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'DOM.resolveNode') {
          cb({ object: { objectId: 'obj-1' } });
        } else {
          cb({});
        }
      },
    );

    const longText = 'x'.repeat(100);
    const result = await mod.executeBrowser({
      action: 'type',
      tabId: 1,
      ref: 1,
      text: longText,
    } as BrowserArgs);
    expect(result).toContain('...');
    expect(result).toContain('element [1]');
  });

  it('navigate: returns error when Page.navigate reports errorText', async () => {
    // Ensure attach succeeds
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.navigate') {
          cb({ errorText: 'net::ERR_NAME_NOT_RESOLVED' });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({
      action: 'navigate',
      tabId: 1,
      url: 'https://invalid.domain.xyz',
    } as BrowserArgs);
    expect(result).toContain('Navigation failed');
    expect(result).toContain('ERR_NAME_NOT_RESOLVED');
  });

  it('navigate: returns error when tabId is missing', async () => {
    const result = await mod.executeBrowser({
      action: 'navigate',
      url: 'https://example.com',
    } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('tabId');
  });

  it('screenshot: returns error when tabId is missing', async () => {
    const result = await mod.executeBrowser({ action: 'screenshot' } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('tabId');
  });

  it('screenshot: fullPage sets device metrics and clears them after', async () => {
    // Ensure attach succeeds
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
    const calledMethods: string[] = [];
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        calledMethods.push(method);
        if (method === 'Page.getLayoutMetrics') {
          cb({ contentSize: { width: 1200, height: 5000 } });
        } else if (method === 'Page.captureScreenshot') {
          cb({ data: 'base64data' });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({
      action: 'screenshot',
      tabId: 1,
      fullPage: true,
    } as BrowserArgs);

    expect(calledMethods).toContain('Emulation.setDeviceMetricsOverride');
    expect(calledMethods).toContain('Page.captureScreenshot');
    expect(calledMethods).toContain('Emulation.clearDeviceMetricsOverride');
    const parsed = JSON.parse(result);
    expect(parsed.base64).toBe('base64data');
  });

  it('click: returns error when tabId is missing', async () => {
    const result = await mod.executeBrowser({ action: 'click', ref: 1 } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('tabId');
  });

  it('click: returns error when ref is missing', async () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;
    const result = await mod.executeBrowser({ action: 'click', tabId: 1 } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('ref');
  });

  it('snapshot: returns error when tabId is missing', async () => {
    const result = await mod.executeBrowser({ action: 'snapshot' } as BrowserArgs);
    expect(result).toContain('Error');
    expect(result).toContain('tabId');
  });

  it('evaluate: returns exception details on runtime error', async () => {
    // Ensure attach succeeds
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Runtime.evaluate') {
          cb({
            result: { type: 'object' },
            exceptionDetails: {
              text: 'Uncaught ReferenceError',
              exception: { description: 'ReferenceError: foo is not defined' },
            },
          });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({
      action: 'evaluate',
      tabId: 1,
      expression: 'foo',
    } as BrowserArgs);
    expect(result).toContain('ReferenceError');
  });

  it('evaluate: returns "undefined" for undefined results', async () => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Runtime.evaluate') {
          cb({ result: { type: 'undefined' } });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({
      action: 'evaluate',
      tabId: 1,
      expression: 'void 0',
    } as BrowserArgs);
    expect(result).toBe('undefined');
  });

  it('evaluate: returns JSON-stringified value for non-string results', async () => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Runtime.evaluate') {
          cb({ result: { type: 'number', value: 42 } });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({
      action: 'evaluate',
      tabId: 1,
      expression: '21 * 2',
    } as BrowserArgs);
    expect(result).toBe('42');
  });

  it('evaluate: returns description for object-type results without value', async () => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Runtime.evaluate') {
          cb({ result: { type: 'object', description: 'HTMLDivElement' } });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({
      action: 'evaluate',
      tabId: 1,
      expression: 'document.body.firstChild',
    } as BrowserArgs);
    expect(result).toBe('HTMLDivElement');
  });

  it('evaluate: returns [type] when no value or description', async () => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Runtime.evaluate') {
          cb({ result: { type: 'symbol' } });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({
      action: 'evaluate',
      tabId: 1,
      expression: 'Symbol("x")',
    } as BrowserArgs);
    expect(result).toBe('[symbol]');
  });

  it('console: returns no-data message when session does not exist', async () => {
    const result = await mod.executeBrowser({ action: 'console', tabId: 999 } as BrowserArgs);
    expect(result).toContain('No console data');
  });

  it('console: returns no-messages when log buffer is empty', async () => {
    mod.getOrCreateSession(1);
    const result = await mod.executeBrowser({ action: 'console', tabId: 1 } as BrowserArgs);
    expect(result).toContain('No console messages captured');
  });

  it('network: returns no-data message when session does not exist', async () => {
    const result = await mod.executeBrowser({ action: 'network', tabId: 999 } as BrowserArgs);
    expect(result).toContain('No network data');
  });

  it('network: returns no-requests when buffer is empty', async () => {
    mod.getOrCreateSession(1);
    const result = await mod.executeBrowser({ action: 'network', tabId: 1 } as BrowserArgs);
    expect(result).toContain('No network requests captured');
  });

  it('executeBrowser: returns error for unknown action', async () => {
    const result = await mod.executeBrowser({ action: 'bogus' } as unknown as BrowserArgs);
    expect(result).toContain('Unknown action');
  });

  it('ensureAttached: handles "Another debugger is already attached"', async () => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = {
        message: 'Another debugger is already attached to this tab',
      } as typeof chrome.runtime.lastError;
      cb();
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
    });

    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'DOM.getDocument') {
          cb({
            root: {
              nodeId: 1,
              backendNodeId: 1,
              nodeType: 9,
              nodeName: '#document',
              children: [],
            },
          });
        } else {
          cb({});
        }
      },
    );

    // Should succeed because "Another debugger" is treated as already attached
    const result = await mod.executeBrowser({
      action: 'snapshot',
      tabId: 1,
    } as BrowserArgs);
    expect(result).toContain('[page]');
  });

  it('close: detaches debugger if session is attached', async () => {
    const session = mod.getOrCreateSession(10);
    session.attached = true;

    const result = await mod.executeBrowser({ action: 'close', tabId: 10 } as BrowserArgs);
    expect(result).toContain('Closed tab [10]');
    expect(mockDebuggerDetach).toHaveBeenCalled();
    expect(mockTabsRemove).toHaveBeenCalledWith(10);
  });

  it('network: updates matching request with response status', () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;

    // Fire request
    fireDebuggerEvent(1, 'Network.requestWillBeSent', {
      request: { method: 'GET', url: 'https://api.com/data' },
    });

    // Fire response for that request
    fireDebuggerEvent(1, 'Network.responseReceived', {
      response: { url: 'https://api.com/data', status: 200, mimeType: 'application/json' },
    });

    expect(session.networkRequests[0].status).toBe(200);
    expect(session.networkRequests[0].type).toBe('application/json');
  });

  it('debugger events: ignores events with null tabId', () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;
    const prevLen = session.consoleLogs.length;

    // Fire event with undefined tabId via the onEvent listeners
    for (const listener of debuggerOnEventListeners) {
      listener({ tabId: undefined }, 'Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ value: 'should be ignored' }],
      });
    }

    expect(session.consoleLogs.length).toBe(prevLen);
  });

  it('debugger events: ignores events for non-existing sessions', () => {
    // Fire event for tab 999 which has no session
    fireDebuggerEvent(999, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: 'no session' }],
    });
    // Should not throw
    expect(mod.sessions.has(999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// walkNode — additional edge cases
// ---------------------------------------------------------------------------
describe('walkNode — additional edge cases', () => {
  const makeCtx = (): SnapshotContext => ({
    refCounter: 0,
    nodeCount: 0,
    refMap: new Map(),
    lines: [],
  });

  const makeNode = (overrides: Partial<CDPNode>): CDPNode => ({
    nodeId: 1,
    backendNodeId: 1,
    nodeType: 1,
    nodeName: 'DIV',
    children: [],
    ...overrides,
  });

  it('stops after MAX_NODES', () => {
    const ctx = makeCtx();
    // Create a tree with many children
    const children: CDPNode[] = [];
    for (let i = 0; i < 100; i++) {
      children.push(
        makeNode({
          nodeId: i + 10,
          backendNodeId: i + 10,
          nodeName: 'P',
          children: [
            {
              nodeId: i + 1000,
              backendNodeId: i + 1000,
              nodeType: 3,
              nodeName: '#text',
              nodeValue: `Text ${i}`,
            } as CDPNode,
          ],
        }),
      );
    }
    // Artificially set nodeCount close to max
    ctx.nodeCount = mod.MAX_NODES - 5;

    const root = makeNode({ nodeName: 'DIV', children });
    mod.walkNode(root, 0, ctx);
    // Should have stopped early
    expect(ctx.nodeCount).toBeLessThanOrEqual(mod.MAX_NODES + 10); // small margin
  });

  it('walks contentDocument inside same-origin iframe', () => {
    const ctx = makeCtx();
    const iframe = makeNode({
      nodeId: 2,
      backendNodeId: 2,
      nodeName: 'IFRAME',
      attributes: ['src', 'about:blank'],
      contentDocument: makeNode({
        nodeId: 100,
        backendNodeId: 100,
        nodeType: 9,
        nodeName: '#document',
        children: [
          makeNode({
            nodeId: 101,
            backendNodeId: 101,
            nodeName: 'P',
            children: [
              {
                nodeId: 102,
                backendNodeId: 102,
                nodeType: 3,
                nodeName: '#text',
                nodeValue: 'Inside iframe',
              } as CDPNode,
            ],
          }),
        ],
      }),
    });

    mod.walkNode(iframe, 0, ctx);
    const output = ctx.lines.join('\n');
    expect(output).toContain('[iframe]');
    expect(output).toContain('Inside iframe');
  });

  it('empty text nodes are skipped', () => {
    const ctx = makeCtx();
    const root = makeNode({
      nodeName: 'DIV',
      children: [
        {
          nodeId: 2,
          backendNodeId: 2,
          nodeType: 3,
          nodeName: '#text',
          nodeValue: '   ',
        } as CDPNode,
      ],
    });
    mod.walkNode(root, 0, ctx);
    // The empty whitespace text should be trimmed to nothing and skipped
    expect(ctx.lines).toHaveLength(0);
  });

  it('nested interactive children inside interactive parent are walked', () => {
    const ctx = makeCtx();
    const root = makeNode({
      nodeName: 'BUTTON',
      nodeId: 2,
      backendNodeId: 2,
      children: [
        makeNode({
          nodeId: 3,
          backendNodeId: 3,
          nodeName: 'A',
          attributes: ['href', '/inner'],
          children: [
            {
              nodeId: 4,
              backendNodeId: 4,
              nodeType: 3,
              nodeName: '#text',
              nodeValue: 'Inner Link',
            } as CDPNode,
          ],
        }),
      ],
    });

    mod.walkNode(root, 0, ctx);
    expect(ctx.refCounter).toBe(2);
    const output = ctx.lines.join('\n');
    expect(output).toContain('[1] button');
    expect(output).toContain('[2] link "Inner Link"');
  });

  it('structural tag with no children is not emitted', () => {
    const ctx = makeCtx();
    const root = makeNode({
      nodeName: 'DIV',
      children: [
        makeNode({
          nodeId: 2,
          backendNodeId: 2,
          nodeName: 'SECTION',
          children: [],
        }),
      ],
    });
    mod.walkNode(root, 0, ctx);
    const output = ctx.lines.join('\n');
    expect(output).not.toContain('[section]');
  });

  it('unknown element type walks children at same depth', () => {
    const ctx = makeCtx();
    const root = makeNode({
      nodeName: 'CUSTOM-ELEMENT',
      nodeType: 1,
      children: [
        makeNode({
          nodeId: 2,
          backendNodeId: 2,
          nodeName: 'P',
          children: [
            {
              nodeId: 3,
              backendNodeId: 3,
              nodeType: 3,
              nodeName: '#text',
              nodeValue: 'From custom',
            } as CDPNode,
          ],
        }),
      ],
    });

    mod.walkNode(root, 0, ctx);
    expect(ctx.lines.join('\n')).toContain('From custom');
  });
});

// ---------------------------------------------------------------------------
// Attach failure caching
// ---------------------------------------------------------------------------
describe('attach failure caching', () => {
  beforeEach(() => {
    mod.attachFailureCache.clear();
  });

  it('caches attach failure and returns cached error on second attempt', async () => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = { message: 'Cannot access a chrome:// URL' };
      cb();
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
    });

    // First attempt — fresh error
    const result1 = await mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs);
    expect(result1).toContain('blocks programmatic access');

    // Second attempt — should return cached error without calling attach again
    mockDebuggerAttach.mockClear();
    const result2 = await mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs);
    expect(result2).toContain('blocks programmatic access');
    // Attach should not be called again due to cache
    expect(mockDebuggerAttach).not.toHaveBeenCalled();
  });

  it('cache expires after TTL', async () => {
    // Manually insert an expired cache entry
    mod.attachFailureCache.set(1, {
      error: 'old error',
      timestamp: Date.now() - mod.ATTACH_FAILURE_TTL_MS - 1000,
      origin: 'https://test.com',
    });

    // Should try to attach again (expired)
    const result = await mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs);
    expect(mockDebuggerAttach).toHaveBeenCalled();
    // If attach succeeds, should not return cached error
    expect(result).not.toContain('cached');
  });

  it('cache cleared on debugger detach', () => {
    mod.attachFailureCache.set(10, {
      error: 'test error',
      timestamp: Date.now(),
      origin: 'https://test.com',
    });
    expect(mod.attachFailureCache.has(10)).toBe(true);

    fireDebuggerDetach(10, 'canceled_by_user');
    expect(mod.attachFailureCache.has(10)).toBe(false);
  });

  it('cache cleared when tab is removed', () => {
    mod.attachFailureCache.set(42, {
      error: 'test error',
      timestamp: Date.now(),
      origin: 'https://test.com',
    });
    expect(mod.attachFailureCache.has(42)).toBe(true);

    // Fire tab removed
    for (const listener of tabsOnRemovedListeners) {
      listener(42);
    }
    expect(mod.attachFailureCache.has(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot truncation
// ---------------------------------------------------------------------------
describe('snapshot truncation', () => {
  it('truncates snapshots exceeding MAX_RESULT_CHARS', async () => {
    // Pre-attach the session to avoid attach flow
    const session = mod.getOrCreateSession(1);
    session.attached = true;

    // Create a DOM that produces a very large snapshot
    const manyNodes: CDPNode[] = [];
    for (let i = 0; i < 500; i++) {
      manyNodes.push({
        nodeId: 100 + i,
        backendNodeId: 100 + i,
        nodeType: 1,
        nodeName: 'P',
        children: [
          {
            nodeId: 10000 + i,
            backendNodeId: 10000 + i,
            nodeType: 3,
            nodeName: '#text',
            nodeValue: 'A'.repeat(80),
          } as CDPNode,
        ],
      } as CDPNode);
    }

    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'DOM.getDocument') {
          cb({
            root: {
              nodeId: 1,
              backendNodeId: 1,
              nodeType: 9,
              nodeName: '#document',
              children: [
                {
                  nodeId: 2,
                  backendNodeId: 2,
                  nodeType: 1,
                  nodeName: 'HTML',
                  children: [
                    {
                      nodeId: 3,
                      backendNodeId: 3,
                      nodeType: 1,
                      nodeName: 'BODY',
                      children: manyNodes,
                    },
                  ],
                },
              ],
            },
          });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs);
    expect(typeof result).toBe('string');
    // The result should be truncated
    expect(result.length).toBeLessThanOrEqual(mod.MAX_RESULT_CHARS + 200); // +200 for truncation message
    expect(result).toContain('Snapshot truncated at 30000 chars');
    expect(result).toContain('evaluate action');
  });

  it('appends minimal content hint when page has very little text', async () => {
    // Pre-attach the session to avoid attach flow
    const session = mod.getOrCreateSession(1);
    session.attached = true;

    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'DOM.getDocument') {
          cb({
            root: {
              nodeId: 1,
              backendNodeId: 1,
              nodeType: 9,
              nodeName: '#document',
              children: [
                {
                  nodeId: 2,
                  backendNodeId: 2,
                  nodeType: 1,
                  nodeName: 'HTML',
                  children: [
                    {
                      nodeId: 3,
                      backendNodeId: 3,
                      nodeType: 1,
                      nodeName: 'BODY',
                      children: [],
                    },
                  ],
                },
              ],
            },
          });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs);
    expect(result).toContain('very little visible content');
    expect(result).toContain('asking the user to describe the page content');
  });
});

// ---------------------------------------------------------------------------
// SPA hash route detection
// ---------------------------------------------------------------------------
describe('isSpaHashRoute', () => {
  it('detects hash-based SPA routes', () => {
    expect(mod.isSpaHashRoute('https://analytics.google.com/#/report')).toBe(true);
    expect(mod.isSpaHashRoute('https://app.example.com/#!/dashboard')).toBe(true);
  });

  it('returns false for normal URLs and plain hash fragments', () => {
    expect(mod.isSpaHashRoute('https://example.com/page')).toBe(false);
    expect(mod.isSpaHashRoute('https://example.com/page#anchor')).toBe(false);
    expect(mod.isSpaHashRoute('https://example.com/page#!important')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// waitForLoad timeout behavior
// ---------------------------------------------------------------------------
describe('waitForLoad timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects when page load event never fires', async () => {
    // Ensure attach succeeds
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.navigate') {
          // Do NOT fire any load event
          cb({});
        } else {
          cb({});
        }
      },
    );

    const navigatePromise = mod.executeBrowser({
      action: 'navigate',
      tabId: 1,
      url: 'https://slow-site.example.com',
    } as BrowserArgs);

    // Advance past the 15s timeout
    await vi.advanceTimersByTimeAsync(16000);

    const result = await navigatePromise;
    expect(result).toContain('Page load timed out');
  });

  it('resolves when Page.frameStoppedLoading fires', async () => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.navigate') {
          // Fire frameStoppedLoading shortly after
          setTimeout(() => {
            fireDebuggerEvent(1, 'Page.frameStoppedLoading', {});
          }, 100);
          cb({});
        } else {
          cb({});
        }
      },
    );

    const navigatePromise = mod.executeBrowser({
      action: 'navigate',
      tabId: 1,
      url: 'https://example.com',
    } as BrowserArgs);

    await vi.advanceTimersByTimeAsync(200);

    const result = await navigatePromise;
    expect(result).toContain('Navigated tab [1]');
  });
});

// ---------------------------------------------------------------------------
// waitForNetworkIdle behavior
// ---------------------------------------------------------------------------
describe('waitForNetworkIdle behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after quiet period with no network activity (SPA nav)', async () => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.navigate') {
          // Don't fire Page.loadEventFired — let networkIdle win the race
          cb({});
        } else {
          cb({});
        }
      },
    );

    const navigatePromise = mod.executeBrowser({
      action: 'navigate',
      tabId: 1,
      url: 'https://app.example.com/#/dashboard',
    } as BrowserArgs);

    // Advance past quiet period (1000ms) + some margin
    await vi.advanceTimersByTimeAsync(2000);

    const result = await navigatePromise;
    expect(result).toContain('Navigated tab [1]');
  });

  it('resolves on maxMs even with in-flight requests', async () => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.navigate') {
          // Keep firing requests continuously
          const interval = setInterval(() => {
            fireDebuggerEvent(1, 'Network.requestWillBeSent', {
              request: { method: 'GET', url: 'https://api.example.com/poll' },
            });
          }, 500);
          // Clear after maxMs
          setTimeout(() => clearInterval(interval), 11000);
          cb({});
        } else {
          cb({});
        }
      },
    );

    const navigatePromise = mod.executeBrowser({
      action: 'navigate',
      tabId: 1,
      url: 'https://app.example.com/#/realtime',
    } as BrowserArgs);

    // Advance past maxMs (10000ms)
    await vi.advanceTimersByTimeAsync(11000);

    const result = await navigatePromise;
    expect(result).toContain('Navigated tab [1]');
  });
});

// ---------------------------------------------------------------------------
// getTabOrigin — indirect via attach failure cache
// ---------------------------------------------------------------------------
describe('getTabOrigin — indirect via attach failure cache', () => {
  beforeEach(() => {
    mod.attachFailureCache.clear();
  });

  it('caches attach failure with correct tab origin', async () => {
    mockTabsGet.mockResolvedValueOnce({
      id: 1,
      title: 'Test',
      url: 'https://restricted.example.com/page',
    } as chrome.tabs.Tab);

    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = { message: 'Cannot access this tab' };
      cb();
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
    });

    await mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs);

    const cached = mod.attachFailureCache.get(1);
    expect(cached).toBeDefined();
    expect(cached!.origin).toBe('https://restricted.example.com');
  });

  it('uses empty origin when tabs.get rejects', async () => {
    mockTabsGet.mockRejectedValueOnce(new Error('No such tab'));

    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = { message: 'Cannot access this tab' };
      cb();
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
    });

    await mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs);

    const cached = mod.attachFailureCache.get(1);
    expect(cached).toBeDefined();
    expect(cached!.origin).toBe('');
  });
});

// ---------------------------------------------------------------------------
// ensureTabActive — indirect via action handlers
// ---------------------------------------------------------------------------
describe('ensureTabActive — indirect via action handlers', () => {
  it('calls chrome.tabs.update with active:true during type', async () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;
    session.refMap.set(1, { nodeId: 5, backendNodeId: 5 });

    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'DOM.resolveNode') {
          cb({ object: { objectId: 'obj-1' } });
        } else {
          cb({});
        }
      },
    );

    await mod.executeBrowser({
      action: 'type',
      tabId: 1,
      ref: 1,
      text: 'hello',
    } as BrowserArgs);

    expect(mockTabsUpdate).toHaveBeenCalledWith(1, { active: true });
  });

  it('calls chrome.tabs.update during navigate with active option', async () => {
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.navigate') {
          setTimeout(() => fireDebuggerEvent(1, 'Page.loadEventFired', {}), 10);
        }
        cb({});
      },
    );

    await mod.executeBrowser({
      action: 'navigate',
      tabId: 1,
      url: 'https://example.com',
      active: true,
    } as BrowserArgs);

    expect(mockTabsUpdate).toHaveBeenCalledWith(1, { active: true });
  });
});

// ---------------------------------------------------------------------------
// Concurrent attach attempts
// ---------------------------------------------------------------------------
describe('concurrent attach attempts', () => {
  beforeEach(() => {
    mod.attachFailureCache.clear();
    // Ensure attach succeeds
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
  });

  it('serializes concurrent attach calls to same tab', async () => {
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'DOM.getDocument') {
          cb({
            root: {
              nodeId: 1,
              backendNodeId: 1,
              nodeType: 9,
              nodeName: '#document',
              children: [],
            },
          });
        } else {
          cb({});
        }
      },
    );

    const [result1, result2] = await Promise.all([
      mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs),
      mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs),
    ]);

    expect(result1).toContain('[page]');
    expect(result2).toContain('[page]');
    // Attach should only be called once for the same tab
    expect(mockDebuggerAttach).toHaveBeenCalledTimes(1);
  });

  it('allows parallel attach to different tabs', async () => {
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'DOM.getDocument') {
          cb({
            root: {
              nodeId: 1,
              backendNodeId: 1,
              nodeType: 9,
              nodeName: '#document',
              children: [],
            },
          });
        } else {
          cb({});
        }
      },
    );

    await Promise.all([
      mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs),
      mod.executeBrowser({ action: 'snapshot', tabId: 2 } as BrowserArgs),
    ]);

    expect(mockDebuggerAttach).toHaveBeenCalledTimes(2);
  });

  it('propagates attach error to all concurrent callers', async () => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = { message: 'Cannot access a chrome:// URL' };
      cb();
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
    });

    const [result1, result2] = await Promise.all([
      mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs),
      mod.executeBrowser({ action: 'snapshot', tabId: 1 } as BrowserArgs),
    ]);

    expect(result1).toContain('blocks programmatic access');
    expect(result2).toContain('blocks programmatic access');
  });
});

// ---------------------------------------------------------------------------
// Navigate with DNS/network failures
// ---------------------------------------------------------------------------
describe('navigate with DNS/network failures', () => {
  beforeEach(() => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
  });

  it('returns error for net::ERR_NAME_NOT_RESOLVED', async () => {
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.navigate') {
          cb({ errorText: 'net::ERR_NAME_NOT_RESOLVED' });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({
      action: 'navigate',
      tabId: 1,
      url: 'https://doesnotexist.example',
    } as BrowserArgs);
    expect(result).toContain('Navigation failed');
    expect(result).toContain('ERR_NAME_NOT_RESOLVED');
  });

  it('returns error for net::ERR_CONNECTION_REFUSED', async () => {
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.navigate') {
          cb({ errorText: 'net::ERR_CONNECTION_REFUSED' });
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({
      action: 'navigate',
      tabId: 1,
      url: 'https://localhost:9999',
    } as BrowserArgs);
    expect(result).toContain('Navigation failed');
    expect(result).toContain('ERR_CONNECTION_REFUSED');
  });

  it('clears refMap on navigation', async () => {
    const session = mod.getOrCreateSession(1);
    session.attached = true;
    session.refMap.set(1, { nodeId: 5, backendNodeId: 5 });
    session.refMap.set(2, { nodeId: 6, backendNodeId: 6 });

    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.navigate') {
          cb({ errorText: 'net::ERR_CONNECTION_REFUSED' });
        } else {
          cb({});
        }
      },
    );

    await mod.executeBrowser({
      action: 'navigate',
      tabId: 1,
      url: 'https://localhost:9999',
    } as BrowserArgs);

    expect(session.refMap.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Screenshot fullPage edge cases
// ---------------------------------------------------------------------------
describe('screenshot fullPage edge cases', () => {
  beforeEach(() => {
    mockDebuggerAttach.mockImplementation((_target: unknown, _version: string, cb: () => void) => {
      chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      cb();
    });
  });

  it('sets device metrics to content dimensions', async () => {
    let metricsParams: Record<string, unknown> | null = null;
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, params: unknown, cb: (result: unknown) => void) => {
        if (method === 'Page.getLayoutMetrics') {
          cb({ contentSize: { width: 1440, height: 8000 } });
        } else if (method === 'Emulation.setDeviceMetricsOverride') {
          metricsParams = params as Record<string, unknown>;
          cb({});
        } else if (method === 'Page.captureScreenshot') {
          cb({ data: 'base64data' });
        } else {
          cb({});
        }
      },
    );

    await mod.executeBrowser({
      action: 'screenshot',
      tabId: 1,
      fullPage: true,
    } as BrowserArgs);

    expect(metricsParams).not.toBeNull();
    expect(metricsParams!.width).toBe(1440);
    expect(metricsParams!.height).toBe(8000);
    expect(metricsParams!.deviceScaleFactor).toBe(1);
  });

  it('restores device metrics after successful capture', async () => {
    const calledMethods: string[] = [];
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        calledMethods.push(method);
        if (method === 'Page.getLayoutMetrics') {
          cb({ contentSize: { width: 800, height: 3000 } });
        } else if (method === 'Page.captureScreenshot') {
          cb({ data: 'base64data' });
        } else {
          cb({});
        }
      },
    );

    await mod.executeBrowser({
      action: 'screenshot',
      tabId: 1,
      fullPage: true,
    } as BrowserArgs);

    const clearIdx = calledMethods.lastIndexOf('Emulation.clearDeviceMetricsOverride');
    const captureIdx = calledMethods.lastIndexOf('Page.captureScreenshot');
    expect(clearIdx).toBeGreaterThan(captureIdx);
  });

  it('restores device metrics when capture throws', async () => {
    const calledMethods: string[] = [];
    mockDebuggerSendCommand.mockImplementation(
      (_target: unknown, method: string, _params: unknown, cb: (result: unknown) => void) => {
        calledMethods.push(method);
        if (method === 'Page.getLayoutMetrics') {
          cb({ contentSize: { width: 800, height: 3000 } });
        } else if (method === 'Page.captureScreenshot') {
          throw new Error('Capture failed');
        } else {
          cb({});
        }
      },
    );

    const result = await mod.executeBrowser({
      action: 'screenshot',
      tabId: 1,
      fullPage: true,
    } as BrowserArgs);

    // Should have tried to clear metrics even after failure
    expect(calledMethods).toContain('Emulation.clearDeviceMetricsOverride');
    expect(result).toContain('Error');
  });
});

// ---------------------------------------------------------------------------
// collectTextContent
// ---------------------------------------------------------------------------
describe('collectTextContent', () => {
  it('collects only direct text children', () => {
    const node: CDPNode = {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 1,
      nodeName: 'BUTTON',
      children: [
        { nodeId: 2, backendNodeId: 2, nodeType: 3, nodeName: '#text', nodeValue: 'Click ' } as CDPNode,
        {
          nodeId: 3,
          backendNodeId: 3,
          nodeType: 1,
          nodeName: 'SPAN',
          children: [
            { nodeId: 4, backendNodeId: 4, nodeType: 3, nodeName: '#text', nodeValue: 'here' } as CDPNode,
          ],
        } as CDPNode,
      ],
    };

    const text = mod.collectTextContent(node);
    expect(text).toBe('Click ');
    expect(text).not.toContain('here');
  });

  it('returns empty string for element with no text nodes', () => {
    const node: CDPNode = {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 1,
      nodeName: 'BUTTON',
      children: [
        {
          nodeId: 2,
          backendNodeId: 2,
          nodeType: 1,
          nodeName: 'SVG',
          children: [],
        } as CDPNode,
      ],
    };

    const text = mod.collectTextContent(node);
    expect(text).toBe('');
  });

  it('returns nodeValue for text nodes', () => {
    const textNode: CDPNode = {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 3,
      nodeName: '#text',
      nodeValue: 'Hello world',
    };

    const text = mod.collectTextContent(textNode);
    expect(text).toBe('Hello world');
  });
});

// ---------------------------------------------------------------------------
// Empty/malformed DOM in snapshot
// ---------------------------------------------------------------------------
describe('empty/malformed DOM in snapshot', () => {
  const makeCtx = (): SnapshotContext => ({
    refCounter: 0,
    nodeCount: 0,
    refMap: new Map(),
    lines: [],
  });

  it('handles document with no children', () => {
    const ctx = makeCtx();
    const root: CDPNode = {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [],
    };

    mod.walkNode(root, 0, ctx);
    expect(ctx.lines).toHaveLength(0);
    expect(ctx.nodeCount).toBeGreaterThanOrEqual(0);
  });

  it('handles node with undefined children', () => {
    const ctx = makeCtx();
    const root: CDPNode = {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: undefined,
    };

    // Should not throw
    mod.walkNode(root, 0, ctx);
    expect(ctx.lines).toHaveLength(0);
  });

  it('walks into iframe contentDocument', () => {
    const ctx = makeCtx();
    const iframe: CDPNode = {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 1,
      nodeName: 'IFRAME',
      attributes: ['src', 'about:blank'],
      children: [],
      contentDocument: {
        nodeId: 10,
        backendNodeId: 10,
        nodeType: 9,
        nodeName: '#document',
        children: [
          {
            nodeId: 11,
            backendNodeId: 11,
            nodeType: 1,
            nodeName: 'P',
            children: [
              {
                nodeId: 12,
                backendNodeId: 12,
                nodeType: 3,
                nodeName: '#text',
                nodeValue: 'Iframe content here',
              } as CDPNode,
            ],
          } as CDPNode,
        ],
      },
    };

    mod.walkNode(iframe, 0, ctx);
    const output = ctx.lines.join('\n');
    expect(output).toContain('[iframe]');
    expect(output).toContain('Iframe content here');
  });
});

// ---------------------------------------------------------------------------
// browserToolDef.formatResult
// ---------------------------------------------------------------------------
describe('browserToolDef.formatResult', () => {
  // Import browserToolDef lazily since mod is re-imported on each test
  it('formats ScreenshotResult as image content block', async () => {
    const { browserToolDef } = mod;
    const screenshotResult = {
      __type: 'screenshot' as const,
      base64: 'iVBORw0KGgoAAAA',
      mimeType: 'image/png',
      width: 100,
      height: 100,
    };

    const formatted = browserToolDef.formatResult!(screenshotResult);
    expect(formatted.content).toHaveLength(2);
    expect(formatted.content[0].type).toBe('text');
    expect(formatted.content[0].text).toContain('100\u00d7100');
    expect(formatted.content[1].type).toBe('image');
    expect(formatted.content[1].data).toBe('iVBORw0KGgoAAAA');
    expect(formatted.content[1].mimeType).toBe('image/png');
  });

  it('formats plain string as text content block', () => {
    const { browserToolDef } = mod;
    const result = browserToolDef.formatResult!('Open tabs (2):\n[1] Tab One');

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('Open tabs (2):\n[1] Tab One');
  });
});
