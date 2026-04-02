import { cdpSend, cdpAttach } from './cdp';
import { injectControlIndicator, removeControlIndicator } from './tab-indicator';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const debuggerSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal('send'),
      Type.Literal('attach'),
      Type.Literal('detach'),
      Type.Literal('list_targets'),
    ],
    {
      description:
        'The debugger action to perform. "send" sends a CDP command, "attach"/"detach" manage the debugger session, "list_targets" lists debuggable targets.',
    },
  ),
  tabId: Type.Optional(
    Type.Number({
      description: 'Target tab ID (required for send, attach, and detach)',
    }),
  ),
  method: Type.Optional(
    Type.String({
      description: 'CDP method name, e.g. "Runtime.evaluate" (required for send)',
    }),
  ),
  params: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'CDP command parameters (optional, for send)',
    }),
  ),
});

type DebuggerArgs = Static<typeof debuggerSchema>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

const executeDebugger = async (args: DebuggerArgs): Promise<string> => {
  const highlightTabId = (args.action === 'attach' || args.action === 'send') ? args.tabId : undefined;
  if (highlightTabId != null) await injectControlIndicator(highlightTabId);
  try {
    switch (args.action) {
      case 'list_targets': {
        const targets = await new Promise<chrome.debugger.TargetInfo[]>((resolve, reject) => {
          chrome.debugger.getTargets(result => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(result);
            }
          });
        });
        return JSON.stringify(targets, null, 2);
      }

      case 'attach': {
        if (args.tabId == null) return 'Error: tabId is required for attach';
        const err = await cdpAttach(args.tabId);
        if (err) return `Error: ${err}`;
        return `Debugger attached to tab ${args.tabId}`;
      }

      case 'detach': {
        if (args.tabId == null) return 'Error: tabId is required for detach';
        await new Promise<void>((resolve, reject) => {
          chrome.debugger.detach({ tabId: args.tabId! }, () => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve();
            }
          });
        });
        return `Debugger detached from tab ${args.tabId}`;
      }

      case 'send': {
        if (args.tabId == null) return 'Error: tabId is required for send';
        if (!args.method) return 'Error: method is required for send';
        const result = await cdpSend(args.tabId, args.method, args.params);
        return JSON.stringify(result, null, 2);
      }

      default:
        return `Error: Unknown action "${args.action}"`;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  } finally {
    if (highlightTabId != null) removeControlIndicator(highlightTabId).catch(() => {});
  }
};

export { debuggerSchema, executeDebugger };
export type { DebuggerArgs };

// ── Tool registration ──
import type { ToolRegistration } from './tool-registration';

const debuggerToolDef: ToolRegistration = {
  name: 'debugger',
  label: 'Debugger',
  description:
    'Send Chrome DevTools Protocol (CDP) commands to browser tabs. Actions: send (execute a CDP command), attach/detach (manage debugger session), list_targets (list debuggable targets).',
  schema: debuggerSchema,
  chromeOnly: true,
  execute: args => executeDebugger(args as DebuggerArgs),
};

export { debuggerToolDef };
