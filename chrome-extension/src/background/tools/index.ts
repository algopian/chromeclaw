import { agentsListSchema, executeAgentsList } from './agents-list';
import { debuggerSchema, executeDebugger } from './debugger';
import { browserSchema, executeBrowser } from './browser';
import { deepResearchSchema, executeDeepResearch } from './deep-research';
import { createDocumentSchema, executeCreateDocument } from './documents';
import { executeJsSchema, executeJs, executeCustomTool } from './execute-js';
import {
  calendarListSchema,
  calendarCreateSchema,
  calendarUpdateSchema,
  calendarDeleteSchema,
  executeCalendarList,
  executeCalendarCreate,
  executeCalendarUpdate,
  executeCalendarDelete,
} from './google-calendar';
import {
  driveSearchSchema,
  driveReadSchema,
  driveCreateSchema,
  executeDriveSearch,
  executeDriveRead,
  executeDriveCreate,
} from './google-drive';
import {
  gmailSearchSchema,
  gmailReadSchema,
  gmailSendSchema,
  gmailDraftSchema,
  executeGmailSearch,
  executeGmailRead,
  executeGmailSend,
  executeGmailDraft,
} from './google-gmail';
import {
  memorySearchSchema,
  executeMemorySearch,
  memoryGetSchema,
  executeMemoryGet,
} from './memory-tools';
import { schedulerSchema, executeScheduler } from './scheduler';
import {
  spawnSubagentSchema,
  listSubagentsSchema,
  killSubagentSchema,
  executeSpawnSubagent,
  executeListSubagents,
  executeKillSubagent,
} from './subagent';
import { webFetchSchema, executeWebFetch } from './web-fetch';
import { webSearchSchema, executeWebSearch } from './web-search';
import {
  writeSchema,
  executeWrite,
  readSchema,
  executeRead,
  editSchema,
  executeEdit,
  listSchema,
  executeList,
  deleteSchema,
  executeDelete,
  renameSchema,
  executeRename,
} from './workspace';
import { createLogger } from '../logging/logger-buffer';
import { toolConfigStorage, activeAgentStorage, getAgent } from '@extension/storage';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ScreenshotResult } from './browser';
import type { AgentTool } from '../agents';
import type { ToolConfig, CustomToolDef } from '@extension/storage';
import type { TObject } from '@sinclair/typebox';

const toolLog = createLogger('tool');

const TOOL_TIMEOUT_MS = 300_000; // 5 minutes

const withTimeout = <T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${ms}ms`)), ms),
    ),
  ]);

/** Context passed to tool execute functions */
interface ToolContext {
  chatId?: string;
}

// ── Build name -> execute and name -> schema lookup maps ──

const toolLookup = new Map<string, (args: unknown, context?: ToolContext) => Promise<unknown>>();
toolLookup.set('web_search', args => executeWebSearch(args as any));
toolLookup.set('create_document', args => executeCreateDocument(args as any));
toolLookup.set('browser', args => executeBrowser(args as any));
toolLookup.set('write', args => executeWrite(args as any));
toolLookup.set('read', args => executeRead(args as any));
toolLookup.set('edit', args => executeEdit(args as any));
toolLookup.set('list', () => executeList());
toolLookup.set('delete', args => executeDelete(args as any));
toolLookup.set('rename', args => executeRename(args as any));
toolLookup.set('scheduler', (args, context) => executeScheduler(args as any, context));
toolLookup.set('memory_search', args => executeMemorySearch(args as any));
toolLookup.set('memory_get', args => executeMemoryGet(args as any));
toolLookup.set('web_fetch', args => executeWebFetch(args as any));
toolLookup.set('deep_research', (args, context) => executeDeepResearch(args as any, context));
toolLookup.set('agents_list', () => executeAgentsList());
toolLookup.set('execute_javascript', args => executeJs(args as any));
toolLookup.set('spawn_subagent', (args, context) => executeSpawnSubagent(args as any, context));
toolLookup.set('list_subagents', () => executeListSubagents());
toolLookup.set('kill_subagent', args => executeKillSubagent(args as any));
toolLookup.set('gmail_search', args => executeGmailSearch(args as any));
toolLookup.set('gmail_read', args => executeGmailRead(args as any));
toolLookup.set('gmail_send', args => executeGmailSend(args as any));
toolLookup.set('gmail_draft', args => executeGmailDraft(args as any));
toolLookup.set('calendar_list', args => executeCalendarList(args as any));
toolLookup.set('calendar_create', args => executeCalendarCreate(args as any));
toolLookup.set('calendar_update', args => executeCalendarUpdate(args as any));
toolLookup.set('calendar_delete', args => executeCalendarDelete(args as any));
toolLookup.set('drive_search', args => executeDriveSearch(args as any));
toolLookup.set('drive_read', args => executeDriveRead(args as any));
toolLookup.set('drive_create', args => executeDriveCreate(args as any));
toolLookup.set('debugger', args => executeDebugger(args as any));

const schemaLookup = new Map<string, TObject>([
  ['web_search', webSearchSchema],
  ['create_document', createDocumentSchema],
  ['browser', browserSchema],
  ['write', writeSchema],
  ['read', readSchema],
  ['edit', editSchema],
  ['list', listSchema],
  ['delete', deleteSchema],
  ['rename', renameSchema],
  ['scheduler', schedulerSchema],
  ['memory_search', memorySearchSchema],
  ['memory_get', memoryGetSchema],
  ['web_fetch', webFetchSchema],
  ['deep_research', deepResearchSchema],
  ['agents_list', agentsListSchema],
  ['execute_javascript', executeJsSchema],
  ['spawn_subagent', spawnSubagentSchema],
  ['list_subagents', listSubagentsSchema],
  ['kill_subagent', killSubagentSchema],
  ['gmail_search', gmailSearchSchema],
  ['gmail_read', gmailReadSchema],
  ['gmail_send', gmailSendSchema],
  ['gmail_draft', gmailDraftSchema],
  ['calendar_list', calendarListSchema],
  ['calendar_create', calendarCreateSchema],
  ['calendar_update', calendarUpdateSchema],
  ['calendar_delete', calendarDeleteSchema],
  ['drive_search', driveSearchSchema],
  ['drive_read', driveReadSchema],
  ['drive_create', driveCreateSchema],
  ['debugger', debuggerSchema],
]);

/** Build a TypeBox schema from custom tool param definitions */
const buildCustomToolSchema = (params: CustomToolDef['params']) => {
  const props: Record<
    string,
    | ReturnType<typeof Type.String>
    | ReturnType<typeof Type.Number>
    | ReturnType<typeof Type.Boolean>
    | ReturnType<typeof Type.Unknown>
  > = {};
  for (const p of params) {
    switch (p.type) {
      case 'number':
        props[p.name] = Type.Number({ description: p.description });
        break;
      case 'boolean':
        props[p.name] = Type.Boolean({ description: p.description });
        break;
      case 'string':
        props[p.name] = Type.String({ description: p.description });
        break;
      default:
        props[p.name] = Type.Unknown({ description: p.description });
    }
  }
  return Type.Object(props);
};

/**
 * Build pi-agent AgentTool[] based on the user's tool config.
 * Checks each individual tool against enabledTools[tool.name].
 * @param opts.headless - If true, excludes tools with headless exclusion (e.g. scheduler).
 */
const getAgentTools = async (opts?: {
  headless?: boolean;
  chatId?: string;
}): Promise<AgentTool[]> => {
  const config = await toolConfigStorage.get();
  const tools: AgentTool[] = [];

  const isEnabled = (name: string): boolean => config.enabledTools[name] ?? false;

  if (isEnabled('web_search')) {
    tools.push({
      name: 'web_search',
      label: 'Web Search',
      description:
        'Search the web for current information using the configured search provider (Tavily API or browser-based search). Use this when the user asks about recent events, news, or information that may not be in your training data.',
      parameters: webSearchSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeWebSearch(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  if (isEnabled('create_document')) {
    tools.push({
      name: 'create_document',
      label: 'Create Document',
      description:
        'Create a document to share with the user. Include the complete content in the `content` parameter. Use this for substantial content like articles, code, analysis, or structured data. Specify the title, kind (text, code, sheet, or image), and content.',
      parameters: createDocumentSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeCreateDocument(params as any);
        const { content: _content, ...metadata } = result;
        return { content: [{ type: 'text', text: JSON.stringify(metadata) }], details: result };
      },
    });
  }

  if (isEnabled('browser')) {
    tools.push({
      name: 'browser',
      label: 'Browser',
      description:
        'Control browser tabs: list/open/close/focus tabs, navigate to URLs, take DOM snapshots with numbered element refs, take screenshots, click or type on elements by ref, evaluate JavaScript, and view console logs or network requests. Use "snapshot" to understand page content, then "click"/"type" with ref numbers to interact.',
      parameters: browserSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeBrowser(params as any);

        // Screenshot: return image content block so the LLM can see it
        if (typeof result === 'object' && (result as ScreenshotResult).__type === 'screenshot') {
          const ss = result as ScreenshotResult;
          return {
            content: [
              { type: 'text', text: `Screenshot captured (${ss.width}\u00d7${ss.height})` },
              { type: 'image', data: ss.base64, mimeType: ss.mimeType },
            ],
            details: { width: ss.width, height: ss.height },
          };
        }

        return { content: [{ type: 'text', text: result as string }], details: { output: result } };
      },
    });
  }

  // Workspace tools
  if (isEnabled('write')) {
    tools.push({
      name: 'write',
      label: 'Write',
      description:
        'Write content to a workspace file. Use this to save notes, memories, or context for future sessions (e.g. memory/notes.md, notes/project.md).',
      parameters: writeSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeWrite(params as any);
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  if (isEnabled('read')) {
    tools.push({
      name: 'read',
      label: 'Read',
      description:
        'Read a workspace file by name. Use this to retrieve workspace context, user preferences, or previously saved notes.',
      parameters: readSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeRead(params as any);
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  if (isEnabled('edit')) {
    tools.push({
      name: 'edit',
      label: 'Edit',
      description:
        'Edit a workspace file with find-and-replace. Finds an exact unique match of oldText and replaces it with newText.',
      parameters: editSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeEdit(params as any);
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  if (isEnabled('list')) {
    tools.push({
      name: 'list',
      label: 'List',
      description: 'List all workspace files with their names, owners, and enabled status.',
      parameters: listSchema,
      execute: async () => {
        const result = await executeList();
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  if (isEnabled('delete')) {
    tools.push({
      name: 'delete',
      label: 'Delete',
      description:
        'Delete a workspace file by path. Cannot delete predefined system files.',
      parameters: deleteSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeDelete(params as any);
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  if (isEnabled('rename')) {
    tools.push({
      name: 'rename',
      label: 'Rename',
      description: 'Rename/move a workspace file to a new path.',
      parameters: renameSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeRename(params as any);
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  // Scheduler tool — excluded in headless mode
  if (isEnabled('scheduler') && !opts?.headless) {
    tools.push({
      name: 'scheduler',
      label: 'Scheduler',
      description:
        'Manage scheduled and recurring tasks. Actions: status, list, add (create task), update (modify task), remove (delete task), run (force-run now), runs (view history). Use this when the user asks to schedule, remind, or automate something.',
      parameters: schedulerSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeScheduler(params as any);
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  // Memory tools
  if (isEnabled('memory_search')) {
    tools.push({
      name: 'memory_search',
      label: 'Memory Search',
      description:
        'Search memory files using keyword matching (BM25). Returns ranked results with file paths, line ranges, and snippets. Use this to recall prior work, decisions, preferences, or stored knowledge.',
      parameters: memorySearchSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeMemorySearch(params as any);
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  if (isEnabled('memory_get')) {
    tools.push({
      name: 'memory_get',
      label: 'Memory Get',
      description:
        'Read specific lines from a memory or workspace file. Use this after memory_search to get full context around a search result.',
      parameters: memoryGetSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeMemoryGet(params as any);
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  // Web fetch tool
  if (isEnabled('web_fetch')) {
    tools.push({
      name: 'web_fetch',
      label: 'Fetch URL',
      description:
        'Fetch and extract readable text content from a URL. Use this to read web pages, articles, documentation, or any publicly accessible URL. Returns clean text with HTML stripped by default.',
      parameters: webFetchSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeWebFetch(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  // Deep research tool — excluded in headless mode (spawns subagent)
  if (isEnabled('deep_research') && !opts?.headless) {
    tools.push({
      name: 'deep_research',
      label: 'Deep Research',
      description:
        'Conduct deep multi-step web research on a topic in the background. Returns immediately — results appear as a system message when complete.',
      parameters: deepResearchSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeDeepResearch(params as any, { chatId: opts?.chatId });
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  // Agents list tool — excluded in headless mode
  if (isEnabled('agents_list') && !opts?.headless) {
    tools.push({
      name: 'agents_list',
      label: 'List Agents',
      description: 'List available agents with their IDs, names, and active status.',
      parameters: agentsListSchema,
      execute: async () => {
        const result = await executeAgentsList();
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  // Execute Javascript tool
  if (isEnabled('execute_javascript')) {
    tools.push({
      name: 'execute_javascript',
      label: 'Execute Javascript',
      description:
        'Execute JavaScript code in a sandboxed browser tab (or a specific tab via tabId), ' +
        'bundle and run multiple workspace files, or register/unregister workspace files as custom tools. ' +
        'Actions: execute (run JS code or a workspace file), bundle (load multiple files as modules), ' +
        'register (parse tool metadata and save), unregister (remove a custom tool). ' +
        'Supports configurable timeout, module registry (exportAs), and console output capture.',
      parameters: executeJsSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeJs(params as any);
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  // Gmail tools
  if (isEnabled('gmail_search')) {
    tools.push({
      name: 'gmail_search',
      label: 'Gmail Search',
      description:
        'Search Gmail for emails. Supports Gmail search syntax (e.g. "is:unread", "from:alice@example.com", "newer_than:7d"). Returns message ID, from, to, subject, snippet, and date.',
      parameters: gmailSearchSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeGmailSearch(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  if (isEnabled('gmail_read')) {
    tools.push({
      name: 'gmail_read',
      label: 'Gmail Read',
      description:
        'Read the full content of a Gmail email by message ID. Returns parsed headers and plain text body.',
      parameters: gmailReadSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeGmailRead(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  if (isEnabled('gmail_send')) {
    tools.push({
      name: 'gmail_send',
      label: 'Gmail Send',
      description: 'Send an email via Gmail. Requires to, subject, and body. Optional cc and bcc.',
      parameters: gmailSendSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeGmailSend(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  if (isEnabled('gmail_draft')) {
    tools.push({
      name: 'gmail_draft',
      label: 'Gmail Draft',
      description:
        'Create a draft email in Gmail. Same parameters as sending but saves as draft instead.',
      parameters: gmailDraftSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeGmailDraft(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  // Calendar tools
  if (isEnabled('calendar_list')) {
    tools.push({
      name: 'calendar_list',
      label: 'Calendar List',
      description:
        'List Google Calendar events within a time range. Returns summary, start/end times, location, attendees, and description.',
      parameters: calendarListSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeCalendarList(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  if (isEnabled('calendar_create')) {
    tools.push({
      name: 'calendar_create',
      label: 'Calendar Create',
      description:
        'Create a Google Calendar event. Requires summary, startTime, and endTime in ISO 8601 format.',
      parameters: calendarCreateSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeCalendarCreate(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  if (isEnabled('calendar_update')) {
    tools.push({
      name: 'calendar_update',
      label: 'Calendar Update',
      description:
        'Update an existing Google Calendar event. Requires eventId plus any fields to change.',
      parameters: calendarUpdateSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeCalendarUpdate(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  if (isEnabled('calendar_delete')) {
    tools.push({
      name: 'calendar_delete',
      label: 'Calendar Delete',
      description: 'Delete a Google Calendar event by event ID.',
      parameters: calendarDeleteSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeCalendarDelete(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  // Drive tools
  if (isEnabled('drive_search')) {
    tools.push({
      name: 'drive_search',
      label: 'Drive Search',
      description:
        'Search Google Drive for files. Supports Drive search syntax. Returns file ID, name, mimeType, modifiedTime, size, and webViewLink.',
      parameters: driveSearchSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeDriveSearch(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  if (isEnabled('drive_read')) {
    tools.push({
      name: 'drive_read',
      label: 'Drive Read',
      description:
        'Read content from a Google Drive file. For Google Docs/Sheets/Slides, exports as plain text. For other files, downloads content (with size limit).',
      parameters: driveReadSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeDriveRead(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  if (isEnabled('drive_create')) {
    tools.push({
      name: 'drive_create',
      label: 'Drive Create',
      description:
        'Create a new file in Google Drive. Requires name and content. Optional mimeType and folderId.',
      parameters: driveCreateSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeDriveCreate(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }

  // Debugger tool
  if (isEnabled('debugger')) {
    tools.push({
      name: 'debugger',
      label: 'Debugger',
      description:
        'Send Chrome DevTools Protocol (CDP) commands to browser tabs. Actions: send (execute a CDP command), attach/detach (manage debugger session), list_targets (list debuggable targets).',
      parameters: debuggerSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeDebugger(params as any);
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  // Subagent tools — excluded in headless mode (no nesting)
  if (isEnabled('spawn_subagent') && !opts?.headless) {
    tools.push({
      name: 'spawn_subagent',
      label: 'Spawn Subagent',
      description:
        'Spawn a background subagent to work on a task asynchronously. Returns immediately — the subagent runs in the background and its results will appear as a system message in the chat when complete. Do NOT poll with list_subagents after spawning. Use for complex tasks that need multiple tool calls.',
      parameters: spawnSubagentSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeSpawnSubagent(params as any, { chatId: opts?.chatId });
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  if (isEnabled('list_subagents') && !opts?.headless) {
    tools.push({
      name: 'list_subagents',
      label: 'List Subagents',
      description: 'List active and recent subagent runs with their status, task, and duration.',
      parameters: listSubagentsSchema,
      execute: async () => {
        const result = await executeListSubagents();
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  if (isEnabled('kill_subagent') && !opts?.headless) {
    tools.push({
      name: 'kill_subagent',
      label: 'Kill Subagent',
      description: 'Cancel a running subagent by its run ID.',
      parameters: killSubagentSchema,
      execute: async (_toolCallId, params) => {
        const result = await executeKillSubagent(params as any);
        return { content: [{ type: 'text', text: result }], details: { output: result } };
      },
    });
  }

  // Inject agent-specific custom tools
  try {
    const agentId = await activeAgentStorage.get();
    if (agentId) {
      const agent = await getAgent(agentId);
      const customTools = agent?.customTools ?? [];
      for (const ct of customTools) {
        if (!config.enabledTools[ct.name] && !agent?.toolConfig?.enabledTools[ct.name]) continue;
        tools.push({
          name: ct.name,
          label: ct.name,
          description: ct.description,
          parameters: buildCustomToolSchema(ct.params),
          execute: async (_toolCallId, params) => {
            const result = await executeCustomTool(ct, params as Record<string, unknown>, agentId);
            return { content: [{ type: 'text', text: result }], details: { output: result } };
          },
        });
      }
    }
  } catch (err) {
    toolLog.warn('Failed to load custom tools', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return tools;
};

/**
 * Execute a tool by name with the given arguments.
 *
 * Convention: individual tool executors return error strings on failure (never throw).
 * This wrapper adds a try/catch as a safety net — if an executor does throw, the error
 * is logged and re-thrown so the caller can surface it to the LLM.
 */
const executeTool = async (
  toolName: string,
  args: unknown,
  context?: ToolContext,
): Promise<unknown> => {
  toolLog.info('Execute', { toolName });
  toolLog.trace('Execute args', { toolName, args });
  try {
    // Validate args against schema when available
    const schema = schemaLookup.get(toolName);
    if (schema) {
      try {
        if (!Value.Check(schema, args)) {
          const errors = [...Value.Errors(schema, args)];
          const details = errors.map(e => `${e.path}: ${e.message}`).join('; ');
          return `Error: Invalid arguments for tool "${toolName}": ${details}`;
        }
      } catch {
        // Schema may not be a valid TypeBox schema (e.g. in tests) — skip validation
      }
    }

    const execute = toolLookup.get(toolName);
    if (execute) {
      const result = await withTimeout(execute(args, context), TOOL_TIMEOUT_MS, toolName);
      toolLog.trace('Execute result', {
        toolName,
        resultType: typeof result,
        isArray: Array.isArray(result),
        length: Array.isArray(result) ? result.length : undefined,
      });
      toolLog.debug('Complete', { toolName });
      return result;
    }

    // Check if it's a custom tool for the active agent
    const agentId = await activeAgentStorage.get();
    if (agentId) {
      const agent = await getAgent(agentId);
      const ct = agent?.customTools?.find(t => t.name === toolName);
      if (ct) {
        const result = await withTimeout(
          executeCustomTool(ct, (args ?? {}) as Record<string, unknown>, agentId),
          TOOL_TIMEOUT_MS,
          toolName,
        );
        toolLog.debug('Complete (custom)', { toolName });
        return result;
      }
    }

    throw new Error(`Unknown tool: ${toolName}`);
  } catch (err) {
    toolLog.error('Failed', { toolName, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
};

/**
 * Get the tool config.
 */
const getToolConfig = async (): Promise<ToolConfig> => toolConfigStorage.get();

/** Returns the set of tool names that have actual implementations (schemas + executors). */
const getImplementedToolNames = (): Set<string> => new Set(schemaLookup.keys());

export {
  getAgentTools,
  executeTool,
  getToolConfig,
  getImplementedToolNames,
  withTimeout,
  TOOL_TIMEOUT_MS,
};
