import { Dexie } from 'dexie';
import type { EntityTable } from 'dexie';

/** DB-level chat message part (stored as JSON) */
interface DbChatMessagePart {
  type: string;
  [key: string]: unknown;
}

/** DB-level chat message */
interface DbChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  parts: DbChatMessagePart[];
  createdAt: number;
  model?: string;
}

/** DB-level channel metadata */
interface DbChannelMeta {
  channelId: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  senderUsername?: string;
  extra?: Record<string, unknown>;
}

/** DB-level chat */
interface DbChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  compactionCount?: number;
  compactionSummary?: string;
  memoryFlushAt?: number;
  memoryFlushCompactionCount?: number;
  source?: string;
  channelMeta?: DbChannelMeta;
  agentId?: string;
  compactionTokensBefore?: number;
  compactionTokensAfter?: number;
  compactionMethod?: 'summary' | 'sliding-window' | 'adaptive' | 'none';
}

/** DB-level artifact */
interface DbArtifact {
  id: string;
  chatId: string;
  title: string;
  kind: 'text' | 'code' | 'sheet' | 'image';
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** DB-level workspace file */
interface DbWorkspaceFile {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  owner: 'user' | 'agent';
  predefined: boolean;
  createdAt: number;
  updatedAt: number;
  agentId?: string;
}

/** DB-level model config */
interface DbChatModel {
  id: string;
  /** The model identifier sent to the provider (e.g. gpt-4o, claude-sonnet-4-5-20250929) */
  modelId: string;
  name: string;
  provider: string;
  description?: string;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  routingMode?: string;
  api?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Wall-clock timeout in seconds for tool-call execution (default: 300). */
  toolTimeoutSeconds?: number;
  /** Context window size in tokens. Overrides the built-in lookup when set. */
  contextWindow?: number;
  /** Azure OpenAI API version (e.g. '2025-04-01-preview'). Only used with azure provider. */
  azureApiVersion?: string;
  /** Web provider identifier (e.g. 'claude-web'). Only used with web provider. */
  webProviderId?: string;
}

/** DB-level memory chunk for BM25 search */
interface DbMemoryChunk {
  id: string;
  fileId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  fileUpdatedAt: number;
  agentId?: string;
  // ── Embedding support (v12) ──
  contentHash?: string; // SHA-256 of chunk text
  embedding?: number[]; // vector embedding (e.g. 1536 floats)
  embeddingProvider?: string; // e.g. 'openai-compatible'
  embeddingModel?: string; // e.g. 'text-embedding-3-small'
  // ── Transcript indexing (v13) ──
  chatId?: string; // Links transcript chunks to a chat session
}

/** Persistent embedding cache — avoids re-embedding unchanged text */
interface DbEmbeddingCache {
  id: string; // composite key: `${provider}:${model}:${contentHash}`
  provider: string;
  model: string;
  contentHash: string; // SHA-256 of the text that was embedded
  embedding: number[]; // the cached vector
  dims: number; // vector length, for validation
  updatedAt: number; // timestamp, for LRU eviction
}

/** Agent identity (avatar, theme, etc.) */
interface AgentIdentity {
  name?: string;
  emoji?: string;
  theme?: string;
  avatar?: string;
}

/** Agent model configuration with fallback chain */
interface AgentModelConfig {
  primary?: string;
  fallbacks?: string[];
}

/** Definition for an agent-created custom tool */
interface CustomToolDef {
  name: string;
  description: string;
  params: { name: string; type: string; description: string }[];
  path: string;
  /** System prompt hint included when this tool is enabled */
  promptHint?: string;
}

/** Agent configuration */
interface AgentConfig {
  id: string;
  name: string;
  identity: AgentIdentity;
  isDefault: boolean;
  model?: AgentModelConfig;
  toolConfig?: import('./tool-config-storage.js').ToolConfig;
  customTools?: CustomToolDef[];
  compactionConfig?: {
    maxHistoryShare?: number;
    recentTurnsPreserve?: number;
    tokenSafetyMargin?: number;
    toolResultContextShare?: number;
    qualityGuardEnabled?: boolean;
    qualityGuardMaxRetries?: number;
    identifierPolicy?: 'strict' | 'lenient' | 'off';
  };
  createdAt: number;
  updatedAt: number;
}

/** DB-level scheduled task */
interface DbScheduledTask {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  timeoutMs?: number;
  createdAt: number;
  updatedAt: number;
  schedule: { kind: string; [key: string]: unknown };
  payload: { kind: string; [key: string]: unknown };
  state: {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: string;
    lastError?: string;
    lastDurationMs?: number;
  };
}

/** DB-level task run log entry */
interface DbTaskRunLog {
  id: string;
  taskId: string;
  timestamp: number;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  durationMs?: number;
  chatId?: string;
}

const chatDb = new Dexie('chromeclaw') as InstanceType<typeof Dexie> & {
  agents: EntityTable<AgentConfig, 'id'>;
  chats: EntityTable<DbChat, 'id'>;
  messages: EntityTable<DbChatMessage, 'id'>;
  artifacts: EntityTable<DbArtifact, 'id'>;
  workspaceFiles: EntityTable<DbWorkspaceFile, 'id'>;
  memoryChunks: EntityTable<DbMemoryChunk, 'id'>;
  scheduledTasks: EntityTable<DbScheduledTask, 'id'>;
  taskRunLogs: EntityTable<DbTaskRunLog, 'id'>;
  embeddingCache: EntityTable<DbEmbeddingCache, 'id'>;
};

chatDb.version(1).stores({
  chats: 'id, updatedAt',
  messages: 'id, chatId, createdAt',
  artifacts: 'id, chatId',
});

chatDb
  .version(2)
  .stores({
    chats: 'id, updatedAt',
    messages: 'id, chatId, createdAt',
    artifacts: 'id, chatId',
  })
  .upgrade(tx =>
    tx
      .table('chats')
      .toCollection()
      .modify(chat => {
        chat.inputTokens = chat.inputTokens ?? 0;
        chat.outputTokens = chat.outputTokens ?? 0;
        chat.totalTokens = chat.totalTokens ?? 0;
        chat.compactionCount = chat.compactionCount ?? 0;
      }),
  );

chatDb.version(3).stores({
  chats: 'id, updatedAt',
  messages: 'id, chatId, createdAt',
  artifacts: 'id, chatId',
  workspaceFiles: 'id, owner',
});

// v4: (legacy — previously added notes field, now removed)
chatDb.version(4).stores({
  chats: 'id, updatedAt',
  messages: 'id, chatId, createdAt',
  artifacts: 'id, chatId',
  workspaceFiles: 'id, owner',
});

// v5: adds compactionSummary field to chats (no index change needed)
chatDb.version(5).stores({
  chats: 'id, updatedAt',
  messages: 'id, chatId, createdAt',
  artifacts: 'id, chatId',
  workspaceFiles: 'id, owner',
});

// v6: adds memoryFlushAt and memoryFlushCompactionCount fields to chats (no index change needed)
chatDb.version(6).stores({
  chats: 'id, updatedAt',
  messages: 'id, chatId, createdAt',
  artifacts: 'id, chatId',
  workspaceFiles: 'id, owner',
});

// v7: adds memoryChunks table for BM25 memory search
chatDb.version(7).stores({
  chats: 'id, updatedAt',
  messages: 'id, chatId, createdAt',
  artifacts: 'id, chatId',
  workspaceFiles: 'id, owner',
  memoryChunks: 'id, fileId, filePath',
});

// v8: adds source index on chats for channel-sourced conversations
chatDb.version(8).stores({
  chats: 'id, updatedAt, source',
  messages: 'id, chatId, createdAt',
  artifacts: 'id, chatId',
  workspaceFiles: 'id, owner',
  memoryChunks: 'id, fileId, filePath',
});

// v9: adds scheduledTasks and taskRunLogs tables for cron system
chatDb.version(9).stores({
  chats: 'id, updatedAt, source',
  messages: 'id, chatId, createdAt',
  artifacts: 'id, chatId',
  workspaceFiles: 'id, owner',
  memoryChunks: 'id, fileId, filePath',
  scheduledTasks: 'id, enabled',
  taskRunLogs: 'id, taskId, timestamp',
});

// v10: adds agents table and agentId index on chats, workspaceFiles, memoryChunks
chatDb
  .version(10)
  .stores({
    agents: 'id, isDefault',
    chats: 'id, updatedAt, source, agentId',
    messages: 'id, chatId, createdAt',
    artifacts: 'id, chatId',
    workspaceFiles: 'id, owner, agentId',
    memoryChunks: 'id, fileId, filePath, agentId',
    scheduledTasks: 'id, enabled',
    taskRunLogs: 'id, taskId, timestamp',
  })
  .upgrade(async tx => {
    const now = Date.now();
    // Create default 'main' agent
    await tx.table('agents').put({
      id: 'main',
      name: 'Main Agent',
      emoji: '', // v11 migration will convert to identity
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    // Backfill agentId='main' on all existing records
    await tx
      .table('chats')
      .toCollection()
      .modify(chat => {
        if (!chat.agentId) chat.agentId = 'main';
      });
    await tx
      .table('workspaceFiles')
      .toCollection()
      .modify(file => {
        if (!file.agentId) file.agentId = 'main';
      });
    await tx
      .table('memoryChunks')
      .toCollection()
      .modify(chunk => {
        if (!chunk.agentId) chunk.agentId = 'main';
      });
  });

// v11: migrate emoji → identity, selectedModelId → model on agents
chatDb
  .version(11)
  .stores({
    agents: 'id, isDefault',
    chats: 'id, updatedAt, source, agentId',
    messages: 'id, chatId, createdAt',
    artifacts: 'id, chatId',
    workspaceFiles: 'id, owner, agentId',
    memoryChunks: 'id, fileId, filePath, agentId',
    scheduledTasks: 'id, enabled',
    taskRunLogs: 'id, taskId, timestamp',
  })
  .upgrade(async tx => {
    await tx
      .table('agents')
      .toCollection()
      .modify(agent => {
        // Migrate emoji → identity
        agent.identity = { emoji: agent.emoji || '' };
        delete agent.emoji;
        // Migrate selectedModelId → model
        if (agent.selectedModelId) {
          agent.model = { primary: agent.selectedModelId };
        }
        delete agent.selectedModelId;
      });
  });

// v12: adds embeddingCache table and embedding fields on memoryChunks
chatDb.version(12).stores({
  agents: 'id, isDefault',
  chats: 'id, updatedAt, source, agentId',
  messages: 'id, chatId, createdAt',
  artifacts: 'id, chatId',
  workspaceFiles: 'id, owner, agentId',
  memoryChunks: 'id, fileId, filePath, agentId',
  scheduledTasks: 'id, enabled',
  taskRunLogs: 'id, taskId, timestamp',
  embeddingCache: 'id, contentHash, updatedAt',
});
// No upgrade function needed — new fields are optional, new table starts empty

// v13: adds optional chatId field + index on memoryChunks for transcript indexing
chatDb.version(13).stores({
  agents: 'id, isDefault',
  chats: 'id, updatedAt, source, agentId',
  messages: 'id, chatId, createdAt',
  artifacts: 'id, chatId',
  workspaceFiles: 'id, owner, agentId',
  memoryChunks: 'id, fileId, filePath, agentId, chatId',
  scheduledTasks: 'id, enabled',
  taskRunLogs: 'id, taskId, timestamp',
  embeddingCache: 'id, contentHash, updatedAt',
});
// No upgrade function needed — chatId is optional, existing chunks don't have it

// Seed the default 'main' agent on fresh installs.
// The v10 upgrade only runs when migrating from v9; a brand-new DB skips it.
chatDb.on('populate', () => {
  const now = Date.now();
  chatDb.agents.add({
    id: 'main',
    name: 'Main Agent',
    identity: { emoji: '' },
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  });
});

export type {
  DbChatMessagePart,
  DbChatMessage,
  DbChat,
  DbChannelMeta,
  DbArtifact,
  DbChatModel,
  DbWorkspaceFile,
  DbMemoryChunk,
  AgentConfig,
  AgentIdentity,
  AgentModelConfig,
  CustomToolDef,
  DbScheduledTask,
  DbTaskRunLog,
  DbEmbeddingCache,
};
export { chatDb };
