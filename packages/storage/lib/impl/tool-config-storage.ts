import { createStorage, StorageEnum } from '../base/index.js';

type WebSearchProvider = 'tavily' | 'browser';
type BrowserSearchEngine = 'google' | 'bing' | 'duckduckgo';

interface WebSearchProviderConfig {
  provider: WebSearchProvider;
  tavily: { apiKey: string };
  browser: { engine: BrowserSearchEngine };
}

interface DeepResearchConfig {
  maxSources: number;
  maxIterations: number;
  maxDepth: number;
  timeoutMs: number;
}

interface ToolConfig {
  enabledTools: Record<string, boolean>;
  webSearchConfig: WebSearchProviderConfig;
  deepResearchConfig?: DeepResearchConfig;
  /** User-provided Google OAuth client ID. When set, tools use launchWebAuthFlow instead of getAuthToken. */
  googleClientId?: string;
}

const defaultWebSearchConfig: WebSearchProviderConfig = {
  provider: 'browser',
  tavily: { apiKey: '' },
  browser: { engine: 'google' },
};

const defaultDeepResearchConfig: DeepResearchConfig = {
  maxSources: 5,
  maxIterations: 2,
  maxDepth: 3,
  timeoutMs: 120_000,
};

/**
 * Default enabledTools values keyed by individual tool name.
 * Must stay in sync with toolRegistryMeta in @extension/shared.
 * Defined here locally to avoid circular dependency (shared depends on storage).
 */
const defaultEnabledTools: Record<string, boolean> = {
  web_search: true,
  web_fetch: true,
  create_document: true,
  browser: true,
  write: true,
  read: true,
  edit: true,
  list: true,
  delete: true,
  rename: true,
  memory_search: true,
  memory_get: true,
  scheduler: true,
  chat_list: true,
  chat_history: true,
  chat_send: true,
  chat_spawn: true,
  chat_status: true,
  agents_list: true,
  deep_research: true,
  spawn_subagent: true,
  list_subagents: true,
  kill_subagent: true,
  execute_javascript: true,
  gmail_search: false,
  gmail_read: false,
  gmail_send: false,
  gmail_draft: false,
  calendar_list: false,
  calendar_create: false,
  calendar_update: false,
  calendar_delete: false,
  drive_search: false,
  drive_read: false,
  drive_create: false,
};

const defaultToolConfig: ToolConfig = {
  enabledTools: { ...defaultEnabledTools },
  webSearchConfig: defaultWebSearchConfig,
};

const rawToolConfigStorage = createStorage<ToolConfig>('tool-config', defaultToolConfig, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

/** Wrapper that merges stored config with defaults to handle missing keys from older versions. */
const toolConfigStorage = {
  get: async (): Promise<ToolConfig> => {
    const stored = await rawToolConfigStorage.get();
    // Cast to Record for legacy field access — older storage may contain keys not in current ToolConfig
    const raw = stored as unknown as Record<string, unknown>;

    // Build enabledTools with defaults, then merge stored values
    const defaults = { ...defaultEnabledTools };
    const storedEnabledTools = stored.enabledTools ?? {};
    const enabledTools: Record<string, boolean> = { ...defaults, ...storedEnabledTools };

    // Migrate legacy boolean fields -> enabledTools (one-time migration)
    let migrated = false;
    const LEGACY_TOOL_KEYS = ['weather', 'webSearch', 'webFetch', 'documents', 'browser'];
    for (const key of LEGACY_TOOL_KEYS) {
      if (typeof raw[key] === 'boolean' && !(key in storedEnabledTools)) {
        enabledTools[key] = raw[key] as boolean;
        migrated = true;
      }
    }

    // Migrate old group-level keys -> per-tool keys
    // Detects keys that are group names (not tool names) and expands them.
    const GROUP_TO_TOOLS: Record<string, string[]> = {
      weather: [], // legacy group key — weather tool removed, just clean up the key
      webFetch: ['web_fetch'],
      documents: ['create_document'],
      workspace: ['write', 'read', 'edit', 'list', 'delete', 'rename'],
      memory: ['memory_search', 'memory_get'],
      sessions: ['chat_list', 'chat_history', 'chat_send', 'chat_spawn', 'chat_status'],
    };
    for (const [groupKey, toolNames] of Object.entries(GROUP_TO_TOOLS)) {
      if (groupKey in enabledTools && !(groupKey in defaultEnabledTools)) {
        const groupValue = enabledTools[groupKey];
        for (const toolName of toolNames) {
          if (!(toolName in storedEnabledTools)) {
            enabledTools[toolName] = groupValue;
          }
        }
        delete enabledTools[groupKey];
        migrated = true;
      }
    }

    // Rename workspace_* → short names, and camelCase tool names → snake_case
    const RENAME_TOOLS: Record<string, string> = {
      workspace_write: 'write',
      workspace_read: 'read',
      workspace_list: 'list',
      execute_js: 'execute_javascript',
      webSearch: 'web_search',
      createDocument: 'create_document',
      agent_manager: 'agents_list',
    };
    for (const [oldName, newName] of Object.entries(RENAME_TOOLS)) {
      if (oldName in enabledTools) {
        // Only copy value if the new key wasn't explicitly stored
        if (!(newName in storedEnabledTools)) {
          enabledTools[newName] = enabledTools[oldName];
        }
        delete enabledTools[oldName];
        migrated = true;
      }
    }

    // Remove stale keys for removed tools
    const STALE_KEYS = ['getWeather', 'updateDocument'] as const;
    for (const key of STALE_KEYS) {
      if (key in enabledTools) {
        delete enabledTools[key];
        migrated = true;
      }
    }

    // Merge webSearchConfig
    const webSearchConfig: WebSearchProviderConfig = {
      ...defaultWebSearchConfig,
      ...(stored.webSearchConfig ?? {}),
      tavily: {
        ...defaultWebSearchConfig.tavily,
        ...(stored.webSearchConfig?.tavily ?? {}),
      },
      browser: {
        ...defaultWebSearchConfig.browser,
        ...(stored.webSearchConfig?.browser ?? {}),
      },
    };

    // Migrate legacy webSearchApiKey -> webSearchConfig.tavily.apiKey
    const legacyApiKey = raw.webSearchApiKey;
    if (typeof legacyApiKey === 'string' && legacyApiKey.startsWith('tvly-') && !webSearchConfig.tavily.apiKey) {
      webSearchConfig.tavily.apiKey = legacyApiKey;
      webSearchConfig.provider = 'tavily';
      migrated = true;
    }

    // Merge deepResearchConfig
    const deepResearchConfig: DeepResearchConfig = {
      ...defaultDeepResearchConfig,
      ...(stored.deepResearchConfig ?? {}),
    };

    const merged: ToolConfig = {
      enabledTools,
      webSearchConfig,
      deepResearchConfig,
      ...(stored.googleClientId ? { googleClientId: stored.googleClientId } : {}),
    };

    // Persist migration if legacy fields were found
    if (migrated) {
      await rawToolConfigStorage.set(merged);
    }

    return merged;
  },
  set: rawToolConfigStorage.set.bind(rawToolConfigStorage),
  getSnapshot: rawToolConfigStorage.getSnapshot.bind(rawToolConfigStorage),
  subscribe: rawToolConfigStorage.subscribe.bind(rawToolConfigStorage),
};

export type {
  ToolConfig,
  WebSearchProvider,
  BrowserSearchEngine,
  WebSearchProviderConfig,
  DeepResearchConfig,
};
export { toolConfigStorage, defaultWebSearchConfig, defaultDeepResearchConfig };
