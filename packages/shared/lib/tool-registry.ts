/**
 * Tool registry metadata — shared between background SW and UI.
 *
 * Each group contains 1+ individual tools. Users toggle tools individually;
 * groups are for visual grouping in the UI only.
 */

interface ToolMeta {
  /** LLM-facing tool name, e.g. 'web_search', 'chat_list' */
  name: string;
  /** UI label, e.g. 'Get Weather' */
  label: string;
  /** Short UI description */
  description: string;
  /** Default enabled state */
  defaultEnabled: boolean;
  /** If true, this tool is Chrome-only and should be hidden on Firefox */
  chromeOnly?: boolean;
}

interface ToolGroupMeta {
  /** Group identifier (UI heading only, not a storage key) */
  groupKey: string;
  /** Group heading label */
  label: string;
  /** Lucide icon name string, e.g. 'CloudIcon' */
  iconName: string;
  /** Individual tools in this group */
  tools: ToolMeta[];
  /** Whether this group has a custom sub-config UI (e.g. webSearch provider) */
  hasSubConfig?: boolean;
  /** System prompt hint included when any tool in this group is enabled */
  promptHint?: string;
}

const toolRegistryMeta: readonly ToolGroupMeta[] = [
  {
    groupKey: 'webSearch',
    label: 'Web Search',
    iconName: 'SearchIcon',
    hasSubConfig: true,
    promptHint:
      'You have access to a web search tool. Use it when the user asks about current events, recent news, or information that may have changed since your training data. Summarize the search results and cite your sources.',
    tools: [
      {
        name: 'web_search',
        label: 'Web Search',
        description: 'Search the web for current information',
        defaultEnabled: true,
      },
    ],
  },
  {
    groupKey: 'webFetch',
    label: 'Web Fetch',
    iconName: 'LinkIcon',
    tools: [
      {
        name: 'web_fetch',
        label: 'Fetch URL',
        description: 'Fetch and extract readable content from URLs',
        defaultEnabled: true,
      },
    ],
  },
  {
    groupKey: 'documents',
    label: 'Documents',
    iconName: 'FileTextIcon',
    promptHint: `You can create and reference documents during the conversation using the create_document tool.

- **create_document**: Use this to create substantial content like articles, code, analysis, or structured data. Include the complete content in the \`content\` parameter. Good for:
  - Text: Articles, essays, reports, summaries, mermaid diagrams (kind: "text")
  - Code: Scripts, programs, code snippets (kind: "code")
  - Sheets: Tables, CSV data, spreadsheets (kind: "sheet")
  - Images: Diagrams, illustrations described as SVG or base64 (kind: "image")

When creating documents, prefer creating an artifact over including long content inline in the conversation. For short responses (under 10 lines), respond inline instead.`,
    tools: [
      {
        name: 'create_document',
        label: 'Create Document',
        description: 'Create a new document (artifact)',
        defaultEnabled: true,
      },
    ],
  },
  {
    groupKey: 'browser',
    label: 'Browser Control',
    iconName: 'MonitorIcon',
    tools: [
      {
        name: 'browser',
        label: 'Browser',
        description:
          'Control browser tabs, navigate pages, interact with elements, and run JavaScript',
        defaultEnabled: true,
      },
    ],
  },
  {
    groupKey: 'workspace',
    label: 'Workspace',
    iconName: 'HardDriveIcon',
    tools: [
      {
        name: 'write',
        label: 'Write',
        description: 'Write workspace files for persistent context',
        defaultEnabled: true,
      },
      {
        name: 'read',
        label: 'Read',
        description: 'Read workspace files',
        defaultEnabled: true,
      },
      {
        name: 'edit',
        label: 'Edit',
        description: 'Edit workspace files with find-and-replace',
        defaultEnabled: true,
      },
      {
        name: 'list',
        label: 'List',
        description: 'List available workspace files',
        defaultEnabled: true,
      },
      {
        name: 'delete',
        label: 'Delete',
        description: 'Delete workspace files',
        defaultEnabled: true,
      },
      {
        name: 'rename',
        label: 'Rename',
        description: 'Rename/move workspace files',
        defaultEnabled: true,
      },
    ],
  },
  {
    groupKey: 'memory',
    label: 'Memory',
    iconName: 'BrainIcon',
    promptHint: `## Memory Recall

You have access to memory_search and memory_get tools for recalling information from memory files.

**Before answering questions about prior work, decisions, dates, people, preferences, or todos:**
1. Run memory_search with relevant keywords
2. Use memory_get to pull specific lines for precise context
3. Include Source: <path#Lstart-Lend> citations when referencing memory

If memory_search returns no results, tell the user you checked but found nothing relevant.
Do NOT guess information that could be in your memory files — search first.`,
    tools: [
      {
        name: 'memory_search',
        label: 'Search',
        description: 'Search memory files by query',
        defaultEnabled: true,
      },
      {
        name: 'memory_get',
        label: 'Get',
        description: 'Retrieve a specific memory file',
        defaultEnabled: true,
      },
    ],
  },
  {
    groupKey: 'scheduler',
    label: 'Scheduler',
    iconName: 'CalendarClockIcon',
    promptHint: `## Scheduled Tasks

You have access to a scheduler tool that lets you create and manage scheduled/recurring tasks.

**Actions:**
- \`status\`: Check scheduler status
- \`list\`: List all active tasks (use includeDisabled:true to include disabled)
- \`add\`: Create a new scheduled task (requires job object)
- \`update\`: Modify an existing task (requires taskId + patch)
- \`remove\`: Delete a task (requires taskId)
- \`run\`: Force-run a task immediately (requires taskId)
- \`runs\`: View run history for a task (requires taskId)

**Schedule types:**
- \`at\`: One-shot at absolute time — \`{ "kind": "at", "at": "<ISO-8601>" }\` (e.g. \`"2026-02-21T07:30:00Z"\` or \`"2026-02-20T23:30:00-08:00"\`). Always use ISO 8601 strings with timezone — do NOT compute unix ms manually.
- \`every\`: Recurring interval — \`{ "kind": "every", "everyMs": <ms>, "anchor": "<optional-ISO-8601-start>" }\`

**Payload types:**
- \`agentTurn\`: Creates a new chat and runs the LLM with the given message — \`{ "kind": "agentTurn", "message": "<prompt>" }\`
- \`chatInject\`: Injects a message into an existing chat — \`{ "kind": "chatInject", "chatId": "<id>", "message": "<text>" }\`

Task results are automatically delivered to the user's active messaging channel (e.g. Telegram) unless overridden with a custom delivery target.

When the user asks to schedule something, create a task with an appropriate schedule and payload. Use descriptive names.`,
    tools: [
      {
        name: 'scheduler',
        label: 'Scheduler',
        description: 'Manage scheduled and recurring tasks',
        defaultEnabled: true,
      },
    ],
  },
  {
    groupKey: 'sessions',
    label: 'Sessions',
    iconName: 'MessagesSquareIcon',
    promptHint:
      'You can manage multiple chat sessions. Use chat_list to see recent conversations, chat_history to read a past conversation, chat_send to message another chat, and chat_spawn to create a background chat for autonomous tasks. Use chat_status to check if a spawned chat is still running.',
    tools: [
      {
        name: 'chat_list',
        label: 'List Chats',
        description: 'List recent conversations',
        defaultEnabled: true,
      },
      {
        name: 'chat_history',
        label: 'Chat History',
        description: 'Read message history of a chat',
        defaultEnabled: true,
      },
      {
        name: 'chat_send',
        label: 'Send Message',
        description: 'Send a message to another chat',
        defaultEnabled: true,
      },
      {
        name: 'chat_spawn',
        label: 'Spawn Chat',
        description: 'Spawn a new background chat',
        defaultEnabled: true,
      },
      {
        name: 'chat_status',
        label: 'Chat Status',
        description: 'Get the status of a chat',
        defaultEnabled: true,
      },
    ],
  },
  {
    groupKey: 'agents',
    label: 'Agents',
    iconName: 'UsersIcon',
    tools: [
      {
        name: 'agents_list',
        label: 'List Agents',
        description: 'List available agents',
        defaultEnabled: true,
      },
    ],
  },
  {
    groupKey: 'subagents',
    label: 'Subagents',
    iconName: 'WorkflowIcon',
    promptHint: `## Subagents

Use spawn_subagent to run tasks in the background when the user requests multiple independent tasks in parallel or a single task needing 3+ sequential tool calls. Provide a clear, self-contained task description with all context — subagents cannot access memory or ask follow-ups. For simple tasks (1–2 tool calls, single lookups), handle them directly instead. Use list_subagents to check status and kill_subagent to cancel. When a subagent completes, briefly summarize its findings.`,
    tools: [
      {
        name: 'spawn_subagent',
        label: 'Spawn Subagent',
        description: 'Spawn a background subagent for a task',
        defaultEnabled: true,
      },
      {
        name: 'list_subagents',
        label: 'List Subagents',
        description: 'List active and recent subagent runs',
        defaultEnabled: true,
      },
      {
        name: 'kill_subagent',
        label: 'Kill Subagent',
        description: 'Cancel a running subagent',
        defaultEnabled: true,
      },
    ],
  },
  {
    groupKey: 'deepResearch',
    label: 'Deep Research',
    iconName: 'TelescopeIcon',
    hasSubConfig: true,
    tools: [
      {
        name: 'deep_research',
        label: 'Deep Research',
        description: 'Multi-step web research with report generation',
        defaultEnabled: true,
      },
    ],
  },
  {
    groupKey: 'executeJs',
    label: 'Execute Javascript',
    iconName: 'CodeIcon',
    promptHint:
      'You have access to execute_javascript for running JS code. Use `return` to produce output; console.log/warn/error are captured automatically. ' +
      'Set `timeout` (up to 300000ms) for long-running code. Use `tabId` to run in a browser tab instead of the sandbox (for DOM/cookie access). ' +
      'For multi-file projects: use `exportAs` to store a file\'s return value as `window.__modules[name]`, or use `action: "bundle"` with a `files` array to load multiple workspace files as modules at once.',
    tools: [
      {
        name: 'execute_javascript',
        label: 'Execute Javascript',
        description: 'Execute JavaScript and create custom tools',
        defaultEnabled: true,
      },
    ],
  },
  {
    groupKey: 'gmail',
    label: 'Gmail',
    iconName: 'MailIcon',
    hasSubConfig: true,
    promptHint:
      'You have access to Gmail tools. Use gmail_search to find emails (supports Gmail search syntax like "is:unread", "from:alice@example.com", "newer_than:7d"). Use gmail_read to get full email content. Use gmail_send to send emails and gmail_draft to create drafts. Always confirm with the user before sending emails.',
    tools: [
      {
        name: 'gmail_search',
        label: 'Search Emails',
        description: 'Search Gmail using Gmail search syntax',
        defaultEnabled: false,
      },
      {
        name: 'gmail_read',
        label: 'Read Email',
        description: 'Read full email content by message ID',
        defaultEnabled: false,
      },
      {
        name: 'gmail_send',
        label: 'Send Email',
        description: 'Send an email via Gmail',
        defaultEnabled: false,
      },
      {
        name: 'gmail_draft',
        label: 'Create Draft',
        description: 'Create a draft email in Gmail',
        defaultEnabled: false,
      },
    ],
  },
  {
    groupKey: 'calendar',
    label: 'Google Calendar',
    iconName: 'CalendarIcon',
    hasSubConfig: true,
    promptHint:
      'You have access to Google Calendar tools. Use calendar_list to view upcoming events. Use calendar_create to schedule new events (requires summary, startTime, endTime in ISO 8601). Use calendar_update to modify events and calendar_delete to remove them. Always confirm with the user before creating, updating, or deleting events.',
    tools: [
      {
        name: 'calendar_list',
        label: 'List Events',
        description: 'List upcoming calendar events',
        defaultEnabled: false,
      },
      {
        name: 'calendar_create',
        label: 'Create Event',
        description: 'Create a new calendar event',
        defaultEnabled: false,
      },
      {
        name: 'calendar_update',
        label: 'Update Event',
        description: 'Update an existing calendar event',
        defaultEnabled: false,
      },
      {
        name: 'calendar_delete',
        label: 'Delete Event',
        description: 'Delete a calendar event',
        defaultEnabled: false,
      },
    ],
  },
  {
    groupKey: 'drive',
    label: 'Google Drive',
    iconName: 'HardDriveDownloadIcon',
    hasSubConfig: true,
    promptHint:
      'You have access to Google Drive tools. Use drive_search to find files (supports Drive search syntax). Use drive_read to read file content (Google Docs/Sheets/Slides are exported as text). Use drive_create to create new files. Always confirm with the user before creating files.',
    tools: [
      {
        name: 'drive_search',
        label: 'Search Files',
        description: 'Search Google Drive for files',
        defaultEnabled: false,
      },
      {
        name: 'drive_read',
        label: 'Read File',
        description: 'Read content from a Drive file',
        defaultEnabled: false,
      },
      {
        name: 'drive_create',
        label: 'Create File',
        description: 'Create a new file in Google Drive',
        defaultEnabled: false,
      },
    ],
  },
  {
    groupKey: 'debugger',
    label: 'Debugger',
    iconName: 'BugIcon',
    promptHint:
      'You have access to a debugger tool that sends Chrome DevTools Protocol (CDP) commands to browser tabs. ' +
      'Use "list_targets" to discover debuggable targets, "attach"/"detach" to manage sessions, and "send" with a CDP method and params to execute protocol commands.',
    tools: [
      {
        name: 'debugger',
        label: 'Debugger',
        description: 'Send Chrome DevTools Protocol commands to browser tabs',
        defaultEnabled: false,
        chromeOnly: true,
      },
    ],
  },
] as const;

/** Build default enabledTools map from registry metadata (keyed by tool name). */
const getDefaultEnabledTools = (): Record<string, boolean> => {
  const defaults: Record<string, boolean> = {};
  for (const group of toolRegistryMeta) {
    for (const tool of group.tools) {
      defaults[tool.name] = tool.defaultEnabled;
    }
  }
  return defaults;
};

interface ToolPromptHintSource {
  name: string;
  promptHint?: string;
}

/**
 * Resolve prompt hints from the static tool registry and optional custom tools.
 * Returns an array of prompt hint strings for all enabled tools that have hints.
 */
const resolveToolPromptHints = (
  enabledTools: Record<string, boolean>,
  customTools?: ToolPromptHintSource[],
  availableTools?: Set<string>,
): string[] => {
  const hints: string[] = [];
  for (const group of toolRegistryMeta) {
    if (!group.promptHint) continue;
    if (group.tools.some(t => enabledTools[t.name] && (!availableTools || availableTools.has(t.name))))
      hints.push(group.promptHint);
  }
  if (customTools) {
    for (const ct of customTools) {
      if (ct.promptHint && enabledTools[ct.name]) hints.push(ct.promptHint);
    }
  }
  return hints;
};

interface ToolListingEntry {
  name: string;
  description: string;
}

/**
 * Resolve the list of enabled tool names + descriptions for the system prompt.
 * Iterates the static registry and optional custom tools, returning entries
 * for all tools that are enabled.
 */
const resolveToolListings = (
  enabledTools: Record<string, boolean>,
  customTools?: { name: string; description?: string }[],
  availableTools?: Set<string>,
): ToolListingEntry[] => {
  const listings: ToolListingEntry[] = [];
  for (const group of toolRegistryMeta) {
    for (const t of group.tools) {
      if (enabledTools[t.name] && (!availableTools || availableTools.has(t.name)))
        listings.push({ name: t.name, description: t.description });
    }
  }
  if (customTools) {
    for (const ct of customTools) {
      if (enabledTools[ct.name] && ct.description) {
        listings.push({ name: ct.name, description: ct.description });
      }
    }
  }
  return listings;
};

export type { ToolMeta, ToolGroupMeta, ToolPromptHintSource, ToolListingEntry };
export {
  toolRegistryMeta,
  getDefaultEnabledTools,
  resolveToolPromptHints,
  resolveToolListings,
};
