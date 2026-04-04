import { chatDb } from './chat-db.js';
import { isSkillFile, parseSkillFrontmatter, DAILY_JOURNAL_SKILL, SKILL_CREATOR_SKILL, TOOL_CREATOR_SKILL } from '@extension/skills';
import {
  AGENTS_DEFAULT,
  SOUL_DEFAULT,
  USER_DEFAULT,
  IDENTITY_DEFAULT,
  TOOLS_DEFAULT,
} from './workspace-defaults.js';
import { nanoid } from 'nanoid';
import type {
  DbChat,
  DbChatMessage,
  DbArtifact,
  DbWorkspaceFile,
  DbMemoryChunk,
  AgentConfig,
  DbScheduledTask,
  DbTaskRunLog,
} from './chat-db.js';
import type { SkillMetadata } from '@extension/skills';

/** Token usage for a single LLM response (matches SessionUsage from @extension/shared) */
interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ── Agent CRUD ─────────────────────────────────

const createAgent = async (agent: AgentConfig): Promise<void> => {
  await chatDb.agents.put(agent);
};

const getAgent = async (id: string): Promise<AgentConfig | undefined> => chatDb.agents.get(id);

const listAgents = async (): Promise<AgentConfig[]> => chatDb.agents.toArray();

const updateAgent = async (
  id: string,
  updates: Partial<Pick<AgentConfig, 'name' | 'identity' | 'model' | 'toolConfig' | 'customTools' | 'compactionConfig'>>,
): Promise<void> => {
  await chatDb.agents.update(id, { ...updates, updatedAt: Date.now() });
};

const getDefaultAgent = async (): Promise<AgentConfig | undefined> =>
  chatDb.agents.where('isDefault').equals(1).first();

const deleteAgent = async (id: string): Promise<void> => {
  const agent = await chatDb.agents.get(id);
  if (!agent) return;
  if (agent.isDefault) throw new Error('Cannot delete the default agent');

  await chatDb.transaction(
    'rw',
    [
      chatDb.agents,
      chatDb.chats,
      chatDb.messages,
      chatDb.artifacts,
      chatDb.workspaceFiles,
      chatDb.memoryChunks,
    ],
    async () => {
      // Delete all chats and their messages/artifacts
      const chats = await chatDb.chats.where('agentId').equals(id).toArray();
      for (const chat of chats) {
        await chatDb.messages.where('chatId').equals(chat.id).delete();
        await chatDb.artifacts.where('chatId').equals(chat.id).delete();
      }
      await chatDb.chats.where('agentId').equals(id).delete();
      // Delete workspace files and memory chunks
      await chatDb.workspaceFiles.where('agentId').equals(id).delete();
      await chatDb.memoryChunks.where('agentId').equals(id).delete();
      // Delete the agent
      await chatDb.agents.delete(id);
    },
  );
};

// ── Chat CRUD ──────────────────────────────────

const createChat = async (chat: DbChat): Promise<void> => {
  await chatDb.chats.put(chat);
};

const getChat = async (id: string): Promise<DbChat | undefined> => chatDb.chats.get(id);

const listChats = async (limit = 100, offset = 0, agentId?: string): Promise<DbChat[]> => {
  if (agentId) {
    const all = await chatDb.chats.where('agentId').equals(agentId).toArray();
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return all.slice(offset, offset + limit);
  }
  return chatDb.chats.orderBy('updatedAt').reverse().offset(offset).limit(limit).toArray();
};

const updateChatTitle = async (id: string, title: string): Promise<void> => {
  await chatDb.chats.update(id, { title, updatedAt: Date.now() });
};

const deleteChat = async (id: string): Promise<void> => {
  await chatDb.transaction(
    'rw',
    [chatDb.chats, chatDb.messages, chatDb.artifacts, chatDb.memoryChunks],
    async () => {
      await chatDb.chats.delete(id);
      await chatDb.messages.where('chatId').equals(id).delete();
      await chatDb.artifacts.where('chatId').equals(id).delete();
      // Clean up transcript chunks linked to this chat
      await chatDb.memoryChunks.where('chatId').equals(id).delete();
    },
  );
};

// ── Message CRUD ───────────────────────────────

const addMessage = async (message: DbChatMessage): Promise<void> => {
  await chatDb.messages.put(message);
};

const getMessagesByChatId = async (chatId: string): Promise<DbChatMessage[]> =>
  chatDb.messages.where('chatId').equals(chatId).sortBy('createdAt');

const deleteMessagesByChatId = async (chatId: string): Promise<void> => {
  await chatDb.messages.where('chatId').equals(chatId).delete();
};

// ── Artifact CRUD ──────────────────────────────

const saveArtifact = async (artifact: DbArtifact): Promise<void> => {
  await chatDb.artifacts.put(artifact);
};

const getArtifactById = async (id: string): Promise<DbArtifact | undefined> =>
  chatDb.artifacts.get(id);

const getArtifactsByChatId = async (chatId: string): Promise<DbArtifact[]> =>
  chatDb.artifacts.where('chatId').equals(chatId).toArray();

const deleteMessagesAfter = async (chatId: string, messageId: string): Promise<void> => {
  const messages = await chatDb.messages.where('chatId').equals(chatId).sortBy('createdAt');
  const targetIndex = messages.findIndex(m => m.id === messageId);
  if (targetIndex < 0) return;
  const idsToDelete = messages.slice(targetIndex + 1).map(m => m.id);
  if (idsToDelete.length > 0) {
    await chatDb.messages.bulkDelete(idsToDelete);
  }
};

// ── Clear All ─────────────────────────────────

const clearAllChatHistory = async (): Promise<void> => {
  await chatDb.transaction('rw', [chatDb.chats, chatDb.messages, chatDb.artifacts], async () => {
    await chatDb.chats.clear();
    await chatDb.messages.clear();
    await chatDb.artifacts.clear();
  });
};

// ── Search ─────────────────────────────────────

const searchChats = async (query: string, agentId?: string): Promise<DbChat[]> => {
  const lowerQuery = query.toLowerCase();
  const collection = agentId
    ? chatDb.chats.where('agentId').equals(agentId)
    : chatDb.chats.toCollection();
  const filtered = await collection
    .filter(chat => chat.title.toLowerCase().includes(lowerQuery))
    .toArray();
  filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  return filtered;
};

// ── Session Management ────────────────────────

const updateSessionTokens = async (chatId: string, usage: TokenUsage): Promise<void> => {
  const chat = await chatDb.chats.get(chatId);
  if (!chat) return;
  await chatDb.chats.update(chatId, {
    inputTokens: (chat.inputTokens ?? 0) + usage.promptTokens,
    outputTokens: (chat.outputTokens ?? 0) + usage.completionTokens,
    totalTokens: (chat.totalTokens ?? 0) + usage.totalTokens,
  });
};

const incrementCompactionCount = async (chatId: string): Promise<void> => {
  const chat = await chatDb.chats.get(chatId);
  if (!chat) return;
  await chatDb.chats.update(chatId, {
    compactionCount: (chat.compactionCount ?? 0) + 1,
  });
};

const updateCompactionSummary = async (chatId: string, summary: string): Promise<void> => {
  await chatDb.chats.update(chatId, { compactionSummary: summary });
};

const updateCompactionMetadata = async (
  chatId: string,
  metadata: {
    compactionTokensBefore?: number;
    compactionTokensAfter?: number;
    compactionMethod?: 'summary' | 'sliding-window' | 'adaptive' | 'none';
  },
): Promise<void> => {
  await chatDb.chats.update(chatId, metadata);
};

const getMostRecentChat = async (agentId?: string): Promise<DbChat | undefined> => {
  if (agentId) {
    const all = await chatDb.chats.where('agentId').equals(agentId).toArray();
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return all[0];
  }
  return chatDb.chats.orderBy('updatedAt').reverse().first();
};

const touchChat = async (chatId: string): Promise<void> => {
  await chatDb.chats.update(chatId, { updatedAt: Date.now() });
};

const updateMemoryFlush = async (chatId: string, compactionCount: number): Promise<void> => {
  await chatDb.chats.update(chatId, {
    memoryFlushAt: Date.now(),
    memoryFlushCompactionCount: compactionCount,
  });
};

const PRUNE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const PRUNE_MAX_SESSIONS = 500;

const pruneOldSessions = async (): Promise<number> => {
  const cutoff = Date.now() - PRUNE_MAX_AGE_MS;
  let pruned = 0;

  // Delete sessions older than 90 days
  const oldChats = await chatDb.chats.filter(c => c.updatedAt < cutoff).toArray();
  for (const chat of oldChats) {
    await deleteChat(chat.id);
    pruned++;
  }

  // Cap at 500 total — delete oldest excess
  const totalCount = await chatDb.chats.count();
  if (totalCount > PRUNE_MAX_SESSIONS) {
    const excess = totalCount - PRUNE_MAX_SESSIONS;
    const oldestChats = await chatDb.chats.orderBy('updatedAt').limit(excess).toArray();
    for (const chat of oldestChats) {
      await deleteChat(chat.id);
      pruned++;
    }
  }

  return pruned;
};

// ── Cron Session Reaper ─────────────────────

const CRON_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REAP_THROTTLE_MS = 5 * 60 * 1000;
let lastReapAtMs = 0;

const reapCronSessions = async (retentionMs?: number): Promise<number> => {
  const now = Date.now();
  if (now - lastReapAtMs < REAP_THROTTLE_MS) return -1;
  lastReapAtMs = now;
  const cutoff = now - (retentionMs ?? CRON_RETENTION_MS);
  const expired = await chatDb.chats
    .where('source')
    .equals('cron')
    .filter(c => c.updatedAt < cutoff)
    .toArray();
  for (const chat of expired) await deleteChat(chat.id);
  return expired.length;
};

/** Reset throttle state — for testing only. */
const _resetReaperThrottle = (): void => {
  lastReapAtMs = 0;
};

// ── Workspace File CRUD ──────────────────────

const createWorkspaceFile = async (file: DbWorkspaceFile): Promise<void> => {
  await chatDb.workspaceFiles.put(file);
};

const getWorkspaceFile = async (id: string): Promise<DbWorkspaceFile | undefined> =>
  chatDb.workspaceFiles.get(id);

const listWorkspaceFiles = async (agentId?: string): Promise<DbWorkspaceFile[]> => {
  if (agentId) {
    return chatDb.workspaceFiles.where('agentId').equals(agentId).toArray();
  }
  return chatDb.workspaceFiles.toArray();
};

const listUserWorkspaceFiles = async (agentId?: string): Promise<DbWorkspaceFile[]> => {
  if (agentId) {
    const all = await chatDb.workspaceFiles.where('agentId').equals(agentId).toArray();
    return all.filter(f => f.owner === 'user');
  }
  return chatDb.workspaceFiles.where('owner').equals('user').toArray();
};

const listAgentMemoryFiles = async (agentId?: string): Promise<DbWorkspaceFile[]> => {
  if (agentId) {
    const all = await chatDb.workspaceFiles.where('agentId').equals(agentId).toArray();
    return all.filter(f => f.owner === 'agent');
  }
  return chatDb.workspaceFiles.where('owner').equals('agent').toArray();
};

const updateWorkspaceFile = async (
  id: string,
  updates: Partial<Pick<DbWorkspaceFile, 'content' | 'enabled' | 'name'>>,
): Promise<void> => {
  await chatDb.workspaceFiles.update(id, { ...updates, updatedAt: Date.now() });
};

const deleteWorkspaceFile = async (id: string): Promise<void> => {
  const file = await chatDb.workspaceFiles.get(id);
  if (file?.predefined) {
    throw new Error('Cannot delete predefined workspace files');
  }
  await chatDb.workspaceFiles.delete(id);
};

const deleteWorkspaceFilesByPrefix = async (
  namePrefix: string,
  agentId?: string,
): Promise<number> => {
  const all = agentId
    ? await chatDb.workspaceFiles.where('agentId').equals(agentId).toArray()
    : await chatDb.workspaceFiles.toArray();
  const toDelete = all.filter(f => f.name.startsWith(namePrefix) && !f.predefined);
  if (toDelete.length > 0) {
    await chatDb.workspaceFiles.bulkDelete(toDelete.map(f => f.id));
  }
  return toDelete.length;
};

const getEnabledWorkspaceFiles = async (agentId?: string): Promise<DbWorkspaceFile[]> => {
  const all = agentId
    ? await chatDb.workspaceFiles.where('agentId').equals(agentId).toArray()
    : await chatDb.workspaceFiles.toArray();
  return all.filter(f => f.enabled);
};

const PREDEFINED_FILES = [
  { name: 'AGENTS.md', content: AGENTS_DEFAULT },
  { name: 'SOUL.md', content: SOUL_DEFAULT },
  { name: 'USER.md', content: USER_DEFAULT },
  { name: 'IDENTITY.md', content: IDENTITY_DEFAULT },
  { name: 'TOOLS.md', content: TOOLS_DEFAULT },
  { name: 'MEMORY.md', content: '' },
  { name: 'skills/daily-journal/SKILL.md', content: DAILY_JOURNAL_SKILL, enabled: false },
  { name: 'skills/skill-creator/SKILL.md', content: SKILL_CREATOR_SKILL, enabled: false },
  { name: 'skills/tool-creator/SKILL.md', content: TOOL_CREATOR_SKILL, enabled: false },
] as const;

const seedPredefinedWorkspaceFiles = async (agentId = 'main'): Promise<void> => {
  const now = Date.now();

  // Migrate existing global skill files to agent-scoped
  const allFiles = await chatDb.workspaceFiles.toArray();
  const globalSkills = allFiles.filter(f => f.predefined && isSkillFile(f.name) && (!f.agentId || f.agentId === ''));
  const agentExistingNames = new Set(
    allFiles.filter(f => f.agentId === agentId).map(f => f.name),
  );
  const migratedSkills = globalSkills
    .filter(f => !agentExistingNames.has(f.name))
    .map(f => ({
      id: nanoid(),
      name: f.name,
      content: f.content,
      enabled: f.enabled,
      owner: f.owner,
      predefined: true,
      createdAt: now,
      updatedAt: now,
      agentId,
    }));

  // Seed agent-scoped predefined workspace files (including skills)
  const agentExisting = allFiles.filter(f => f.agentId === agentId);
  const agentExistingPredefinedNames = new Set(agentExisting.filter(f => f.predefined).map(f => f.name));
  // Also exclude names we're about to migrate
  const migratedNames = new Set(migratedSkills.map(f => f.name));
  const agentFiles = PREDEFINED_FILES
    .filter(f => !agentExistingPredefinedNames.has(f.name) && !migratedNames.has(f.name))
    .map(f => ({
      id: nanoid(),
      name: f.name,
      content: f.content,
      enabled: 'enabled' in f ? f.enabled : true,
      owner: 'user' as const,
      predefined: true,
      createdAt: now,
      updatedAt: now,
      agentId,
    }));

  const toCreate = [...migratedSkills, ...agentFiles];
  if (toCreate.length > 0) {
    await chatDb.workspaceFiles.bulkPut(toCreate);
  }
};

const copyGlobalSkillsToAgent = async (agentId: string): Promise<void> => {
  const allFiles = await chatDb.workspaceFiles.toArray();
  // Global skill-related files: no agentId, under skills/ directory, non-predefined
  const globalSkillFiles = allFiles.filter(
    f => (!f.agentId || f.agentId === '') && f.name.startsWith('skills/') && !f.predefined,
  );
  if (globalSkillFiles.length === 0) return;

  // Check what the agent already has to avoid duplicates
  const agentFiles = await chatDb.workspaceFiles.where('agentId').equals(agentId).toArray();
  const agentNames = new Set(agentFiles.map(f => f.name));

  const now = Date.now();
  const toCopy = globalSkillFiles
    .filter(f => !agentNames.has(f.name))
    .map(f => ({
      id: nanoid(),
      name: f.name,
      content: f.content,
      enabled: f.enabled,
      owner: f.owner,
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId,
    }));

  if (toCopy.length > 0) {
    await chatDb.workspaceFiles.bulkPut(toCopy);
  }
};

const copyGlobalSkillsToAllAgents = async (): Promise<void> => {
  const [agents, allFiles] = await Promise.all([
    chatDb.agents.toArray(),
    chatDb.workspaceFiles.toArray(),
  ]);
  const globalSkillFiles = allFiles.filter(
    f => (!f.agentId || f.agentId === '') && f.name.startsWith('skills/') && !f.predefined,
  );
  if (globalSkillFiles.length === 0) return;

  const now = Date.now();
  for (const agent of agents) {
    const agentFiles = allFiles.filter(f => f.agentId === agent.id);
    const agentNames = new Set(agentFiles.map(f => f.name));
    const toCopy = globalSkillFiles
      .filter(f => !agentNames.has(f.name))
      .map(f => ({
        id: nanoid(),
        name: f.name,
        content: f.content,
        enabled: f.enabled,
        owner: f.owner,
        predefined: false,
        createdAt: now,
        updatedAt: now,
        agentId: agent.id,
      }));
    if (toCopy.length > 0) {
      await chatDb.workspaceFiles.bulkPut(toCopy);
    }
  }
};

// ── Memory Chunk CRUD ────────────────────────

const bulkPutMemoryChunks = async (chunks: DbMemoryChunk[]): Promise<void> => {
  await chatDb.memoryChunks.bulkPut(chunks);
};

const deleteMemoryChunksByFileId = async (fileId: string): Promise<void> => {
  await chatDb.memoryChunks.where('fileId').equals(fileId).delete();
};

const getAllMemoryChunks = async (agentId?: string): Promise<DbMemoryChunk[]> => {
  if (agentId) {
    return chatDb.memoryChunks.where('agentId').equals(agentId).toArray();
  }
  return chatDb.memoryChunks.toArray();
};

const deleteMemoryChunksByChatId = async (chatId: string): Promise<void> => {
  await chatDb.memoryChunks.where('chatId').equals(chatId).delete();
};

const clearAllMemoryChunks = async (): Promise<void> => {
  await chatDb.memoryChunks.clear();
};

// ── Skill File Helpers ────────────────────────

/** Returns all skill files (both enabled and disabled), optionally scoped to an agent.
 *  When agentId is provided, includes both agent-scoped AND global (no agentId) skills.
 *  Deduplicates by file name so agent-scoped overrides shadow their global counterparts.
 *  When no agentId is provided, returns only global (unscoped) skill files. */
const listSkillFiles = async (agentId?: string): Promise<DbWorkspaceFile[]> => {
  if (agentId) {
    const [agentFiles, allFiles] = await Promise.all([
      chatDb.workspaceFiles.where('agentId').equals(agentId).toArray(),
      chatDb.workspaceFiles.toArray(),
    ]);
    const globalFiles = allFiles.filter(f => f.agentId === undefined || f.agentId === '');
    const agentSkills = agentFiles.filter(f => isSkillFile(f.name));
    const globalSkills = globalFiles.filter(f => isSkillFile(f.name));
    // Deduplicate by name: agent-scoped files take precedence over global
    const seenNames = new Set(agentSkills.map(f => f.name));
    return [...agentSkills, ...globalSkills.filter(f => !seenNames.has(f.name))];
  }
  const all = await chatDb.workspaceFiles.toArray();
  return all.filter(f => isSkillFile(f.name) && (!f.agentId || f.agentId === ''));
};

/** Returns workspace files for a given agent whose `name` field exactly matches
 *  one of the provided `toolPaths`. Only searches agent-scoped files (no global fallback)
 *  because tool scripts are always tied to a specific agent's custom tool config. */
const listToolScriptFiles = async (
  agentId: string,
  toolPaths: string[],
): Promise<DbWorkspaceFile[]> => {
  if (toolPaths.length === 0) return [];
  const pathSet = new Set(toolPaths);
  const all = await chatDb.workspaceFiles.where('agentId').equals(agentId).toArray();
  return all.filter(f => pathSet.has(f.name));
};

const getEnabledSkills = async (
  agentId?: string,
): Promise<Array<{ file: DbWorkspaceFile; metadata: SkillMetadata }>> => {
  let all: DbWorkspaceFile[];
  if (agentId) {
    const [agentFiles, everyFile] = await Promise.all([
      chatDb.workspaceFiles.where('agentId').equals(agentId).toArray(),
      chatDb.workspaceFiles.toArray(),
    ]);
    const globalFiles = everyFile.filter(f => !f.agentId || f.agentId === '');
    // Deduplicate by name: agent-scoped overrides shadow global defaults
    const seenNames = new Set(agentFiles.map(f => f.name));
    all = [...agentFiles, ...globalFiles.filter(f => !seenNames.has(f.name))];
  } else {
    all = await chatDb.workspaceFiles.toArray();
  }
  const results: Array<{ file: DbWorkspaceFile; metadata: SkillMetadata }> = [];
  for (const file of all) {
    if (!file.enabled || !isSkillFile(file.name)) continue;
    const metadata = parseSkillFrontmatter(file.content);
    if (metadata && !metadata.disableModelInvocation) {
      results.push({ file, metadata });
    }
  }
  return results;
};

// ── Channel Chat Helpers ─────────────────────

/** Find a chat record by channel ID and channel-specific chat ID */
const findChatByChannelChatId = async (
  channelId: string,
  chatId: string,
): Promise<DbChat | undefined> => {
  const chats = await chatDb.chats.where('source').equals(channelId).toArray();
  return chats.find(c => c.channelMeta?.chatId === chatId);
};

// ── Scheduled Task CRUD ──────────────────────

const MAX_RUN_LOGS_PER_TASK = 200;

const listScheduledTasks = async (): Promise<DbScheduledTask[]> => chatDb.scheduledTasks.toArray();

const getScheduledTask = async (id: string): Promise<DbScheduledTask | undefined> =>
  chatDb.scheduledTasks.get(id);

const bulkPutScheduledTasks = async (tasks: DbScheduledTask[]): Promise<void> => {
  await chatDb.scheduledTasks.bulkPut(tasks);
};

const deleteScheduledTask = async (id: string): Promise<void> => {
  await chatDb.transaction('rw', [chatDb.scheduledTasks, chatDb.taskRunLogs], async () => {
    await chatDb.scheduledTasks.delete(id);
    await chatDb.taskRunLogs.where('taskId').equals(id).delete();
  });
};

// ── Task Run Log CRUD ────────────────────────

const appendTaskRunLog = async (entry: DbTaskRunLog): Promise<void> => {
  await chatDb.taskRunLogs.put(entry);
  // Prune old entries for this task
  const all = await chatDb.taskRunLogs.where('taskId').equals(entry.taskId).sortBy('timestamp');
  if (all.length > MAX_RUN_LOGS_PER_TASK) {
    const toDelete = all.slice(0, all.length - MAX_RUN_LOGS_PER_TASK).map(e => e.id);
    await chatDb.taskRunLogs.bulkDelete(toDelete);
  }
};

const getTaskRunLogs = async (taskId: string, limit = 50): Promise<DbTaskRunLog[]> => {
  const all = await chatDb.taskRunLogs.where('taskId').equals(taskId).sortBy('timestamp');
  return all.slice(-Math.min(limit, MAX_RUN_LOGS_PER_TASK));
};

export {
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  deleteAgent,
  getDefaultAgent,
  createChat,
  getChat,
  listChats,
  updateChatTitle,
  deleteChat,
  clearAllChatHistory,
  addMessage,
  getMessagesByChatId,
  deleteMessagesByChatId,
  deleteMessagesAfter,
  saveArtifact,
  getArtifactById,
  getArtifactsByChatId,
  searchChats,
  updateSessionTokens,
  incrementCompactionCount,
  updateCompactionSummary,
  updateCompactionMetadata,
  getMostRecentChat,
  touchChat,
  updateMemoryFlush,
  pruneOldSessions,
  createWorkspaceFile,
  getWorkspaceFile,
  listWorkspaceFiles,
  listUserWorkspaceFiles,
  listAgentMemoryFiles,
  updateWorkspaceFile,
  deleteWorkspaceFile,
  deleteWorkspaceFilesByPrefix,
  getEnabledWorkspaceFiles,
  seedPredefinedWorkspaceFiles,
  copyGlobalSkillsToAgent,
  copyGlobalSkillsToAllAgents,
  bulkPutMemoryChunks,
  deleteMemoryChunksByFileId,
  deleteMemoryChunksByChatId,
  getAllMemoryChunks,
  clearAllMemoryChunks,
  listSkillFiles,
  listToolScriptFiles,
  getEnabledSkills,
  findChatByChannelChatId,
  listScheduledTasks,
  getScheduledTask,
  bulkPutScheduledTasks,
  deleteScheduledTask,
  appendTaskRunLog,
  getTaskRunLogs,
  reapCronSessions,
  _resetReaperThrottle,
};
