// eslint-disable-next-line import-x/order -- vitest must be imported first for vi.mock hoisting
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Chrome API mocks — must be set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

const SANDBOX_TAB_ID = 999;

// In Node.js, `window` is not defined but the console capture code uses it.
// Set window = globalThis so `window.__cc`, `window.__cl`, `window.__modules` work.
(globalThis as any).window = globalThis;

const tabsOnRemovedListeners: Array<(tabId: number) => void> = [];

/**
 * CDP mock: for Runtime.evaluate, delegate to `new Function()` in Node.js
 * so existing test expectations (e.g. `expect(result).toBe('4')`) still pass.
 */
const mockDebuggerSendCommand = vi.fn(
  (
    _target: unknown,
    method: string,
    params: Record<string, unknown> | undefined,
    cb: (result: unknown) => void,
  ) => {
    if (method === 'Runtime.enable') {
      cb({});
      return;
    }
    if (method === 'Runtime.evaluate' && params?.expression) {
      const expression = params.expression as string;
      // Execute the expression via new Function in Node.js
      const fn = new Function(
        `return (async () => { return ${expression} })()`,
      ) as () => Promise<unknown>;
      fn()
        .then(value => {
          if (value === undefined) {
            cb({ result: { type: 'undefined' } });
          } else if (value === null) {
            cb({ result: { type: 'object', subtype: 'null', value: null } });
          } else {
            cb({ result: { type: typeof value, value } });
          }
        })
        .catch((err: Error) => {
          cb({
            result: { type: 'object' },
            exceptionDetails: {
              text: err.message,
              exception: { description: err.message },
            },
          });
        });
      return;
    }
    cb({});
  },
);

const mockDebuggerAttach = vi.fn((_target: unknown, _version: string, cb: () => void) => cb());
const mockDebuggerDetach = vi.fn((_target: unknown, cb: () => void) => cb());

const mockTabsCreate = vi.fn(() => Promise.resolve({ id: SANDBOX_TAB_ID } as chrome.tabs.Tab));
const mockTabsGet = vi.fn(() => Promise.resolve({ id: SANDBOX_TAB_ID } as chrome.tabs.Tab));
const mockTabsRemove = vi.fn(() => Promise.resolve());
const mockTabsQuery = vi.fn(() => Promise.resolve([] as chrome.tabs.Tab[]));

Object.defineProperty(globalThis, 'chrome', {
  value: {
    debugger: {
      attach: mockDebuggerAttach,
      detach: mockDebuggerDetach,
      sendCommand: mockDebuggerSendCommand,
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      create: mockTabsCreate,
      get: mockTabsGet,
      remove: mockTabsRemove,
      query: mockTabsQuery,
      onRemoved: {
        addListener: (fn: (tabId: number) => void) => {
          tabsOnRemovedListeners.push(fn);
        },
      },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
      lastError: undefined as { message: string } | undefined,
    },
  },
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Now import the modules under test (after chrome mocks are set up)
// ---------------------------------------------------------------------------

/* eslint-disable import-x/first -- imports must come after chrome mock setup */
import { chatDb } from '@storage-internal/chat-db';
import {
  createAgent,
  getAgent,
  createWorkspaceFile,
} from '@storage-internal/chat-storage';
import {
  executeJs,
  executeCode,
  parseToolMetadata,
  maybeAutoReturn,
  stripLeadingComments,
  _resetSandbox,
} from './execute-js';
import type { AgentConfig } from '@storage-internal/chat-db';
/* eslint-enable import-x/first */

// Mock activeAgentStorage to return 'test-agent'
vi.mock('@extension/storage', async () => {
  const actual = await vi.importActual('../../../../packages/storage/lib/index.ts');
  return {
    ...actual,
    activeAgentStorage: {
      get: vi.fn().mockResolvedValue('test-agent'),
      set: vi.fn(),
      getSnapshot: vi.fn(),
      subscribe: vi.fn(),
    },
  };
});

const TEST_AGENT_ID = 'test-agent';

const seedTestAgent = async (): Promise<void> => {
  const now = Date.now();
  const agent: AgentConfig = {
    id: TEST_AGENT_ID,
    name: 'Test Agent',
    identity: { emoji: '' },
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  };
  await createAgent(agent);
};

beforeEach(async () => {
  await chatDb.agents.clear();
  await chatDb.workspaceFiles.clear();
  await seedTestAgent();
  _resetSandbox();
  vi.clearAllMocks();

  // Clean up globals set by console capture and module registry
  delete (globalThis as any).__cc;
  delete (globalThis as any).__cl;
  delete (globalThis as any).__modules;
});

// ── executeCode ─────────────────────────────────

describe('executeCode', () => {
  it('executes simple JS and returns result', async () => {
    const result = await executeCode('return 2 + 2');
    expect(result).toBe('4');
  });

  it('handles string results directly', async () => {
    const result = await executeCode('return "hello world"');
    expect(result).toBe('hello world');
  });

  it('serializes objects to JSON', async () => {
    const result = await executeCode('return { a: 1, b: "two" }');
    expect(JSON.parse(result)).toEqual({ a: 1, b: 'two' });
  });

  it('executes async code', async () => {
    const result = await executeCode(
      'const p = new Promise(r => setTimeout(() => r(42), 10)); return await p;',
    );
    expect(result).toBe('42');
  });

  it('passes arguments correctly', async () => {
    const result = await executeCode('return args.x + args.y', { x: 10, y: 20 });
    expect(result).toBe('30');
  });

  it('handles undefined return (no return statement)', async () => {
    const result = await executeCode('const x = 1;');
    expect(result).toBe('undefined');
  });

  it('handles null return', async () => {
    const result = await executeCode('return null');
    expect(result).toBe('null');
  });

  it('returns error message on exception', async () => {
    await expect(executeCode('throw new Error("boom")')).rejects.toThrow('boom');
  });
});

// ── Sandbox tab lifecycle ───────────────────────

describe('sandbox tab lifecycle', () => {
  it('creates sandbox tab on first call', async () => {
    await executeCode('return 1');
    expect(mockTabsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('sandbox.html'), active: false }),
    );
    expect(mockDebuggerAttach).toHaveBeenCalled();
  });

  it('reuses sandbox tab on subsequent calls', async () => {
    await executeCode('return 1');
    await executeCode('return 2');
    // Only one tab.create call
    expect(mockTabsCreate).toHaveBeenCalledTimes(1);
  });

  it('creates new sandbox tab if previous one was closed', async () => {
    await executeCode('return 1');
    expect(mockTabsCreate).toHaveBeenCalledTimes(1);

    // Simulate tab closed: tabs.get rejects once, then succeeds
    mockTabsGet.mockRejectedValueOnce(new Error('No tab with id'));

    await executeCode('return 3');
    expect(mockTabsCreate).toHaveBeenCalledTimes(2);
  });

  it('handles CDP attach error', async () => {
    // Make tabs.query return no orphans so it falls through to create
    mockTabsQuery.mockResolvedValueOnce([]);
    mockDebuggerAttach.mockImplementationOnce(
      (_target: unknown, _version: string, cb: () => void) => {
        chrome.runtime.lastError = {
          message: 'Cannot access tab',
        } as typeof chrome.runtime.lastError;
        cb();
        chrome.runtime.lastError = undefined as unknown as typeof chrome.runtime.lastError;
      },
    );

    // Reset sandbox state by simulating tab removal
    for (const listener of tabsOnRemovedListeners) {
      listener(SANDBOX_TAB_ID);
    }

    await expect(executeCode('return 1')).rejects.toThrow('Cannot access tab');
  });

  it('reuses orphan sandbox tab from previous SW lifecycle', async () => {
    const ORPHAN_TAB_ID = 777;
    // Return an existing sandbox tab from tabs.query
    mockTabsQuery.mockResolvedValueOnce([{ id: ORPHAN_TAB_ID } as chrome.tabs.Tab]);

    await executeCode('return 42');

    // Should NOT have called tabs.create since it reused the orphan
    expect(mockTabsCreate).not.toHaveBeenCalled();
    // Should have attached to the orphan tab
    expect(mockDebuggerAttach).toHaveBeenCalledWith(
      { tabId: ORPHAN_TAB_ID },
      '1.3',
      expect.any(Function),
    );
  });
});

// ── parseToolMetadata ───────────────────────────

describe('parseToolMetadata', () => {
  it('parses all fields correctly', () => {
    const content = `// @tool fetch_data
// @description Fetch data from an API
// @param url string "The URL to fetch"
// @param count number "Number of results"

const response = await fetch(url);
return await response.json();`;

    const result = parseToolMetadata(content, 'tools/fetch.js');
    expect(result).toEqual({
      name: 'fetch_data',
      description: 'Fetch data from an API',
      params: [
        { name: 'url', type: 'string', description: 'The URL to fetch' },
        { name: 'count', type: 'number', description: 'Number of results' },
      ],
      path: 'tools/fetch.js',
    });
  });

  it('returns error when @tool is missing', () => {
    const content = `// @description A tool without a name
// @param x number "A number"
return x;`;

    const result = parseToolMetadata(content, 'tools/bad.js');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('@tool');
  });

  it('returns error when @description is missing', () => {
    const content = `// @tool no_desc
// @param x number "A number"
return x;`;

    const result = parseToolMetadata(content, 'tools/bad.js');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('@description');
  });

  it('handles tool with no params', () => {
    const content = `// @tool simple_tool
// @description A simple tool with no params
return "done";`;

    const result = parseToolMetadata(content, 'tools/simple.js');
    expect(result).toEqual({
      name: 'simple_tool',
      description: 'A simple tool with no params',
      params: [],
      path: 'tools/simple.js',
    });
  });

  it('ignores non-metadata comments', () => {
    const content = `// @tool my_tool
// @description My tool
// This is a regular comment
// @param x string "Input"
// Another comment
return x;`;

    const result = parseToolMetadata(content, 'tools/t.js');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.params).toHaveLength(1);
    }
  });

  it('parses single @prompt line into promptHint', () => {
    const content = `// @tool my_tool
// @description A tool
// @prompt Use this tool when the user asks about data analysis.
return "ok";`;

    const result = parseToolMetadata(content, 'tools/t.js');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.promptHint).toBe('Use this tool when the user asks about data analysis.');
    }
  });

  it('joins multiple @prompt lines with newlines', () => {
    const content = `// @tool my_tool
// @description A tool
// @prompt Use this tool for data analysis.
// @prompt Provide results in markdown tables.
return "ok";`;

    const result = parseToolMetadata(content, 'tools/t.js');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.promptHint).toBe(
        'Use this tool for data analysis.\nProvide results in markdown tables.',
      );
    }
  });

  it('omits promptHint when no @prompt lines', () => {
    const content = `// @tool my_tool
// @description A tool
return "ok";`;

    const result = parseToolMetadata(content, 'tools/t.js');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.promptHint).toBeUndefined();
    }
  });
});

// ── executeJs — execute action ───────────────

describe('executeJs — execute', () => {
  it('executes inline code', async () => {
    const result = await executeJs({ action: 'execute', code: 'return 2 + 2' });
    expect(result).toBe('4');
  });

  it('returns error on exception', async () => {
    const result = await executeJs({
      action: 'execute',
      code: 'throw new Error("test error")',
    });
    expect(result).toContain('Error');
    expect(result).toContain('test error');
  });

  it('returns error when neither code nor path provided', async () => {
    const result = await executeJs({ action: 'execute' });
    expect(result).toContain('Error');
    expect(result).toContain('code');
  });

  it('executes workspace file by path', async () => {
    const now = Date.now();
    await createWorkspaceFile({
      id: 'ws-script-1',
      name: 'tools/add.js',
      content: 'return args.a + args.b',
      enabled: true,
      owner: 'agent',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId: TEST_AGENT_ID,
    });

    const result = await executeJs({
      action: 'execute',
      path: 'tools/add.js',
      args: { a: 3, b: 4 },
    });
    expect(result).toBe('7');
  });

  it('returns error when workspace file not found', async () => {
    const result = await executeJs({
      action: 'execute',
      path: 'tools/nonexistent.js',
    });
    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });
});

// ── executeJs — register action ──────────────

describe('executeJs — register', () => {
  it('parses metadata and saves to agent config', async () => {
    const now = Date.now();
    await createWorkspaceFile({
      id: 'ws-tool-reg',
      name: 'tools/greet.js',
      content: `// @tool greet
// @description Greet someone
// @param name string "Person to greet"
return "Hello, " + name + "!";`,
      enabled: true,
      owner: 'agent',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId: TEST_AGENT_ID,
    });

    const result = await executeJs({ action: 'register', path: 'tools/greet.js' });
    expect(result).toContain('Registered');
    expect(result).toContain('greet');
    expect(result).toContain('1 params');

    // Verify agent config was updated
    const agent = await getAgent(TEST_AGENT_ID);
    expect(agent?.customTools).toHaveLength(1);
    expect(agent?.customTools?.[0].name).toBe('greet');
    expect(agent?.customTools?.[0].path).toBe('tools/greet.js');
    expect(agent?.toolConfig?.enabledTools['greet']).toBe(true);
  });

  it('rejects invalid metadata (missing @tool)', async () => {
    const now = Date.now();
    await createWorkspaceFile({
      id: 'ws-tool-bad',
      name: 'tools/bad.js',
      content: `// No tool metadata here
return "nothing"`,
      enabled: true,
      owner: 'agent',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId: TEST_AGENT_ID,
    });

    const result = await executeJs({ action: 'register', path: 'tools/bad.js' });
    expect(result).toContain('Error');
    expect(result).toContain('@tool');
  });

  it('returns error when path not provided', async () => {
    const result = await executeJs({ action: 'register' });
    expect(result).toContain('Error');
    expect(result).toContain('path');
  });

  it('replaces existing tool with same name', async () => {
    const now = Date.now();
    await createWorkspaceFile({
      id: 'ws-tool-v1',
      name: 'tools/calc.js',
      content: `// @tool calc
// @description Calculate v1
// @param x number "Input"
return x * 2;`,
      enabled: true,
      owner: 'agent',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId: TEST_AGENT_ID,
    });

    await executeJs({ action: 'register', path: 'tools/calc.js' });

    // Update file content
    await chatDb.workspaceFiles.update('ws-tool-v1', {
      content: `// @tool calc
// @description Calculate v2
// @param x number "Input"
// @param y number "Second input"
return x + y;`,
    });

    const result = await executeJs({ action: 'register', path: 'tools/calc.js' });
    expect(result).toContain('Registered');

    const agent = await getAgent(TEST_AGENT_ID);
    // Should still only have 1 tool (replaced, not duplicated)
    expect(agent?.customTools).toHaveLength(1);
    expect(agent?.customTools?.[0].description).toBe('Calculate v2');
    expect(agent?.customTools?.[0].params).toHaveLength(2);
  });
});

// ── executeJs — unregister action ────────────

describe('executeJs — unregister', () => {
  it('removes custom tool from agent config', async () => {
    const now = Date.now();
    await createWorkspaceFile({
      id: 'ws-tool-unreg',
      name: 'tools/temp.js',
      content: `// @tool temp_tool
// @description Temporary tool
return "temp";`,
      enabled: true,
      owner: 'agent',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId: TEST_AGENT_ID,
    });

    // Register first
    await executeJs({ action: 'register', path: 'tools/temp.js' });
    let agent = await getAgent(TEST_AGENT_ID);
    expect(agent?.customTools).toHaveLength(1);

    // Unregister by path
    const result = await executeJs({ action: 'unregister', path: 'tools/temp.js' });
    expect(result).toContain('Unregistered');
    expect(result).toContain('temp_tool');

    agent = await getAgent(TEST_AGENT_ID);
    expect(agent?.customTools).toHaveLength(0);
  });

  it('returns error when no matching tool found', async () => {
    const result = await executeJs({ action: 'unregister', path: 'tools/nonexistent.js' });
    expect(result).toContain('Error');
    expect(result).toContain('No custom tool found');
  });

  it('returns error when path not provided', async () => {
    const result = await executeJs({ action: 'unregister' });
    expect(result).toContain('Error');
    expect(result).toContain('path');
  });
});

// ── Configurable timeout ────────────────────────

describe('configurable timeout', () => {
  it('passes custom timeout to CDP Runtime.evaluate', async () => {
    await executeCode('return 42', undefined, 60000);
    // Find the main Runtime.evaluate call (not the console capture or log read ones)
    const evaluateCalls = mockDebuggerSendCommand.mock.calls.filter(
      (c: unknown[]) => c[1] === 'Runtime.evaluate' && (c[2] as any)?.awaitPromise === true,
    );
    expect(evaluateCalls.length).toBeGreaterThan(0);
    const lastCall = evaluateCalls[evaluateCalls.length - 1];
    expect((lastCall[2] as any).timeout).toBe(60000);
  });

  it('clamps timeout exceeding max to 300000', async () => {
    await executeCode('return 1', undefined, 999999);
    const evaluateCalls = mockDebuggerSendCommand.mock.calls.filter(
      (c: unknown[]) => c[1] === 'Runtime.evaluate' && (c[2] as any)?.awaitPromise === true,
    );
    const lastCall = evaluateCalls[evaluateCalls.length - 1];
    expect((lastCall[2] as any).timeout).toBe(300000);
  });

  it('uses default timeout when not specified', async () => {
    await executeCode('return 1');
    const evaluateCalls = mockDebuggerSendCommand.mock.calls.filter(
      (c: unknown[]) => c[1] === 'Runtime.evaluate' && (c[2] as any)?.awaitPromise === true,
    );
    const lastCall = evaluateCalls[evaluateCalls.length - 1];
    expect((lastCall[2] as any).timeout).toBe(30000);
  });
});

// ── Console capture ─────────────────────────────

describe('console capture', () => {
  it('captures console.log output', async () => {
    const result = await executeCode('console.log("hello"); return 42');
    expect(result).toContain('42');
    expect(result).toContain('Console Output');
    expect(result).toContain('hello');
  });

  it('captures console.warn and console.error', async () => {
    const result = await executeCode(
      'console.warn("a warning"); console.error("an error"); return "ok"',
    );
    expect(result).toContain('ok');
    expect(result).toContain('[WARN] a warning');
    expect(result).toContain('[ERROR] an error');
  });

  it('includes console output in error messages', async () => {
    const result = await executeJs({
      action: 'execute',
      code: 'console.log("step 1"); throw new Error("boom")',
    });
    expect(result).toContain('boom');
    expect(result).toContain('step 1');
    expect(result).toContain('Console Output');
  });

  it('returns clean output when no console calls', async () => {
    const result = await executeCode('return "clean"');
    expect(result).toBe('clean');
    expect(result).not.toContain('Console Output');
  });
});

// ── Module registry (exportAs) ──────────────────

describe('module registry (exportAs)', () => {
  it('stores return value on window.__modules', async () => {
    await executeCode('return { foo: 42 }', undefined, undefined, undefined, 'testMod');
    const result = await executeCode('return window.__modules.testMod.foo');
    expect(result).toContain('42');
  });

  it('subsequent executions can read exported modules', async () => {
    await executeCode('return { add: "fn" }', undefined, undefined, undefined, 'math');
    const result = await executeCode('return typeof window.__modules.math');
    expect(result).toContain('object');
  });
});

// ── Bundle action ───────────────────────────────

describe('executeJs — bundle', () => {
  it('bundles multiple files and stores as modules', async () => {
    const now = Date.now();
    await createWorkspaceFile({
      id: 'ws-bundle-a',
      name: 'bot/config.js',
      content: 'return { apiUrl: "https://example.com" }',
      enabled: true,
      owner: 'agent',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId: TEST_AGENT_ID,
    });
    await createWorkspaceFile({
      id: 'ws-bundle-b',
      name: 'bot/utils.js',
      content: 'return { double: function(x) { return x * 2; } }',
      enabled: true,
      owner: 'agent',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId: TEST_AGENT_ID,
    });

    const result = await executeJs({
      action: 'bundle',
      files: ['bot/config.js', 'bot/utils.js'],
      code: 'return Object.keys(window.__modules)',
    });

    expect(result).toContain('config');
    expect(result).toContain('utils');
  });

  it('returns error when files array is empty', async () => {
    const result = await executeJs({ action: 'bundle', files: [] });
    expect(result).toContain('Error');
    expect(result).toContain('files');
  });

  it('returns error when files not provided', async () => {
    const result = await executeJs({ action: 'bundle' } as any);
    expect(result).toContain('Error');
    expect(result).toContain('files');
  });

  it('returns error when workspace file not found', async () => {
    const result = await executeJs({
      action: 'bundle',
      files: ['nonexistent.js'],
    });
    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });

  it('derives module names from file paths', async () => {
    const now = Date.now();
    await createWorkspaceFile({
      id: 'ws-bundle-dash',
      name: 'bot/api-gamma.js',
      content: 'return "gamma"',
      enabled: true,
      owner: 'agent',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId: TEST_AGENT_ID,
    });

    const result = await executeJs({
      action: 'bundle',
      files: ['bot/api-gamma.js'],
      code: 'return Object.keys(window.__modules)',
    });

    // "api-gamma.js" → "api_gamma"
    expect(result).toContain('api_gamma');
  });
});

// ── Target tab (tabId) ──────────────────────────

describe('target tab (tabId)', () => {
  const TARGET_TAB_ID = 42;

  it('uses specified tab instead of sandbox', async () => {
    mockTabsGet.mockResolvedValueOnce({ id: TARGET_TAB_ID } as chrome.tabs.Tab);

    await executeCode('return "in-tab"', undefined, undefined, TARGET_TAB_ID);

    // Should have attached debugger to the target tab
    expect(mockDebuggerAttach).toHaveBeenCalledWith(
      { tabId: TARGET_TAB_ID },
      '1.3',
      expect.any(Function),
    );
    // Should NOT have created a sandbox tab
    expect(mockTabsCreate).not.toHaveBeenCalled();
  });

  it('throws error when tab not found', async () => {
    mockTabsGet.mockRejectedValueOnce(new Error('No tab with id'));

    await expect(
      executeCode('return 1', undefined, undefined, 12345),
    ).rejects.toThrow('Tab 12345 not found');
  });
});

// ── stripLeadingComments ────────────────────────

describe('stripLeadingComments', () => {
  it('strips single-line comments', () => {
    expect(stripLeadingComments('// hello\n(foo)()')).toBe('(foo)()');
  });

  it('strips block comments', () => {
    expect(stripLeadingComments('/* block */\n(foo)()')).toBe('(foo)()');
  });

  it('strips multiple leading comments', () => {
    expect(stripLeadingComments('// line 1\n// line 2\n/* block */\n(foo)()')).toBe('(foo)()');
  });

  it('returns code unchanged when no leading comments', () => {
    expect(stripLeadingComments('const x = 1;')).toBe('const x = 1;');
  });
});

// ── maybeAutoReturn ─────────────────────────────

describe('maybeAutoReturn', () => {
  it('prepends return to IIFE', () => {
    const code = '(() => { return { action: "test" }; })()';
    const result = maybeAutoReturn(code);
    expect(result).toBe('return (() => { return { action: "test" }; })()');
  });

  it('prepends return to IIFE with trailing semicolon', () => {
    const code = '(() => { return 42; })();';
    const result = maybeAutoReturn(code);
    expect(result).toBe('return (() => { return 42; })();');
  });

  it('preserves leading comments and inserts return correctly', () => {
    const code = '// @tool test\n(() => { return 1; })()';
    const result = maybeAutoReturn(code);
    expect(result).toBe('// @tool test\nreturn (() => { return 1; })()');
  });

  it('does NOT modify multi-statement code', () => {
    const code = 'const x = 1;\nreturn x;';
    expect(maybeAutoReturn(code)).toBe(code);
  });

  it('does NOT modify code already starting with return', () => {
    const code = 'return 42;';
    expect(maybeAutoReturn(code)).toBe(code);
  });

  it('does NOT modify code with top-level return in body', () => {
    const code = 'const x = fetch("url");\nreturn x;';
    expect(maybeAutoReturn(code)).toBe(code);
  });

  it('handles function IIFE', () => {
    const code = '(function() { return "hi"; })()';
    const result = maybeAutoReturn(code);
    expect(result).toBe('return (function() { return "hi"; })()');
  });
});

// ── Auto-return integration ─────────────────────

describe('auto-return integration', () => {
  it('workspace file with bare IIFE returns its value (not undefined)', async () => {
    const now = Date.now();
    await createWorkspaceFile({
      id: 'ws-iife-1',
      name: 'tools/iife.js',
      content: '(() => { return { action: "test" }; })()',
      enabled: true,
      owner: 'agent',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId: TEST_AGENT_ID,
    });

    const result = await executeJs({
      action: 'execute',
      path: 'tools/iife.js',
    });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ action: 'test' });
  });

  it('bundle action with IIFE files captures module values', async () => {
    const now = Date.now();
    await createWorkspaceFile({
      id: 'ws-bundle-iife',
      name: 'bot/iife-mod.js',
      content: '(() => { return { value: 99 }; })()',
      enabled: true,
      owner: 'agent',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId: TEST_AGENT_ID,
    });

    const result = await executeJs({
      action: 'bundle',
      files: ['bot/iife-mod.js'],
      code: 'return window.__modules.iife_mod',
    });

    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ value: 99 });
  });
});

// ── args always available ───────────────────────

describe('args always available', () => {
  it('args variable is available even with no args passed', async () => {
    const result = await executeCode('return typeof args');
    expect(result).toBe('object');
  });

  it('args is empty object when no args passed', async () => {
    const result = await executeCode('return JSON.stringify(args)');
    expect(result).toBe('{}');
  });

  it('args variable contains passed arguments', async () => {
    const result = await executeCode('return args.x + args.y', { x: 3, y: 7 });
    expect(result).toBe('10');
  });

  it('args variable contains all passed arguments', async () => {
    const result = await executeCode('return args.x + args.y', { x: 5, y: 15 });
    expect(result).toBe('20');
  });
});
