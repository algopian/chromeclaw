import { cdpSend, cdpSendWithReattach } from './cdp';
import { executeBrowserFirefox } from './browser-firefox';
import { injectControlIndicator, removeControlIndicator } from './tab-indicator';
import { sanitizeImage } from './image-sanitization';
import { IS_FIREFOX } from '@extension/env';
import { createLogger } from '../logging/logger-buffer';
import { Type } from '@sinclair/typebox';
import type { SanitizedImage } from './image-sanitization';
import type { ToolRegistration, ToolResult } from './tool-registration';
import type { Static } from '@sinclair/typebox';

// ── Tool registration ──

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const browserSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal('tabs'),
      Type.Literal('open'),
      Type.Literal('close'),
      Type.Literal('focus'),
      Type.Literal('navigate'),
      Type.Literal('content'),
      Type.Literal('snapshot'),
      Type.Literal('screenshot'),
      Type.Literal('click'),
      Type.Literal('type'),
      Type.Literal('evaluate'),
      Type.Literal('console'),
      Type.Literal('network'),
    ],
    {
      description:
        'The browser action to perform. Use "snapshot" to understand page content, then "click"/"type" with ref numbers to interact.',
    },
  ),
  tabId: Type.Optional(
    Type.Number({
      description: 'Target tab ID (required for most actions except "tabs" and "open")',
    }),
  ),
  url: Type.Optional(Type.String({ description: 'URL for "open" or "navigate" actions' })),
  active: Type.Optional(
    Type.Boolean({
      description: 'Whether to activate the tab for "open" or "navigate" (default: false)',
    }),
  ),
  ref: Type.Optional(
    Type.Number({ description: 'Element ref number from a snapshot, for "click" or "type"' }),
  ),
  text: Type.Optional(
    Type.String({ description: 'Text to type for the "type" action (replaces existing value)' }),
  ),
  selector: Type.Optional(
    Type.String({ description: 'CSS selector to scope "content" extraction' }),
  ),
  expression: Type.Optional(Type.String({ description: 'JavaScript expression for "evaluate"' })),
  fullPage: Type.Optional(
    Type.Boolean({ description: 'Capture full page for "screenshot" (default: viewport only)' }),
  ),
  limit: Type.Optional(
    Type.Number({ description: 'Max entries for "console" or "network" (default: 50)' }),
  ),
});

type BrowserArgs = Static<typeof browserSchema>;

const browserLog = createLogger('browser');

/** Structured result returned by the screenshot action */
interface ScreenshotResult {
  __type: 'screenshot';
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

interface RefEntry {
  nodeId: number;
  backendNodeId: number;
}

interface TabSession {
  attached: boolean;
  refMap: Map<number, RefEntry>;
  consoleLogs: ConsoleEntry[];
  networkRequests: NetworkEntry[];
}

interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
}

interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  type?: string;
  timestamp: number;
}

const MAX_BUFFER = 200;

const sessions = new Map<number, TabSession>();

const getOrCreateSession = (tabId: number): TabSession => {
  let session = sessions.get(tabId);
  if (!session) {
    session = {
      attached: false,
      refMap: new Map(),
      consoleLogs: [],
      networkRequests: [],
    };
    sessions.set(tabId, session);
  }
  return session;
};

const cleanupSession = (tabId: number): void => {
  sessions.delete(tabId);
};

const pushToRingBuffer = <T>(buffer: T[], item: T): void => {
  buffer.push(item);
  if (buffer.length > MAX_BUFFER) {
    buffer.shift();
  }
};

// Per-tab attach promises to serialize concurrent ensureAttached calls
const attachPromises = new Map<number, Promise<string | null>>();

// Per-tab attach failure cache — prevents redundant attach attempts
interface AttachFailure {
  error: string;
  timestamp: number;
  origin: string;
}
const ATTACH_FAILURE_TTL_MS = 60_000;
const attachFailureCache = new Map<number, AttachFailure>();

/** Get the origin from a tab URL, or empty string if unavailable. */
const getTabOrigin = async (tabId: number): Promise<string> => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) return new URL(tab.url).origin;
  } catch {
    // ignore
  }
  return '';
};

const tryAttach = async (tabId: number): Promise<string | null> => {
  const session = getOrCreateSession(tabId);
  browserLog.debug('tryAttach', { tabId });

  try {
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Another debugger is already attached')) {
      browserLog.debug('Another debugger already attached, reusing', { tabId });
      session.attached = true;
      return null;
    }
    browserLog.warn('Attach failed', { tabId, error: msg });
    return msg;
  }

  session.attached = true;
  attachFailureCache.delete(tabId);
  browserLog.info('Debugger attached', { tabId });

  // Enable domains — may fail if the page immediately detaches the debugger
  try {
    await cdpSend(tabId, 'Runtime.enable');
    await cdpSend(tabId, 'Network.enable');
    await cdpSend(tabId, 'Page.enable');
    await cdpSend(tabId, 'DOM.enable');
  } catch (domainErr) {
    const msg = domainErr instanceof Error ? domainErr.message : String(domainErr);
    browserLog.warn('Domain enable failed after attach — page may have detached debugger', { tabId, error: msg });
    session.attached = false;
    return msg;
  }

  return null;
};

const doAttach = async (tabId: number): Promise<string | null> => {
  // First attempt
  const firstErr = await tryAttach(tabId);
  if (!firstErr) return null;
  browserLog.info('First attach failed, detaching and retrying', { tabId, error: firstErr });

  // Detach and retry once — handles stale debugger state after tab reload/navigation
  try {
    await new Promise<void>(resolve => {
      chrome.debugger.detach({ tabId }, () => {
        chrome.runtime.lastError; // consume error
        resolve();
      });
    });
    cleanupSession(tabId);
  } catch {
    // detach failed — ignore
  }

  const retryErr = await tryAttach(tabId);
  if (!retryErr) return null;

  // Both attempts failed — cache and return error
  const errorMsg = `Cannot attach debugger to this tab: ${retryErr}. This site blocks debugger access. Use browser content action or execute_javascript with tabId instead. Do NOT retry debugger for this tab.`;
  const origin = await getTabOrigin(tabId);
  attachFailureCache.set(tabId, { error: errorMsg, timestamp: Date.now(), origin });
  return errorMsg;
};

const ensureAttached = async (tabId: number): Promise<string | null> => {
  const session = getOrCreateSession(tabId);
  browserLog.trace('ensureAttached', { tabId, sessionAttached: session.attached });
  if (session.attached) {
    // Verify the connection is still alive — session.attached may be stale
    // after extension reload or if the debugger was detached externally.
    try {
      await cdpSend(tabId, 'Runtime.evaluate', { expression: '1' });
      return null;
    } catch (err) {
      // Connection is dead — reset and re-attach below
      browserLog.warn('Stale debugger session detected, re-attaching', { tabId, error: String(err) });
      session.attached = false;
      attachFailureCache.delete(tabId);
    }
  }

  // Check attach failure cache
  const cached = attachFailureCache.get(tabId);
  if (cached) {
    const age = Date.now() - cached.timestamp;
    if (age < ATTACH_FAILURE_TTL_MS) {
      // Check if origin has changed (tab navigated to different site)
      const currentOrigin = await getTabOrigin(tabId);
      if (currentOrigin === cached.origin || currentOrigin === '') {
        return `${cached.error} (cached — previously failed ${Math.round(age / 1000)}s ago)`;
      }
      // Origin changed, clear cache and try again
      attachFailureCache.delete(tabId);
    } else {
      // TTL expired
      attachFailureCache.delete(tabId);
    }
  }

  // Serialize concurrent attach attempts for the same tab
  const pending = attachPromises.get(tabId);
  if (pending) return pending;

  const promise = doAttach(tabId);
  attachPromises.set(tabId, promise);
  try {
    return await promise;
  } finally {
    attachPromises.delete(tabId);
  }
};

// ---------------------------------------------------------------------------
// Debugger event listeners (registered once at module load)
// Firefox does not have chrome.debugger — skip registration entirely.
// ---------------------------------------------------------------------------

if (!IS_FIREFOX) {
  chrome.debugger.onDetach.addListener((source, _reason) => {
    if (source.tabId != null) {
      attachFailureCache.delete(source.tabId);
      cleanupSession(source.tabId);
    }
  });

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId == null) return;
    const session = sessions.get(source.tabId);
    if (!session) return;

    const p = params as Record<string, unknown>;

    if (method === 'Runtime.consoleAPICalled') {
      const args = (p.args as Array<{ type: string; value?: unknown; description?: string }>) ?? [];
      const text = args.map(a => a.description ?? a.value ?? '').join(' ');
      pushToRingBuffer(session.consoleLogs, {
        type: (p.type as string) ?? 'log',
        text,
        timestamp: Date.now(),
      });
    }

    if (method === 'Network.requestWillBeSent') {
      const request = p.request as { method?: string; url?: string } | undefined;
      if (request) {
        pushToRingBuffer(session.networkRequests, {
          method: request.method ?? 'GET',
          url: request.url ?? '',
          timestamp: Date.now(),
        });
      }
    }

    if (method === 'Network.responseReceived') {
      const response = p.response as
        | { url?: string; status?: number; mimeType?: string }
        | undefined;
      if (response) {
        // Update the last matching request with status
        for (let i = session.networkRequests.length - 1; i >= 0; i--) {
          if (
            session.networkRequests[i].url === response.url &&
            session.networkRequests[i].status == null
          ) {
            session.networkRequests[i].status = response.status;
            session.networkRequests[i].type = response.mimeType;
            break;
          }
        }
      }
    }
  });

  // Cleanup session when tab is closed
  chrome.tabs.onRemoved.addListener(tabId => {
    attachFailureCache.delete(tabId);
    if (sessions.has(tabId)) {
      try {
        chrome.debugger.detach({ tabId }, () => {
          // Ignore errors — tab is already gone
          void chrome.runtime.lastError;
        });
      } catch {
        // ignore
      }
      cleanupSession(tabId);
    }
  });
} // end if (!IS_FIREFOX)

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------

/** Check if a URL is an SPA hash-based route. */
const isSpaHashRoute = (url: string): boolean => url.includes('#/') || url.includes('#!/');

const waitForLoad = (tabId: number, timeoutMs = 15000): Promise<void> =>
  new Promise((_resolve, reject) => {
    const resolve = _resolve;
    const timer = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(listener);
      reject(new Error('Page load timed out'));
    }, timeoutMs);

    const listener = (source: chrome.debugger.Debuggee, method: string) => {
      if (source.tabId === tabId && (method === 'Page.loadEventFired' || method === 'Page.frameStoppedLoading')) {
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(listener);
        resolve();
      }
    };
    chrome.debugger.onEvent.addListener(listener);
  });

interface CancellablePromise {
  promise: Promise<void>;
  cancel: () => void;
}

/**
 * Wait for network idle — no in-flight requests for `quietMs`, up to `maxMs` total.
 * Used for SPA navigations where load events may not fire.
 * Returns a cancellable promise to avoid listener leaks when used in Promise.race.
 */
const waitForNetworkIdle = (tabId: number, quietMs = 1000, maxMs = 10000): CancellablePromise => {
  let cleanup: (() => void) | null = null;

  const promise = new Promise<void>(resolve => {
    let inFlight = 0;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const teardown = () => {
      if (cancelled) return;
      cancelled = true;
      chrome.debugger.onEvent.removeListener(listener);
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(maxTimer);
    };

    const done = () => {
      teardown();
      resolve();
    };

    cleanup = teardown;

    const maxTimer = setTimeout(done, maxMs);

    const checkQuiet = () => {
      if (cancelled) return;
      if (inFlight <= 0) {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(done, quietMs);
      } else if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
    };

    const listener = (source: chrome.debugger.Debuggee, method: string) => {
      if (cancelled || source.tabId !== tabId) return;
      if (method === 'Network.requestWillBeSent') {
        inFlight++;
        checkQuiet();
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        inFlight = Math.max(0, inFlight - 1);
        checkQuiet();
      }
    };

    chrome.debugger.onEvent.addListener(listener);
    checkQuiet();
  });

  return { promise, cancel: () => cleanup?.() };
};

// ---------------------------------------------------------------------------
// Snapshot algorithm
// ---------------------------------------------------------------------------

const INTERACTIVE_TAGS = new Set([
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'details',
  'summary',
]);

const INTERACTIVE_ROLES = new Set([
  'button',
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
]);

const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'meta',
  'link',
  'path',
  'defs',
  'clippath',
]);

const STRUCTURAL_TAGS = new Set([
  'div',
  'span',
  'section',
  'nav',
  'main',
  'aside',
  'header',
  'footer',
  'article',
  'form',
  'fieldset',
  'legend',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'blockquote',
  'pre',
  'code',
  'label',
  'dialog',
  'img',
  'video',
  'audio',
  'canvas',
  'iframe',
]);

const MAX_TEXT_LENGTH = 80;
const MAX_DEPTH = 15;
const MAX_NODES = 5000;
const MAX_RESULT_CHARS = 30000;

interface CDPNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  children?: CDPNode[];
  attributes?: string[];
  contentDocument?: CDPNode;
  frameId?: string;
}

interface SnapshotContext {
  refCounter: number;
  nodeCount: number;
  refMap: Map<number, RefEntry>;
  lines: string[];
}

const getAttr = (node: CDPNode, name: string): string | undefined => {
  if (!node.attributes) return undefined;
  for (let i = 0; i < node.attributes.length; i += 2) {
    if (node.attributes[i] === name) return node.attributes[i + 1];
  }
  return undefined;
};

const isInteractive = (node: CDPNode): boolean => {
  const tag = node.nodeName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = getAttr(node, 'role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (getAttr(node, 'onclick') != null) return true;
  if (getAttr(node, 'contenteditable') === 'true') return true;
  if (getAttr(node, 'tabindex') != null && tag !== 'div' && tag !== 'span') return true;
  return false;
};

const truncateText = (text: string): string => {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= MAX_TEXT_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_TEXT_LENGTH) + '...';
};

const collectTextContent = (node: CDPNode): string => {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  let text = '';
  for (const child of node.children ?? []) {
    if (child.nodeType === 3) {
      text += child.nodeValue ?? '';
    }
  }
  return text;
};

const formatInteractiveNode = (node: CDPNode, ref: number): string => {
  const tag = node.nodeName.toLowerCase();
  const parts: string[] = [`[${ref}]`];

  // Determine display type
  if (tag === 'a') {
    parts.push('link');
  } else if (tag === 'button' || getAttr(node, 'role') === 'button') {
    parts.push('button');
  } else if (tag === 'input') {
    const type = getAttr(node, 'type') ?? 'text';
    parts.push(`input type=${type}`);
  } else if (tag === 'select') {
    parts.push('select');
  } else if (tag === 'textarea') {
    parts.push('textarea');
  } else {
    const role = getAttr(node, 'role');
    parts.push(role ?? tag);
  }

  // Label text
  const text = truncateText(collectTextContent(node));
  if (text) parts.push(`"${text}"`);

  // Key attributes
  const ariaLabel = getAttr(node, 'aria-label');
  if (ariaLabel && !text) parts.push(`"${truncateText(ariaLabel)}"`);

  const placeholder = getAttr(node, 'placeholder');
  if (placeholder) parts.push(`placeholder="${truncateText(placeholder)}"`);

  const href = getAttr(node, 'href');
  if (href) parts.push(`href=${href.length > 60 ? href.slice(0, 60) + '...' : href}`);

  const value = getAttr(node, 'value');
  if (value && tag === 'input') parts.push(`value="${truncateText(value)}"`);

  const name = getAttr(node, 'name');
  if (name) parts.push(`name="${name}"`);

  if (getAttr(node, 'disabled') != null) parts.push('disabled');
  if (getAttr(node, 'readonly') != null) parts.push('readonly');
  if (getAttr(node, 'required') != null) parts.push('required');

  return parts.join(' ');
};

const walkNode = (node: CDPNode, depth: number, ctx: SnapshotContext): void => {
  if (ctx.nodeCount >= MAX_NODES) return;
  if (depth > MAX_DEPTH) return;

  const tag = node.nodeName.toLowerCase();

  // Skip invisible/irrelevant nodes
  if (SKIP_TAGS.has(tag)) return;

  const indent = '  '.repeat(depth);
  ctx.nodeCount++;

  // Text node
  if (node.nodeType === 3) {
    const text = truncateText(node.nodeValue ?? '');
    if (text) {
      ctx.lines.push(`${indent}${text}`);
    }
    return;
  }

  // Element node
  if (node.nodeType === 1) {
    // Handle iframes specially
    if (tag === 'iframe') {
      const src = getAttr(node, 'src') ?? '';
      ctx.lines.push(`${indent}[iframe] src=${src}`);
      // Walk contentDocument if same-origin
      if (node.contentDocument) {
        walkNode(node.contentDocument, depth + 1, ctx);
      }
      return;
    }

    if (isInteractive(node)) {
      const ref = ++ctx.refCounter;
      ctx.refMap.set(ref, { nodeId: node.nodeId, backendNodeId: node.backendNodeId });
      ctx.lines.push(`${indent}${formatInteractiveNode(node, ref)}`);
      // Walk children for nested interactive elements
      for (const child of node.children ?? []) {
        if (child.nodeType === 1 && isInteractive(child)) {
          walkNode(child, depth + 1, ctx);
        }
      }
      return;
    }

    if (STRUCTURAL_TAGS.has(tag)) {
      // Only emit structural tag if it has content
      const childLines: string[] = [];
      const childCtx: SnapshotContext = {
        ...ctx,
        lines: childLines,
      };
      for (const child of node.children ?? []) {
        walkNode(child, depth + 1, childCtx);
      }
      // Update shared counters
      ctx.refCounter = childCtx.refCounter;
      ctx.nodeCount = childCtx.nodeCount;

      if (childLines.length > 0) {
        ctx.lines.push(`${indent}[${tag}]`);
        ctx.lines.push(...childLines);
      }
      return;
    }

    // Other element — just walk children
    for (const child of node.children ?? []) {
      walkNode(child, depth, ctx);
    }
  }

  // Document node (nodeType 9)
  if (node.nodeType === 9) {
    for (const child of node.children ?? []) {
      walkNode(child, depth, ctx);
    }
  }
};

const buildSnapshot = async (tabId: number): Promise<string> => {
  const session = getOrCreateSession(tabId);

  const { root } = await cdpSendWithReattach<{ root: CDPNode }>(tabId, 'DOM.getDocument', {
    depth: -1,
    pierce: true,
  });

  // Get page info
  let title = '';
  let url = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    title = tab.title ?? '';
    url = tab.url ?? '';
  } catch {
    // ignore
  }

  const ctx: SnapshotContext = {
    refCounter: 0,
    nodeCount: 0,
    refMap: new Map(),
    lines: [],
  };

  ctx.lines.push(`[page] ${title} (${url})`);
  walkNode(root, 1, ctx);

  // Store ref map in session for click/type
  session.refMap = ctx.refMap;

  if (ctx.nodeCount >= MAX_NODES) {
    ctx.lines.push(`\n[truncated: reached ${MAX_NODES} node limit]`);
  }

  return ctx.lines.join('\n');
};

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

const ensureTabActive = async (tabId: number): Promise<void> => {
  await chrome.tabs.update(tabId, { active: true });
};

const handleTabs = async (): Promise<string> => {
  const tabs = await chrome.tabs.query({});
  const lines = tabs.map(
    t => `[${t.id}] ${t.active ? '(active) ' : ''}${t.title ?? 'Untitled'} — ${t.url ?? ''}`,
  );
  return `Open tabs (${tabs.length}):\n${lines.join('\n')}`;
};

const handleOpen = async (args: BrowserArgs): Promise<string> => {
  if (!args.url) return 'Error: "url" is required for the "open" action.';
  const tab = await chrome.tabs.create({ url: args.url, active: args.active ?? false });
  // Store the new tab ID so the caller can use it (e.g. for indicator highlight)
  if (tab.id != null) (args as Record<string, unknown>).tabId = tab.id;
  return `Opened tab [${tab.id}]: ${tab.url ?? args.url}`;
};

const handleFocus = async (args: BrowserArgs): Promise<string> => {
  if (args.tabId == null) return 'Error: "tabId" is required for the "focus" action.';
  const tab = await chrome.tabs.update(args.tabId, { active: true });
  if (tab?.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return `Focused tab [${args.tabId}]: ${tab?.title ?? ''}`;
};

const handleClose = async (args: BrowserArgs): Promise<string> => {
  if (args.tabId == null) return 'Error: "tabId" is required for the "close" action.';
  // Detach debugger if attached
  const session = sessions.get(args.tabId);
  if (session?.attached) {
    try {
      await new Promise<void>(resolve => {
        chrome.debugger.detach({ tabId: args.tabId! }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
    } catch {
      // ignore
    }
  }
  cleanupSession(args.tabId);
  await chrome.tabs.remove(args.tabId);
  return `Closed tab [${args.tabId}].`;
};

const handleNavigate = async (args: BrowserArgs): Promise<string> => {
  if (args.tabId == null) return 'Error: "tabId" is required for the "navigate" action.';
  if (!args.url) return 'Error: "url" is required for the "navigate" action.';

  if (args.active) {
    await ensureTabActive(args.tabId);
  }

  // Clear stale refs before navigation — even if load times out, old refs are invalid
  const navSession = getOrCreateSession(args.tabId);
  navSession.refMap.clear();

  // Clear attach failure cache — navigation to new page may succeed
  attachFailureCache.delete(args.tabId);

  // Try debugger-based navigation first for full load detection;
  // fall back to chrome.tabs.update for pages that block debugger access.
  browserLog.debug('handleNavigate: attaching', { tabId: args.tabId, url: args.url });
  const attachErr = await ensureAttached(args.tabId);
  if (attachErr) {
    browserLog.info('handleNavigate: attach failed, falling back to tabs API', { tabId: args.tabId, error: attachErr });
    await chrome.tabs.update(args.tabId, { url: args.url });
    await new Promise(resolve => setTimeout(resolve, 2000));
    const tab = await chrome.tabs.get(args.tabId);
    return `Navigated tab [${args.tabId}] to ${tab.url ?? args.url}. Run "snapshot" to see page content.`;
  }

  browserLog.debug('handleNavigate: using CDP Page.navigate', { tabId: args.tabId });
  const spaNav = isSpaHashRoute(args.url);
  const loadTimeout = spaNav ? 20000 : 15000;
  const loadPromise = waitForLoad(args.tabId, loadTimeout);
  const navResult = await cdpSendWithReattach<{ frameId?: string; errorText?: string }>(
    args.tabId,
    'Page.navigate',
    { url: args.url },
  );

  // Check for navigation-level errors (e.g., invalid URL, DNS failure)
  if (navResult.errorText) {
    return `Error: Navigation failed — ${navResult.errorText}`;
  }

  if (spaNav) {
    // SPA hash navigations may not fire Page.loadEventFired — race with network idle
    const networkIdle = waitForNetworkIdle(args.tabId);
    await Promise.race([loadPromise, networkIdle.promise]);
    networkIdle.cancel();
  } else {
    await loadPromise;
  }

  const tab = await chrome.tabs.get(args.tabId);
  return `Navigated tab [${args.tabId}] to ${tab.url ?? args.url}. Run "snapshot" to see page content.`;
};

const handleContent = async (args: BrowserArgs): Promise<string> => {
  if (args.tabId == null) return 'Error: "tabId" is required for the "content" action.';

  browserLog.debug('handleContent: executing script', { tabId: args.tabId, selector: args.selector ?? null });
  const results = await chrome.scripting.executeScript({
    target: { tabId: args.tabId },
    func: (selector: string | null) => {
      if (selector) {
        const el = document.querySelector(selector);
        return el ? (el as HTMLElement).innerText : `No element found for selector: ${selector}`;
      }
      return document.body.innerText;
    },
    args: [typeof args.selector === 'string' ? args.selector : null],
  });

  let text = results?.[0]?.result ?? '';
  if (typeof text === 'string' && text.length > 50000) {
    text = text.slice(0, 50000) + '\n[truncated at 50,000 characters]';
  }
  return text;
};

const handleSnapshot = async (args: BrowserArgs): Promise<string> => {
  if (args.tabId == null) return 'Error: "tabId" is required for the "snapshot" action.';

  browserLog.debug('handleSnapshot: attaching', { tabId: args.tabId });
  const attachErr = await ensureAttached(args.tabId);
  if (attachErr) {
    browserLog.warn('handleSnapshot: CDP attach failed, falling back to scripting snapshot', { tabId: args.tabId, error: attachErr });
    
    const fallback = await executeBrowserFirefox({ ...args, action: 'snapshot' });
    if (typeof fallback === 'string' && !fallback.startsWith('Error:')) {
      return fallback;
    }
    return `Error: Cannot capture this page. Detail: ${attachErr}`;
  }

  browserLog.debug('handleSnapshot: building snapshot', { tabId: args.tabId });
  let snapshot: string;
  try {
    snapshot = await buildSnapshot(args.tabId);
  } catch (snapshotErr) {
    // Debugger may have been immediately detached — fall back to scripting snapshot
    const msg = snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr);
    browserLog.warn('handleSnapshot: buildSnapshot failed, falling back to scripting snapshot', { tabId: args.tabId, error: msg });
    
    const fallback = await executeBrowserFirefox({ ...args, action: 'snapshot' });
    if (typeof fallback === 'string' && !fallback.startsWith('Error:')) {
      return fallback;
    }
    return `Error: Cannot capture this page. Detail: ${msg}`;
  }

  // Warn on minimal content — use total snapshot length as a simple heuristic
  if (snapshot.length < 200) {
    snapshot += '\n\n[Note: This page returned very little visible content. The site may be blocking content extraction. Consider asking the user to describe the page content instead.]';
  }

  // Truncate oversized snapshots
  if (snapshot.length > MAX_RESULT_CHARS) {
    snapshot = snapshot.slice(0, MAX_RESULT_CHARS) + '\n\n[Snapshot truncated at 30000 chars. Full page has more content — use evaluate action with specific DOM queries to extract targeted data.]';
  }

  return snapshot;
};

const handleScreenshot = async (args: BrowserArgs): Promise<string | ScreenshotResult> => {
  if (args.tabId == null) return 'Error: "tabId" is required for the "screenshot" action.';

  const attachErr = await ensureAttached(args.tabId);
  if (attachErr) {
    return `Error: Cannot capture this page — the site blocks programmatic access (common with Google, banking, and enterprise apps). Detail: ${attachErr}. Try using execute_javascript with tabId to run JS in the page context instead, or ask the user to describe what they see.`;
  }

  const params: Record<string, unknown> = { format: 'png' };

  if (args.fullPage) {
    // Get full page metrics
    const metrics = await cdpSendWithReattach<{
      contentSize: { width: number; height: number };
    }>(args.tabId, 'Page.getLayoutMetrics');
    const { width, height } = metrics.contentSize;

    await cdpSendWithReattach(args.tabId, 'Emulation.setDeviceMetricsOverride', {
      width: Math.ceil(width),
      height: Math.ceil(height),
      deviceScaleFactor: 1,
      mobile: false,
    });

    params.captureBeyondViewport = true;
  }

  try {
    const result = await cdpSendWithReattach<{ data: string }>(args.tabId, 'Page.captureScreenshot', params);

    // Resize and compress the screenshot
    let sanitized: SanitizedImage | null;
    try {
      sanitized = await sanitizeImage(result.data, 'image/png');
    } catch {
      // Fallback: return raw PNG if sanitization fails (e.g. OffscreenCanvas unavailable)
      return JSON.stringify({ base64: result.data, mimeType: 'image/png' });
    }
    if (!sanitized) {
      return JSON.stringify({ base64: result.data, mimeType: 'image/png' });
    }

    return {
      __type: 'screenshot',
      base64: sanitized.base64,
      mimeType: sanitized.mimeType,
      width: sanitized.width,
      height: sanitized.height,
    };
  } finally {
    if (args.fullPage) {
      await cdpSendWithReattach(args.tabId, 'Emulation.clearDeviceMetricsOverride');
    }
  }
};

const handleClick = async (args: BrowserArgs): Promise<string> => {
  if (args.tabId == null) return 'Error: "tabId" is required for the "click" action.';
  if (args.ref == null) return 'Error: "ref" is required for the "click" action.';

  const attachErr = await ensureAttached(args.tabId);
  if (attachErr) return `Error: ${attachErr}`;

  const session = getOrCreateSession(args.tabId);
  const entry = session.refMap.get(args.ref);
  if (!entry) return `Error: Ref [${args.ref}] not found. Run "snapshot" to refresh refs.`;

  try {
    // Resolve backend node to a remote object
    const { object } = await cdpSendWithReattach<{ object: { objectId: string } }>(
      args.tabId,
      'DOM.resolveNode',
      { backendNodeId: entry.backendNodeId },
    );

    // Scroll into view and click
    await cdpSendWithReattach(args.tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', behavior: 'instant' });
        this.click();
      }`,
      awaitPromise: false,
    });

    return `Clicked element [${args.ref}].`;
  } catch (err: unknown) {
    // Fallback: try coordinate-based click via box model
    try {
      const { model } = await cdpSendWithReattach<{
        model: { content: number[] };
      }>(args.tabId, 'DOM.getBoxModel', { backendNodeId: entry.backendNodeId });

      const [x1, y1, x2, , , , _x4, y4] = model.content;
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y4) / 2;

      await ensureTabActive(args.tabId);
      await cdpSendWithReattach(args.tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: cx,
        y: cy,
        button: 'left',
        clickCount: 1,
      });
      await cdpSendWithReattach(args.tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: cx,
        y: cy,
        button: 'left',
        clickCount: 1,
      });

      return `Clicked element [${args.ref}] (via coordinates).`;
    } catch {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error clicking element [${args.ref}]: ${msg}`;
    }
  }
};

const handleType = async (args: BrowserArgs): Promise<string> => {
  if (args.tabId == null) return 'Error: "tabId" is required for the "type" action.';
  if (args.ref == null) return 'Error: "ref" is required for the "type" action.';
  if (!args.text) return 'Error: "text" is required for the "type" action.';

  const attachErr = await ensureAttached(args.tabId);
  if (attachErr) return `Error: ${attachErr}`;

  const session = getOrCreateSession(args.tabId);
  const entry = session.refMap.get(args.ref);
  if (!entry) return `Error: Ref [${args.ref}] not found. Run "snapshot" to refresh refs.`;

  try {
    const { object } = await cdpSendWithReattach<{ object: { objectId: string } }>(
      args.tabId,
      'DOM.resolveNode',
      { backendNodeId: entry.backendNodeId },
    );

    // Focus the element and clear existing value, dispatching input event for framework compat
    await cdpSendWithReattach(args.tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        this.focus();
        if ('value' in this) {
          this.value = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }`,
      awaitPromise: false,
    });

    // Insert text — tab must be active for Input.insertText to work
    await ensureTabActive(args.tabId);
    await cdpSendWithReattach(args.tabId, 'Input.insertText', { text: args.text });

    return `Typed "${args.text.length > 50 ? args.text.slice(0, 50) + '...' : args.text}" into element [${args.ref}].`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error typing into element [${args.ref}]: ${msg}`;
  }
};

const handleEvaluate = async (args: BrowserArgs): Promise<string> => {
  if (args.tabId == null) return 'Error: "tabId" is required for the "evaluate" action.';
  if (!args.expression) return 'Error: "expression" is required for the "evaluate" action.';

  const attachErr = await ensureAttached(args.tabId);
  if (attachErr) return `Error: ${attachErr}`;

  const result = await cdpSendWithReattach<{
    result: { type: string; value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>(args.tabId, 'Runtime.evaluate', {
    expression: args.expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: 10000,
  });

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    return `Error: ${errMsg}`;
  }

  if (result.result.type === 'undefined') return 'undefined';
  if (result.result.value !== undefined) {
    return typeof result.result.value === 'string'
      ? result.result.value
      : JSON.stringify(result.result.value);
  }
  return result.result.description ?? `[${result.result.type}]`;
};

const handleConsole = async (args: BrowserArgs): Promise<string> => {
  if (args.tabId == null) return 'Error: "tabId" is required for the "console" action.';
  const session = sessions.get(args.tabId);
  if (!session) return 'No console data. Debugger may not be attached to this tab.';

  const limit = args.limit ?? 50;
  const entries = session.consoleLogs.slice(-limit);
  if (entries.length === 0) return 'No console messages captured.';

  const lines = entries.map(e => `[${e.type}] ${e.text}`);
  return `Console messages (${entries.length}):\n${lines.join('\n')}`;
};

const handleNetwork = async (args: BrowserArgs): Promise<string> => {
  if (args.tabId == null) return 'Error: "tabId" is required for the "network" action.';
  const session = sessions.get(args.tabId);
  if (!session) return 'No network data. Debugger may not be attached to this tab.';

  const limit = args.limit ?? 50;
  const entries = session.networkRequests.slice(-limit);
  if (entries.length === 0) return 'No network requests captured.';

  const lines = entries.map(e =>
    `${e.method} ${e.url} ${e.status != null ? `→ ${e.status}` : '(pending)'} ${e.type ?? ''}`.trim(),
  );
  return `Network requests (${entries.length}):\n${lines.join('\n')}`;
};

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

const executeBrowser = async (args: BrowserArgs): Promise<string | ScreenshotResult> => {
  browserLog.debug('executeBrowser', { action: args.action, tabId: args.tabId });
  // Coerce tabId/ref to numbers — LLMs sometimes emit string values and the
  // browser extension CSP prevents AJV type coercion from running.
  if (args.tabId != null && typeof args.tabId !== 'number') {
    (args as Record<string, unknown>).tabId = Number(args.tabId);
    if (Number.isNaN(args.tabId)) (args as Record<string, unknown>).tabId = undefined;
  }
  if (args.ref != null && typeof args.ref !== 'number') {
    (args as Record<string, unknown>).ref = Number(args.ref);
    if (Number.isNaN(args.ref)) (args as Record<string, unknown>).ref = undefined;
  }

  // Firefox: delegate to scripting-based implementation (no chrome.debugger)
  if (IS_FIREFOX) {
    return executeBrowserFirefox(args);
  }

  // Visual indicator — highlight the tab while the tool is executing
  const noHighlight = args.action === 'tabs' || args.action === 'close';
  let indicatorTabId: number | undefined = !noHighlight ? (args.tabId ?? undefined) : undefined;

  // Inject before action (when tabId is known upfront)
  if (indicatorTabId != null) {
    await injectControlIndicator(indicatorTabId);
  }

  try {
    let result: string | ScreenshotResult;
    switch (args.action) {
      case 'tabs':
        result = await handleTabs(); break;
      case 'open':
        result = await handleOpen(args); break;
      case 'focus':
        result = await handleFocus(args); break;
      case 'close':
        result = await handleClose(args); break;
      case 'navigate':
        result = await handleNavigate(args); break;
      case 'content':
        result = await handleContent(args); break;
      case 'snapshot':
        result = await handleSnapshot(args); break;
      case 'screenshot':
        result = await handleScreenshot(args); break;
      case 'click':
        result = await handleClick(args); break;
      case 'type':
        result = await handleType(args); break;
      case 'evaluate':
        result = await handleEvaluate(args); break;
      case 'console':
        result = await handleConsole(args); break;
      case 'network':
        result = await handleNetwork(args); break;
      default:
        result = `Error: Unknown action "${args.action}".`;
    }

    // For 'open', highlight the newly created tab (handleOpen sets args.tabId)
    if (!noHighlight && args.action === 'open' && !indicatorTabId && args.tabId != null) {
      indicatorTabId = args.tabId;
      await injectControlIndicator(indicatorTabId);
    }

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    browserLog.error('executeBrowser error', { action: args.action, tabId: args.tabId, error: msg });

    // If the error is debugger-related, fall back to the Firefox (scripting-based) implementation
    // which works on any page without CDP.
    const isDebuggerError = msg.toLowerCase().includes('not attached') ||
      msg.toLowerCase().includes('detached') ||
      msg.toLowerCase().includes('debugger') ||
      msg.toLowerCase().includes('cannot attach');
    if (isDebuggerError) {
      browserLog.info('Falling back to scripting-based implementation', { action: args.action, tabId: args.tabId });
      try {
        
        const fallback = await executeBrowserFirefox(args);
        if (typeof fallback === 'string' && fallback.startsWith('Error:')) {
          return fallback;
        }
        return fallback;
      } catch (fallbackErr) {
        const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        browserLog.error('Scripting fallback also failed', { action: args.action, error: fallbackMsg });
        return `Error: ${msg}. Scripting fallback also failed: ${fallbackMsg}`;
      }
    }

    return `Error: ${msg}`;
  } finally {
    // Remove visual indicator after tool execution completes
    if (indicatorTabId != null) {
      removeControlIndicator(indicatorTabId).catch(() => {});
    }
  }
};

// Export internals for testing
export {
  browserSchema,
  executeBrowser,
  // Exported for testing only
  sessions,
  getOrCreateSession,
  cleanupSession,
  walkNode,
  buildSnapshot,
  isInteractive,
  formatInteractiveNode,
  truncateText,
  collectTextContent,
  MAX_BUFFER,
  MAX_NODES,
  MAX_DEPTH,
  MAX_TEXT_LENGTH,
  MAX_RESULT_CHARS,
  attachFailureCache,
  ATTACH_FAILURE_TTL_MS,
  isSpaHashRoute,
};
export type {
  BrowserArgs,
  ScreenshotResult,
  TabSession,
  CDPNode,
  SnapshotContext,
  RefEntry,
  ConsoleEntry,
  NetworkEntry,
};

const browserToolDef: ToolRegistration = {
  name: 'browser',
  label: 'Browser',
  description:
    'Control browser tabs: list/open/close/focus tabs, navigate to URLs, take DOM snapshots with numbered element refs, take screenshots, click or type on elements by ref, evaluate JavaScript, and view console logs or network requests. Use "snapshot" to understand page content, then "click"/"type" with ref numbers to interact.',
  schema: browserSchema,
  execute: args => executeBrowser(args as BrowserArgs),
  formatResult: (raw): ToolResult => {
    if (typeof raw === 'object' && (raw as ScreenshotResult).__type === 'screenshot') {
      const ss = raw as ScreenshotResult;
      return {
        content: [
          { type: 'text', text: `Screenshot captured (${ss.width}\u00d7${ss.height})` },
          { type: 'image', data: ss.base64, mimeType: ss.mimeType },
        ],
        details: { width: ss.width, height: ss.height },
      };
    }
    return { content: [{ type: 'text', text: raw as string }], details: { output: raw } };
  },
};

export { browserToolDef };
