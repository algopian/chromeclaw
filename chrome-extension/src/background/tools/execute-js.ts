import { cdpSend, cdpAttach } from './cdp';
import { getActiveAgentId, getWorkspaceFile } from './tool-utils';
import { getAgent, updateAgent } from '@extension/storage';
import { Type } from '@sinclair/typebox';
import type { CustomToolDef } from '@extension/storage';
import type { Static } from '@sinclair/typebox';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CONSOLE_LOGS = 200;

// ── Schema ──────────────────────────────────────

const executeJsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal('execute'),
      Type.Literal('bundle'),
      Type.Literal('register'),
      Type.Literal('unregister'),
    ],
    {
      description:
        'Action: execute JS code, bundle multiple files, register a workspace file as a custom tool, or unregister one',
    },
  ),
  code: Type.Optional(
    Type.String({ description: 'JavaScript code to execute (for execute/bundle actions)' }),
  ),
  path: Type.Optional(
    Type.String({
      description: 'Workspace file path (for register/unregister, or execute by path)',
    }),
  ),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'Arguments when executing — available as args.key (e.g. args.url, args.count)',
    }),
  ),
  files: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Workspace file paths to bundle and execute in order (for bundle action). ' +
        "Each file's return value is stored in window.__modules[filename].",
    }),
  ),
  exportAs: Type.Optional(
    Type.String({
      description:
        "Store the execution's return value as window.__modules[name] " +
        'for use by subsequent execute calls.',
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description:
        'Execution timeout in ms. Default: 30000 (30s). Max: 300000 (5 min). ' +
        'Increase for long-running API scans.',
      minimum: 1000,
      maximum: 300000,
    }),
  ),
  tabId: Type.Optional(
    Type.Number({
      description:
        "Run in a specific browser tab instead of the sandbox. " +
        "Gives access to that page's DOM, cookies, and JS context. " +
        "Get tab IDs from browser({ action: 'tabs' }). " +
        'If omitted, runs in the isolated sandbox (safer, default).',
    }),
  ),
});

type ExecuteJsArgs = Static<typeof executeJsSchema>;

/**
 * Parse custom tool metadata from comment lines in a workspace file.
 *
 * Expected format:
 *   // @tool <name>
 *   // @description <text>
 *   // @param <name> <type> "<description>"
 */
const parseToolMetadata = (
  content: string,
  filePath: string,
): CustomToolDef | { error: string } => {
  const lines = content.split('\n');

  let name: string | undefined;
  let description: string | undefined;
  const params: CustomToolDef['params'] = [];
  const promptLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('//')) continue;

    const comment = trimmed.slice(2).trim();

    const toolMatch = comment.match(/^@tool\s+(\S+)/);
    if (toolMatch) {
      name = toolMatch[1];
      continue;
    }

    const descMatch = comment.match(/^@description\s+(.+)/);
    if (descMatch) {
      description = descMatch[1].trim();
      continue;
    }

    const paramMatch = comment.match(/^@param\s+(\S+)\s+(\S+)\s+"([^"]+)"/);
    if (paramMatch) {
      params.push({
        name: paramMatch[1],
        type: paramMatch[2],
        description: paramMatch[3],
      });
      continue;
    }

    const promptMatch = comment.match(/^@prompt\s+(.+)/);
    if (promptMatch) {
      promptLines.push(promptMatch[1].trim());
    }
  }

  if (!name) {
    return { error: 'Missing @tool metadata. Add a comment like: // @tool my_tool_name' };
  }
  if (!description) {
    return {
      error:
        'Missing @description metadata. Add a comment like: // @description What this tool does',
    };
  }

  const promptHint = promptLines.length > 0 ? promptLines.join('\n') : undefined;
  return { name, description, params, path: filePath, promptHint };
};

// ── Auto-return helpers ─────────────────────────

/**
 * Strip leading single-line (//) and block comments from code.
 */
const stripLeadingComments = (code: string): string => {
  let s = code;
  while (true) {
    s = s.trimStart();
    if (s.startsWith('//')) {
      const nl = s.indexOf('\n');
      if (nl === -1) return '';
      s = s.slice(nl + 1);
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      if (end === -1) return '';
      s = s.slice(end + 2);
    } else {
      break;
    }
  }
  return s;
};

/**
 * If `code` has no top-level `return` and starts with `(` (e.g. an IIFE),
 * prepend `return ` so the value is captured by the outer async wrapper.
 */
const maybeAutoReturn = (code: string): string => {
  const body = stripLeadingComments(code).trimStart();
  // Already has a top-level return
  if (body.startsWith('return ') || body.startsWith('return(')) return code;
  // Bare IIFE — prepend return
  if (body.startsWith('(')) {
    const offset = code.length - body.length;
    return code.slice(0, offset) + 'return ' + body;
  }
  return code;
};

// ── Sandbox tab management ──────────────────────

let sandboxTabId: number | null = null;
let sandboxReady: Promise<number> | null = null;
let listenerRegistered = false;

const registerTabListener = () => {
  if (listenerRegistered) return;
  listenerRegistered = true;
  chrome.tabs.onRemoved.addListener(tabId => {
    if (tabId === sandboxTabId) {
      sandboxTabId = null;
      sandboxReady = null;
    }
  });
};

/** Try to find an existing sandbox tab left over from a previous SW lifecycle. */
const findExistingSandboxTab = async (): Promise<number | null> => {
  const url = chrome.runtime.getURL('sandbox.html');
  const tabs = await chrome.tabs.query({ url });
  return tabs.length > 0 && tabs[0].id != null ? tabs[0].id : null;
};

const createSandboxTab = async (): Promise<number> => {
  // Reuse an orphan tab from a previous service worker lifecycle
  const existingId = await findExistingSandboxTab();
  if (existingId !== null) {
    const err = await cdpAttach(existingId);
    if (!err) {
      await cdpSend(existingId, 'Runtime.enable');
      sandboxTabId = existingId;
      return existingId;
    }
    // Couldn't reuse — fall through and create a new one
  }

  const url = chrome.runtime.getURL('sandbox.html');
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id!;
  const err = await cdpAttach(tabId);
  if (err) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* ignore */
    }
    throw new Error(err);
  }
  await cdpSend(tabId, 'Runtime.enable');
  sandboxTabId = tabId;
  return tabId;
};

const ensureSandboxTab = async (): Promise<number> => {
  registerTabListener();
  if (sandboxTabId !== null) {
    try {
      await chrome.tabs.get(sandboxTabId);
      // Re-attach debugger in case it was detached (e.g. after SW restart)
      const err = await cdpAttach(sandboxTabId);
      if (err) {
        // Can't attach — discard and create a new tab
        sandboxTabId = null;
        sandboxReady = null;
      } else {
        await cdpSend(sandboxTabId, 'Runtime.enable');
        return sandboxTabId;
      }
    } catch {
      sandboxTabId = null;
      sandboxReady = null;
    }
  }
  if (sandboxReady) return sandboxReady;
  sandboxReady = createSandboxTab();
  try {
    return await sandboxReady;
  } catch (e) {
    sandboxReady = null;
    throw e;
  }
};

/**
 * Execute JavaScript code via CDP Runtime.evaluate in a sandbox or target tab.
 */
const executeCode = async (
  code: string,
  args?: Record<string, unknown>,
  timeout?: number,
  targetTabId?: number,
  exportAs?: string,
): Promise<string> => {
  // 1. Determine which tab to run in
  let tabId: number;
  if (targetTabId != null) {
    try {
      await chrome.tabs.get(targetTabId);
    } catch {
      throw new Error(
        `Tab ${targetTabId} not found. Use browser({ action: 'tabs' }) to list open tabs.`,
      );
    }
    const attachErr = await cdpAttach(targetTabId);
    if (attachErr && !attachErr.includes('Already attached')) {
      throw new Error(`Cannot attach to tab ${targetTabId}: ${attachErr}`);
    }
    await cdpSend(targetTabId, 'Runtime.enable');
    tabId = targetTabId;
  } else {
    tabId = await ensureSandboxTab();
  }

  // 2. Inject console capture
  await cdpSend(tabId, 'Runtime.evaluate', {
    expression: `(function() {
      if (!window.__cc) {
        window.__cc = {
          ol: console.log.bind(console),
          ow: console.warn.bind(console),
          oe: console.error.bind(console),
        };
      }
      window.__cl = [];
      var M = ${MAX_CONSOLE_LOGS};
      var c = function(lv, orig) { return function() {
        var a = Array.prototype.slice.call(arguments);
        if (window.__cl.length < M) {
          window.__cl.push({ l: lv, m: a.map(function(x) {
            try { return typeof x === 'string' ? x : JSON.stringify(x); }
            catch(e) { return String(x); }
          }).join(' ') });
        }
        orig.apply(console, a);
      }; };
      console.log = c('log', window.__cc.ol);
      console.warn = c('warn', window.__cc.ow);
      console.error = c('error', window.__cc.oe);
    })()`,
    returnByValue: true,
  });

  // 3. Build expression — always inject `args` variable
  const argsJson = JSON.stringify(args ?? {});
  let expression = `(async () => { const args = ${argsJson}; ${code} })()`;

  // If exportAs is set, wrap to store result on window.__modules
  if (exportAs) {
    const safeName = JSON.stringify(exportAs);
    expression = `(async () => {
      window.__modules = window.__modules || {};
      const __r = await ${expression};
      window.__modules[${safeName}] = __r;
      return __r;
    })()`;
  }

  // 4. Execute
  const effectiveTimeout = Math.min(
    Math.max(timeout ?? DEFAULT_TIMEOUT_MS, 1000),
    MAX_TIMEOUT_MS,
  );

  const result = await cdpSend<{
    result: { type: string; value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: effectiveTimeout,
  });

  // 5. Read console logs
  let logs: Array<{ l: string; m: string }> = [];
  try {
    const logsResult = await cdpSend<{ result: { value?: unknown } }>(
      tabId,
      'Runtime.evaluate',
      {
        expression: 'JSON.stringify(window.__cl || [])',
        returnByValue: true,
      },
    );
    const raw = logsResult.result.value;
    logs = typeof raw === 'string' ? JSON.parse(raw) : [];
  } catch {
    // Ignore log capture failures
  }

  // 6. Format output
  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    if (logs.length > 0) {
      const logText = logs
        .map(l => (l.l === 'log' ? l.m : `[${l.l.toUpperCase()}] ${l.m}`))
        .join('\n');
      throw new Error(`${errMsg}\n\n── Console Output ──\n${logText}`);
    }
    throw new Error(errMsg);
  }

  let returnValue: string;
  if (result.result.type === 'undefined') returnValue = 'undefined';
  else if (result.result.subtype === 'null') returnValue = 'null';
  else if (result.result.value !== undefined) {
    returnValue =
      typeof result.result.value === 'string'
        ? result.result.value
        : JSON.stringify(result.result.value, null, 2);
  } else {
    returnValue = result.result.description ?? `[${result.result.type}]`;
  }

  if (logs.length > 0) {
    const logText = logs
      .map(l => (l.l === 'log' ? l.m : `[${l.l.toUpperCase()}] ${l.m}`))
      .join('\n');
    return `${returnValue}\n\n── Console Output (${logs.length} lines) ──\n${logText}`;
  }

  return returnValue;
};

/**
 * Execute a custom tool by reading its workspace file and running it.
 */
const executeCustomTool = async (
  toolDef: CustomToolDef,
  args: Record<string, unknown>,
  agentId?: string,
): Promise<string> => {
  try {
    const file = await getWorkspaceFile(toolDef.path, agentId);
    if (!file) {
      return `Error: Workspace file not found: ${toolDef.path}`;
    }
    return await executeCode(maybeAutoReturn(file.content), args);
  } catch (err) {
    return `Error executing custom tool "${toolDef.name}": ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ── Main execute function ───────────────────────

const executeJs = async (args: ExecuteJsArgs): Promise<string> => {
  const { action } = args;

  if (action === 'execute') {
    // Execute code directly or from a workspace file
    try {
      let code: string;
      if (args.path) {
        const agentId = await getActiveAgentId();
        const file = await getWorkspaceFile(args.path, agentId);
        if (!file) return `Error: Workspace file not found: ${args.path}`;
        code = maybeAutoReturn(file.content);
      } else if (args.code) {
        code = args.code;
      } else {
        return 'Error: Provide either "code" or "path" for execute action.';
      }

      return await executeCode(code, args.args, args.timeout, args.tabId, args.exportAs);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (action === 'bundle') {
    if (!args.files?.length) {
      return 'Error: "files" array is required for bundle action.';
    }

    try {
      const agentId = await getActiveAgentId();
      const parts: string[] = ['window.__modules = window.__modules || {};'];

      for (const filePath of args.files) {
        const file = await getWorkspaceFile(filePath, agentId);
        if (!file) return `Error: Workspace file not found: ${filePath}`;

        // Derive module name: "bot/api-gamma.js" → "api_gamma"
        const moduleName = filePath
          .split('/')
          .pop()!
          .replace(/\.[^.]+$/, '')
          .replace(/[^a-zA-Z0-9]/g, '_');

        parts.push(`
// ── ${filePath} → __modules.${moduleName} ──
window.__modules[${JSON.stringify(moduleName)}] = await (async function() {
const args = {};
${maybeAutoReturn(file.content)}
})();`);
      }

      // Append epilogue code if provided
      if (args.code) {
        parts.push(`\n// ── epilogue ──\n${args.code}`);
      }

      // executeCode already wraps in (async () => { ... })() so just join parts
      const bundled = parts.join('\n');
      return await executeCode(bundled, args.args, args.timeout, args.tabId);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (action === 'register') {
    if (!args.path) return 'Error: "path" is required for register action.';

    const agentId = await getActiveAgentId();
    if (!agentId) return 'Error: No active agent.';

    // Read the workspace file
    const file = await getWorkspaceFile(args.path, agentId);
    if (!file) return `Error: Workspace file not found: ${args.path}`;

    // Parse metadata
    const parsed = parseToolMetadata(file.content, args.path);
    if ('error' in parsed) return `Error: ${parsed.error}`;

    // Load agent and update custom tools
    const agent = await getAgent(agentId);
    if (!agent) return 'Error: Agent not found.';

    const existing = agent.customTools ?? [];
    // Replace if tool with same name or path exists
    const filtered = existing.filter(ct => ct.name !== parsed.name && ct.path !== parsed.path);
    const customTools = [...filtered, parsed];

    // Enable the tool in agent's tool config
    const toolConfig = agent.toolConfig ?? {
      enabledTools: {},
      webSearchConfig: {
        provider: 'tavily',
        tavily: { apiKey: '' },
        browser: { engine: 'google' },
      },
    };
    toolConfig.enabledTools[parsed.name] = true;

    await updateAgent(agentId, { customTools, toolConfig });
    return `Registered custom tool "${parsed.name}" from ${args.path} (${parsed.params.length} params)`;
  }

  if (action === 'unregister') {
    if (!args.path) return 'Error: "path" is required for unregister action.';

    const agentId = await getActiveAgentId();
    if (!agentId) return 'Error: No active agent.';

    const agent = await getAgent(agentId);
    if (!agent) return 'Error: Agent not found.';

    const existing = agent.customTools ?? [];
    const toRemove = existing.find(ct => ct.path === args.path || ct.name === args.path);
    if (!toRemove) return `Error: No custom tool found matching "${args.path}".`;

    const customTools = existing.filter(ct => ct !== toRemove);

    // Disable the tool in agent's tool config
    const toolConfig = agent.toolConfig ?? {
      enabledTools: {},
      webSearchConfig: {
        provider: 'tavily',
        tavily: { apiKey: '' },
        browser: { engine: 'google' },
      },
    };
    delete toolConfig.enabledTools[toRemove.name];

    await updateAgent(agentId, { customTools, toolConfig });
    return `Unregistered custom tool "${toRemove.name}" (${args.path})`;
  }

  return `Error: Unknown action "${action}". Use execute, bundle, register, or unregister.`;
};

/** Reset sandbox state — exported for testing only. */
const _resetSandbox = () => {
  sandboxTabId = null;
  sandboxReady = null;
  listenerRegistered = false;
};

export {
  executeJsSchema,
  executeJs,
  executeCode,
  executeCustomTool,
  parseToolMetadata,
  maybeAutoReturn,
  stripLeadingComments,
  _resetSandbox,
};
