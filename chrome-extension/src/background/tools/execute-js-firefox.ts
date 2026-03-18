/**
 * Firefox execute-js — uses chrome.scripting.executeScript({ world: 'MAIN' })
 * instead of CDP (chrome.debugger + Runtime.evaluate).
 *
 * Lazily imported by execute-js.ts when IS_FIREFOX is true.
 * Same signature as executeCode() so the rest of the tool (bundle, custom tools,
 * register/unregister) works unchanged.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CONSOLE_LOGS = 200;

// ── Sandbox tab (no CDP needed) ─────────────────────────────────────────────

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

const SANDBOX_URL = 'https://example.com';

const createSandboxTabFirefox = async (): Promise<number> => {
  // Use example.com instead of sandbox.html — Firefox blocks eval() on extension
  // pages due to browser-enforced CSP. about:blank allows eval() but blocks IndexedDB.
  // example.com has a permissive CSP and a real origin, so both eval() and IndexedDB work.
  const tabs = await chrome.tabs.query({ url: `${SANDBOX_URL}/*` });
  if (tabs.length > 0 && tabs[0].id != null) {
    sandboxTabId = tabs[0].id;
    return sandboxTabId;
  }

  const tab = await chrome.tabs.create({ url: SANDBOX_URL, active: false });
  sandboxTabId = tab.id!;
  return sandboxTabId;
};

const ensureSandboxTabFirefox = async (): Promise<number> => {
  registerTabListener();
  if (sandboxTabId !== null) {
    try {
      await chrome.tabs.get(sandboxTabId);
      return sandboxTabId;
    } catch {
      sandboxTabId = null;
      sandboxReady = null;
    }
  }
  if (sandboxReady) return sandboxReady;
  sandboxReady = createSandboxTabFirefox();
  try {
    return await sandboxReady;
  } catch (e) {
    sandboxReady = null;
    throw e;
  }
};

// ── Core executor ───────────────────────────────────────────────────────────

interface ScriptResult {
  ok: boolean;
  value?: { type: string; data?: unknown };
  error?: string;
  logs: Array<{ l: string; m: string }>;
}

const executeCodeFirefox = async (
  code: string,
  args?: Record<string, unknown>,
  timeout?: number,
  targetTabId?: number,
  exportAs?: string,
): Promise<string> => {
  // 1. Determine tab
  let tabId: number;
  if (targetTabId != null) {
    try {
      await chrome.tabs.get(targetTabId);
    } catch {
      throw new Error(
        `Tab ${targetTabId} not found. Use browser({ action: 'tabs' }) to list open tabs.`,
      );
    }
    tabId = targetTabId;
  } else {
    tabId = await ensureSandboxTabFirefox();
  }

  // 2. Build expression (identical to Chrome path)
  const argsJson = JSON.stringify(args ?? {});
  let expression = `(async () => { const args = ${argsJson}; ${code} })()`;

  if (exportAs) {
    const safeName = JSON.stringify(exportAs);
    expression = `(async () => {
      window.__modules = window.__modules || {};
      const __r = await ${expression};
      window.__modules[${safeName}] = __r;
      return __r;
    })()`;
  }

  const effectiveTimeout = Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);

  // 3. Execute via chrome.scripting.executeScript
  //    Single injection: sets up console capture, runs code with timeout, returns result + logs
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
    func: async (expr: string, maxLogs: number, timeoutMs: number) => {
      // Console capture
      const w = window as unknown as Record<string, unknown>;
      if (!w.__cc) {
        w.__cc = {
          ol: console.log.bind(console),
          ow: console.warn.bind(console),
          oe: console.error.bind(console),
        };
      }
      w.__cl = [];
      const logs = w.__cl as Array<{ l: string; m: string }>;
      const cc = w.__cc as Record<string, (...a: unknown[]) => void>;
      const capture =
        (lv: string, orig: (...a: unknown[]) => void) =>
        (...a: unknown[]) => {
          if (logs.length < maxLogs) {
            logs.push({
              l: lv,
              m: a
                .map((x: unknown) => {
                  try {
                    return typeof x === 'string' ? x : JSON.stringify(x);
                  } catch {
                    return String(x);
                  }
                })
                .join(' '),
            });
          }
          orig.apply(console, a);
        };
      console.log = capture('log', cc.ol);
      console.warn = capture('warn', cc.ow);
      console.error = capture('error', cc.oe);

      // Execute with timeout
      let timer: ReturnType<typeof setTimeout>;
      try {
        const result = await Promise.race([
          eval(expr),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Execution timed out')), timeoutMs);
          }),
        ]);
        clearTimeout(timer!);
        // Serialize result for transport
        let value: { type: string; data?: unknown };
        if (result === undefined) value = { type: 'undefined' };
        else if (result === null) value = { type: 'null' };
        else if (typeof result === 'string') value = { type: 'string', data: result };
        else {
          try {
            value = { type: 'json', data: JSON.parse(JSON.stringify(result)) };
          } catch {
            value = { type: 'string', data: String(result) };
          }
        }
        return { ok: true, value, logs };
      } catch (err: unknown) {
        clearTimeout(timer!);
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          logs,
        };
      }
    },
    args: [expression, MAX_CONSOLE_LOGS, effectiveTimeout],
  });

  // 4. Format output (mirrors Chrome path logic)
  const res = results?.[0]?.result as ScriptResult | undefined;

  if (!res) throw new Error('executeScript returned no result');

  const logs = res.logs ?? [];
  const logText =
    logs.length > 0
      ? `\n\n── Console Output (${logs.length} lines) ──\n` +
        logs.map(l => (l.l === 'log' ? l.m : `[${l.l.toUpperCase()}] ${l.m}`)).join('\n')
      : '';

  if (!res.ok) {
    throw new Error((res.error ?? 'Unknown execution error') + logText);
  }

  let returnValue: string;
  const v = res.value!;
  if (v.type === 'undefined') returnValue = 'undefined';
  else if (v.type === 'null') returnValue = 'null';
  else if (v.type === 'string') returnValue = v.data as string;
  else returnValue = JSON.stringify(v.data, null, 2);

  return returnValue + logText;
};

/** Reset sandbox state — exported for testing only. */
const _resetSandboxFirefox = () => {
  sandboxTabId = null;
  sandboxReady = null;
  listenerRegistered = false;
};

export { executeCodeFirefox, _resetSandboxFirefox };
