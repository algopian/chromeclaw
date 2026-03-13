import { chatDb } from './chat-db';
import {
  createChat,
  getChat,
  listChats,
  updateChatTitle,
  deleteChat,
  addMessage,
  getMessagesByChatId,
  deleteMessagesByChatId,
  deleteMessagesAfter,
  saveArtifact,
  getArtifactById,
  getArtifactsByChatId,
  searchChats,
  clearAllChatHistory,
  findChatByChannelChatId,
  updateSessionTokens,
  touchChat,
  getMostRecentChat,
  incrementCompactionCount,
  updateCompactionSummary,
  updateMemoryFlush,
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  deleteAgent,
  getDefaultAgent,
  createWorkspaceFile,
  getWorkspaceFile,
  listWorkspaceFiles,
  listUserWorkspaceFiles,
  listAgentMemoryFiles,
  updateWorkspaceFile,
  deleteWorkspaceFile,
  getEnabledWorkspaceFiles,
  seedPredefinedWorkspaceFiles,
  bulkPutMemoryChunks,
  deleteMemoryChunksByFileId,
  getAllMemoryChunks,
  clearAllMemoryChunks,
  listSkillFiles,
  getEnabledSkills,
  listScheduledTasks,
  getScheduledTask,
  bulkPutScheduledTasks,
  deleteScheduledTask,
  appendTaskRunLog,
  getTaskRunLogs,
  pruneOldSessions,
  reapCronSessions,
  _resetReaperThrottle,
  copyGlobalSkillsToAgent,
  copyGlobalSkillsToAllAgents,
} from './chat-storage';
import { describe, it, expect, beforeEach } from 'vitest';
import type {
  DbArtifact,
  DbChat,
  DbChatMessage,
  AgentConfig,
  DbWorkspaceFile,
  DbMemoryChunk,
  DbScheduledTask,
  DbTaskRunLog,
} from './chat-db';

beforeEach(async () => {
  // Clear all tables before each test
  await chatDb.chats.clear();
  await chatDb.messages.clear();
  await chatDb.artifacts.clear();
  await chatDb.agents.clear();
  await chatDb.workspaceFiles.clear();
  await chatDb.memoryChunks.clear();
  await chatDb.scheduledTasks.clear();
  await chatDb.taskRunLogs.clear();
});

describe('Chat CRUD', () => {
  const testChat: DbChat = {
    id: 'chat-1',
    title: 'Test Chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: 'gpt-4o',
  };

  it('creates and retrieves a chat', async () => {
    await createChat(testChat);
    const result = await getChat('chat-1');
    expect(result).toEqual(testChat);
  });

  it('returns undefined for non-existent chat', async () => {
    const result = await getChat('nonexistent');
    expect(result).toBeUndefined();
  });

  it('lists chats ordered by updatedAt descending', async () => {
    const chat1: DbChat = { ...testChat, id: 'c1', updatedAt: 1000 };
    const chat2: DbChat = { ...testChat, id: 'c2', updatedAt: 3000 };
    const chat3: DbChat = { ...testChat, id: 'c3', updatedAt: 2000 };
    await createChat(chat1);
    await createChat(chat2);
    await createChat(chat3);

    const chats = await listChats();
    expect(chats.map(c => c.id)).toEqual(['c2', 'c3', 'c1']);
  });

  it('lists chats with limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await createChat({ ...testChat, id: `c${i}`, updatedAt: i * 1000 });
    }
    const chats = await listChats(2, 1);
    expect(chats).toHaveLength(2);
  });

  it('updates chat title', async () => {
    await createChat(testChat);
    await updateChatTitle('chat-1', 'Updated Title');
    const result = await getChat('chat-1');
    expect(result?.title).toBe('Updated Title');
    expect(result!.updatedAt).toBeGreaterThan(testChat.updatedAt);
  });

  it('deletes chat and associated messages and artifacts', async () => {
    await createChat(testChat);
    await addMessage({
      id: 'msg-1',
      chatId: 'chat-1',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
      createdAt: Date.now(),
    });
    await saveArtifact({
      id: 'art-1',
      chatId: 'chat-1',
      title: 'Test',
      kind: 'text',
      content: 'content',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await deleteChat('chat-1');

    expect(await getChat('chat-1')).toBeUndefined();
    expect(await getMessagesByChatId('chat-1')).toEqual([]);
    expect(await getArtifactsByChatId('chat-1')).toEqual([]);
  });
});

describe('Message CRUD', () => {
  it('adds and retrieves messages by chat ID', async () => {
    const msg1: DbChatMessage = {
      id: 'msg-1',
      chatId: 'chat-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
      createdAt: 1000,
    };
    const msg2: DbChatMessage = {
      id: 'msg-2',
      chatId: 'chat-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Hi there!' }],
      createdAt: 2000,
      model: 'gpt-4o',
    };
    const msg3: DbChatMessage = {
      id: 'msg-3',
      chatId: 'other-chat',
      role: 'user',
      parts: [{ type: 'text', text: 'Other chat' }],
      createdAt: 3000,
    };

    await addMessage(msg1);
    await addMessage(msg2);
    await addMessage(msg3);

    const messages = await getMessagesByChatId('chat-1');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.id).toBe('msg-1');
    expect(messages[1]!.id).toBe('msg-2');
  });

  it('deletes messages by chat ID', async () => {
    await addMessage({
      id: 'msg-1',
      chatId: 'chat-1',
      role: 'user',
      parts: [{ type: 'text' }],
      createdAt: Date.now(),
    });
    await addMessage({
      id: 'msg-2',
      chatId: 'chat-2',
      role: 'user',
      parts: [{ type: 'text' }],
      createdAt: Date.now(),
    });

    await deleteMessagesByChatId('chat-1');

    expect(await getMessagesByChatId('chat-1')).toEqual([]);
    expect(await getMessagesByChatId('chat-2')).toHaveLength(1);
  });
});

describe('Artifact CRUD', () => {
  const testArtifact: DbArtifact = {
    id: 'art-1',
    chatId: 'chat-1',
    title: 'Document',
    kind: 'text',
    content: 'Hello world',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  it('saves and retrieves an artifact by ID', async () => {
    await saveArtifact(testArtifact);
    const result = await getArtifactById('art-1');
    expect(result).toEqual(testArtifact);
  });

  it('returns undefined for non-existent artifact', async () => {
    const result = await getArtifactById('nonexistent');
    expect(result).toBeUndefined();
  });

  it('retrieves artifacts by chat ID', async () => {
    await saveArtifact(testArtifact);
    await saveArtifact({ ...testArtifact, id: 'art-2', kind: 'code', content: 'fn()' });
    await saveArtifact({
      ...testArtifact,
      id: 'art-3',
      chatId: 'other-chat',
    });

    const artifacts = await getArtifactsByChatId('chat-1');
    expect(artifacts).toHaveLength(2);
  });
});

describe('Search', () => {
  it('finds chats by title substring (case-insensitive)', async () => {
    await createChat({
      id: 'c1',
      title: 'React Tutorial',
      createdAt: Date.now(),
      updatedAt: 3000,
    });
    await createChat({
      id: 'c2',
      title: 'Python Guide',
      createdAt: Date.now(),
      updatedAt: 2000,
    });
    await createChat({
      id: 'c3',
      title: 'react hooks',
      createdAt: Date.now(),
      updatedAt: 1000,
    });

    const results = await searchChats('react');
    expect(results).toHaveLength(2);
    // Should be ordered by updatedAt descending
    expect(results[0]!.id).toBe('c1');
    expect(results[1]!.id).toBe('c3');
  });

  it('returns empty array when no matches', async () => {
    await createChat({
      id: 'c1',
      title: 'Hello',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const results = await searchChats('xyz');
    expect(results).toEqual([]);
  });

  it('filters by agentId when provided', async () => {
    await createChat({
      id: 'c1',
      title: 'React Tutorial',
      createdAt: Date.now(),
      updatedAt: 3000,
      agentId: 'agent-a',
    });
    await createChat({
      id: 'c2',
      title: 'React Guide',
      createdAt: Date.now(),
      updatedAt: 2000,
      agentId: 'agent-b',
    });
    await createChat({
      id: 'c3',
      title: 'React Hooks',
      createdAt: Date.now(),
      updatedAt: 1000,
      agentId: 'agent-a',
    });

    const results = await searchChats('react', 'agent-a');
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe('c1');
    expect(results[1]!.id).toBe('c3');
  });
});

describe('clearAllChatHistory', () => {
  it('clears all chats, messages, and artifacts', async () => {
    await createChat({
      id: 'chat-1',
      title: 'Chat 1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await createChat({
      id: 'chat-2',
      title: 'Chat 2',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await addMessage({
      id: 'msg-1',
      chatId: 'chat-1',
      role: 'user',
      parts: [{ type: 'text', text: 'hello' }],
      createdAt: Date.now(),
    });
    await addMessage({
      id: 'msg-2',
      chatId: 'chat-2',
      role: 'user',
      parts: [{ type: 'text', text: 'world' }],
      createdAt: Date.now(),
    });
    await saveArtifact({
      id: 'art-1',
      chatId: 'chat-1',
      title: 'Artifact',
      kind: 'text',
      content: 'content',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await clearAllChatHistory();

    expect(await listChats()).toEqual([]);
    expect(await getMessagesByChatId('chat-1')).toEqual([]);
    expect(await getMessagesByChatId('chat-2')).toEqual([]);
    expect(await getArtifactsByChatId('chat-1')).toEqual([]);
  });

  it('works when tables are already empty', async () => {
    await clearAllChatHistory();
    expect(await listChats()).toEqual([]);
  });
});

describe('deleteMessagesAfter', () => {
  beforeEach(async () => {
    await addMessage({
      id: 'msg-1',
      chatId: 'chat-1',
      role: 'user',
      parts: [{ type: 'text', text: 'First' }],
      createdAt: 1000,
    });
    await addMessage({
      id: 'msg-2',
      chatId: 'chat-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Second' }],
      createdAt: 2000,
    });
    await addMessage({
      id: 'msg-3',
      chatId: 'chat-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Third' }],
      createdAt: 3000,
    });
    await addMessage({
      id: 'msg-4',
      chatId: 'chat-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Fourth' }],
      createdAt: 4000,
    });
  });

  it('deletes all messages after the specified message', async () => {
    await deleteMessagesAfter('chat-1', 'msg-2');
    const messages = await getMessagesByChatId('chat-1');
    expect(messages).toHaveLength(2);
    expect(messages.map(m => m.id)).toEqual(['msg-1', 'msg-2']);
  });

  it('does nothing when messageId is the last message', async () => {
    await deleteMessagesAfter('chat-1', 'msg-4');
    const messages = await getMessagesByChatId('chat-1');
    expect(messages).toHaveLength(4);
  });

  it('does nothing when messageId is not found', async () => {
    await deleteMessagesAfter('chat-1', 'nonexistent');
    const messages = await getMessagesByChatId('chat-1');
    expect(messages).toHaveLength(4);
  });

  it('deletes all messages after the first message', async () => {
    await deleteMessagesAfter('chat-1', 'msg-1');
    const messages = await getMessagesByChatId('chat-1');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe('msg-1');
  });

  it('does not affect messages in other chats', async () => {
    await addMessage({
      id: 'other-msg',
      chatId: 'chat-2',
      role: 'user',
      parts: [{ type: 'text', text: 'Other' }],
      createdAt: 5000,
    });

    await deleteMessagesAfter('chat-1', 'msg-2');

    const otherMessages = await getMessagesByChatId('chat-2');
    expect(otherMessages).toHaveLength(1);
  });
});

describe('findChatByChannelChatId', () => {
  it('finds a chat by channelId and channelMeta.chatId', async () => {
    await createChat({
      id: 'chat-1',
      title: 'Telegram Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: 'telegram',
      channelMeta: {
        channelId: 'telegram',
        chatId: 'tg-123',
        senderId: 'user-1',
      },
    });
    await createChat({
      id: 'chat-2',
      title: 'Another Telegram Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: 'telegram',
      channelMeta: {
        channelId: 'telegram',
        chatId: 'tg-456',
        senderId: 'user-2',
      },
    });

    const result = await findChatByChannelChatId('telegram', 'tg-123');
    expect(result).toBeDefined();
    expect(result!.id).toBe('chat-1');
  });

  it('returns undefined when no matching channelMeta.chatId', async () => {
    await createChat({
      id: 'chat-1',
      title: 'Telegram Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: 'telegram',
      channelMeta: {
        channelId: 'telegram',
        chatId: 'tg-123',
        senderId: 'user-1',
      },
    });

    const result = await findChatByChannelChatId('telegram', 'tg-999');
    expect(result).toBeUndefined();
  });

  it('returns undefined when no chats match the source/channelId', async () => {
    await createChat({
      id: 'chat-1',
      title: 'Regular Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const result = await findChatByChannelChatId('telegram', 'tg-123');
    expect(result).toBeUndefined();
  });
});

describe('updateSessionTokens', () => {
  it('increments token counts on a chat', async () => {
    await createChat({
      id: 'chat-1',
      title: 'Token Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });

    await updateSessionTokens('chat-1', {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });

    const chat = await getChat('chat-1');
    expect(chat!.inputTokens).toBe(100);
    expect(chat!.outputTokens).toBe(50);
    expect(chat!.totalTokens).toBe(150);
  });

  it('accumulates tokens across multiple updates', async () => {
    await createChat({
      id: 'chat-1',
      title: 'Token Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });

    await updateSessionTokens('chat-1', {
      promptTokens: 200,
      completionTokens: 100,
      totalTokens: 300,
    });

    const chat = await getChat('chat-1');
    expect(chat!.inputTokens).toBe(300);
    expect(chat!.outputTokens).toBe(150);
    expect(chat!.totalTokens).toBe(450);
  });

  it('handles undefined initial token values (treats as 0)', async () => {
    await createChat({
      id: 'chat-1',
      title: 'No Tokens',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await updateSessionTokens('chat-1', {
      promptTokens: 50,
      completionTokens: 25,
      totalTokens: 75,
    });

    const chat = await getChat('chat-1');
    expect(chat!.inputTokens).toBe(50);
    expect(chat!.outputTokens).toBe(25);
    expect(chat!.totalTokens).toBe(75);
  });

  it('does nothing when chat does not exist', async () => {
    // Should not throw
    await updateSessionTokens('nonexistent', {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });
});

describe('touchChat', () => {
  it('updates the updatedAt timestamp', async () => {
    const originalTime = 1000;
    await createChat({
      id: 'chat-1',
      title: 'Touch Test',
      createdAt: originalTime,
      updatedAt: originalTime,
    });

    await touchChat('chat-1');

    const chat = await getChat('chat-1');
    expect(chat!.updatedAt).toBeGreaterThan(originalTime);
  });

  it('does not modify other fields', async () => {
    await createChat({
      id: 'chat-1',
      title: 'Touch Test',
      createdAt: 1000,
      updatedAt: 1000,
      model: 'gpt-4o',
      inputTokens: 100,
    });

    await touchChat('chat-1');

    const chat = await getChat('chat-1');
    expect(chat!.title).toBe('Touch Test');
    expect(chat!.model).toBe('gpt-4o');
    expect(chat!.inputTokens).toBe(100);
    expect(chat!.createdAt).toBe(1000);
  });
});

describe('getMostRecentChat', () => {
  it('returns the chat with the highest updatedAt', async () => {
    await createChat({ id: 'c1', title: 'Old', createdAt: 1000, updatedAt: 1000 });
    await createChat({ id: 'c2', title: 'Newest', createdAt: 2000, updatedAt: 3000 });
    await createChat({ id: 'c3', title: 'Middle', createdAt: 3000, updatedAt: 2000 });

    const result = await getMostRecentChat();
    expect(result).toBeDefined();
    expect(result!.id).toBe('c2');
  });

  it('returns undefined when no chats exist', async () => {
    const result = await getMostRecentChat();
    expect(result).toBeUndefined();
  });

  it('filters by agentId when provided', async () => {
    await createChat({ id: 'c1', title: 'Agent A', createdAt: 1000, updatedAt: 3000, agentId: 'agent-a' });
    await createChat({ id: 'c2', title: 'Agent B', createdAt: 2000, updatedAt: 4000, agentId: 'agent-b' });
    await createChat({ id: 'c3', title: 'Agent A old', createdAt: 3000, updatedAt: 2000, agentId: 'agent-a' });

    const result = await getMostRecentChat('agent-a');
    expect(result).toBeDefined();
    expect(result!.id).toBe('c1');
  });

  it('returns undefined when no chats match the agentId', async () => {
    await createChat({ id: 'c1', title: 'Chat', createdAt: 1000, updatedAt: 1000, agentId: 'agent-a' });

    const result = await getMostRecentChat('agent-b');
    expect(result).toBeUndefined();
  });
});

describe('incrementCompactionCount', () => {
  it('increments the compaction count from 0', async () => {
    await createChat({
      id: 'chat-1',
      title: 'Compaction Test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      compactionCount: 0,
    });

    await incrementCompactionCount('chat-1');

    const chat = await getChat('chat-1');
    expect(chat!.compactionCount).toBe(1);
  });

  it('increments the compaction count from an existing value', async () => {
    await createChat({
      id: 'chat-1',
      title: 'Compaction Test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      compactionCount: 5,
    });

    await incrementCompactionCount('chat-1');

    const chat = await getChat('chat-1');
    expect(chat!.compactionCount).toBe(6);
  });

  it('handles undefined initial compactionCount (treats as 0)', async () => {
    await createChat({
      id: 'chat-1',
      title: 'No Compaction',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await incrementCompactionCount('chat-1');

    const chat = await getChat('chat-1');
    expect(chat!.compactionCount).toBe(1);
  });

  it('does nothing when chat does not exist', async () => {
    // Should not throw
    await incrementCompactionCount('nonexistent');
  });
});

describe('updateCompactionSummary', () => {
  it('sets the compaction summary on a chat', async () => {
    await createChat({
      id: 'chat-1',
      title: 'Summary Test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await updateCompactionSummary('chat-1', 'This is a summary of earlier messages.');

    const chat = await getChat('chat-1');
    expect(chat!.compactionSummary).toBe('This is a summary of earlier messages.');
  });

  it('overwrites an existing compaction summary', async () => {
    await createChat({
      id: 'chat-1',
      title: 'Summary Test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      compactionSummary: 'Old summary',
    });

    await updateCompactionSummary('chat-1', 'New summary');

    const chat = await getChat('chat-1');
    expect(chat!.compactionSummary).toBe('New summary');
  });
});

describe('updateMemoryFlush', () => {
  it('sets memoryFlushAt and memoryFlushCompactionCount', async () => {
    const beforeTime = Date.now();
    await createChat({
      id: 'chat-1',
      title: 'Memory Flush Test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await updateMemoryFlush('chat-1', 3);

    const chat = await getChat('chat-1');
    expect(chat!.memoryFlushAt).toBeGreaterThanOrEqual(beforeTime);
    expect(chat!.memoryFlushCompactionCount).toBe(3);
  });

  it('overwrites existing memory flush values', async () => {
    await createChat({
      id: 'chat-1',
      title: 'Memory Flush Test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      memoryFlushAt: 1000,
      memoryFlushCompactionCount: 1,
    });

    await updateMemoryFlush('chat-1', 5);

    const chat = await getChat('chat-1');
    expect(chat!.memoryFlushAt).toBeGreaterThan(1000);
    expect(chat!.memoryFlushCompactionCount).toBe(5);
  });
});

describe('listChats with agentId filter', () => {
  it('returns only chats for the specified agentId', async () => {
    await createChat({ id: 'c1', title: 'A1', createdAt: 1000, updatedAt: 3000, agentId: 'agent-a' });
    await createChat({ id: 'c2', title: 'B1', createdAt: 2000, updatedAt: 4000, agentId: 'agent-b' });
    await createChat({ id: 'c3', title: 'A2', createdAt: 3000, updatedAt: 2000, agentId: 'agent-a' });
    await createChat({ id: 'c4', title: 'A3', createdAt: 4000, updatedAt: 1000, agentId: 'agent-a' });

    const chats = await listChats(100, 0, 'agent-a');
    expect(chats).toHaveLength(3);
    // Should be ordered by updatedAt descending
    expect(chats.map(c => c.id)).toEqual(['c1', 'c3', 'c4']);
  });

  it('respects limit and offset with agentId filter', async () => {
    await createChat({ id: 'c1', title: 'A1', createdAt: 1000, updatedAt: 4000, agentId: 'agent-a' });
    await createChat({ id: 'c2', title: 'A2', createdAt: 2000, updatedAt: 3000, agentId: 'agent-a' });
    await createChat({ id: 'c3', title: 'A3', createdAt: 3000, updatedAt: 2000, agentId: 'agent-a' });
    await createChat({ id: 'c4', title: 'A4', createdAt: 4000, updatedAt: 1000, agentId: 'agent-a' });

    const chats = await listChats(2, 1, 'agent-a');
    expect(chats).toHaveLength(2);
    expect(chats.map(c => c.id)).toEqual(['c2', 'c3']);
  });

  it('returns empty array when no chats match agentId', async () => {
    await createChat({ id: 'c1', title: 'A1', createdAt: 1000, updatedAt: 1000, agentId: 'agent-a' });

    const chats = await listChats(100, 0, 'agent-b');
    expect(chats).toEqual([]);
  });
});

// ── Agent CRUD ─────────────────────────────────

describe('Agent CRUD', () => {
  const now = Date.now();
  // Dexie indexes booleans as 0/1 numbers; getDefaultAgent queries .equals(1)
  // so we store isDefault as a numeric-truthy value cast through the type.
  const defaultAgent = {
    id: 'main',
    name: 'Main Agent',
    identity: { emoji: '' },
    isDefault: 1,
    createdAt: now,
    updatedAt: now,
  } as unknown as AgentConfig;

  const secondAgent = {
    id: 'agent-2',
    name: 'Second Agent',
    identity: { emoji: '🤖' },
    isDefault: 0,
    createdAt: now,
    updatedAt: now,
  } as unknown as AgentConfig;

  it('creates and retrieves an agent', async () => {
    await createAgent(defaultAgent);
    const result = await getAgent('main');
    expect(result).toEqual(defaultAgent);
  });

  it('returns undefined for non-existent agent', async () => {
    const result = await getAgent('nonexistent');
    expect(result).toBeUndefined();
  });

  it('lists all agents', async () => {
    await createAgent(defaultAgent);
    await createAgent(secondAgent);
    const agents = await listAgents();
    expect(agents).toHaveLength(2);
  });

  it('updates agent fields', async () => {
    await createAgent(defaultAgent);
    await updateAgent('main', { name: 'Renamed Agent' });
    const result = await getAgent('main');
    expect(result!.name).toBe('Renamed Agent');
    expect(result!.updatedAt).toBeGreaterThanOrEqual(now);
  });

  it('gets the default agent', async () => {
    await createAgent(defaultAgent);
    await createAgent(secondAgent);
    const result = await getDefaultAgent();
    expect(result).toBeDefined();
    expect(result!.id).toBe('main');
    expect(result!.isDefault).toBeTruthy();
  });

  it('returns undefined when no default agent exists', async () => {
    const result = await getDefaultAgent();
    expect(result).toBeUndefined();
  });

  it('deletes agent and all associated data', async () => {
    await createAgent(defaultAgent);
    await createAgent(secondAgent);

    // Create chat, messages, artifacts, workspace files, memory chunks for agent-2
    await createChat({
      id: 'chat-a2',
      title: 'Agent 2 Chat',
      createdAt: now,
      updatedAt: now,
      agentId: 'agent-2',
    });
    await addMessage({
      id: 'msg-a2',
      chatId: 'chat-a2',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
      createdAt: now,
    });
    await saveArtifact({
      id: 'art-a2',
      chatId: 'chat-a2',
      title: 'Art',
      kind: 'text',
      content: 'x',
      createdAt: now,
      updatedAt: now,
    });
    await createWorkspaceFile({
      id: 'ws-a2',
      name: 'test.md',
      content: 'test',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId: 'agent-2',
    });
    await bulkPutMemoryChunks([
      {
        id: 'mc-a2',
        fileId: 'ws-a2',
        filePath: 'test.md',
        startLine: 0,
        endLine: 1,
        text: 'chunk',
        fileUpdatedAt: now,
        agentId: 'agent-2',
      },
    ]);

    await deleteAgent('agent-2');

    expect(await getAgent('agent-2')).toBeUndefined();
    expect(await getChat('chat-a2')).toBeUndefined();
    expect(await getMessagesByChatId('chat-a2')).toEqual([]);
    expect(await getArtifactsByChatId('chat-a2')).toEqual([]);
    expect(await listWorkspaceFiles('agent-2')).toEqual([]);
    expect(await getAllMemoryChunks('agent-2')).toEqual([]);
  });

  it('throws when trying to delete the default agent', async () => {
    await createAgent(defaultAgent);
    await expect(deleteAgent('main')).rejects.toThrow('Cannot delete the default agent');
  });

  it('does nothing when deleting non-existent agent', async () => {
    // Should not throw
    await deleteAgent('nonexistent');
  });
});

// ── Workspace File CRUD ──────────────────────

describe('Workspace File CRUD', () => {
  const now = Date.now();
  const userFile: DbWorkspaceFile = {
    id: 'ws-1',
    name: 'notes.md',
    content: 'My notes',
    enabled: true,
    owner: 'user',
    predefined: false,
    createdAt: now,
    updatedAt: now,
    agentId: 'main',
  };

  const agentFile: DbWorkspaceFile = {
    id: 'ws-2',
    name: 'memory.md',
    content: 'Agent memory',
    enabled: true,
    owner: 'agent',
    predefined: false,
    createdAt: now,
    updatedAt: now,
    agentId: 'main',
  };

  const disabledFile: DbWorkspaceFile = {
    id: 'ws-3',
    name: 'disabled.md',
    content: 'Disabled file',
    enabled: false,
    owner: 'user',
    predefined: false,
    createdAt: now,
    updatedAt: now,
    agentId: 'main',
  };

  it('creates and retrieves a workspace file', async () => {
    await createWorkspaceFile(userFile);
    const result = await getWorkspaceFile('ws-1');
    expect(result).toEqual(userFile);
  });

  it('returns undefined for non-existent workspace file', async () => {
    const result = await getWorkspaceFile('nonexistent');
    expect(result).toBeUndefined();
  });

  it('lists all workspace files', async () => {
    await createWorkspaceFile(userFile);
    await createWorkspaceFile(agentFile);
    const files = await listWorkspaceFiles();
    expect(files).toHaveLength(2);
  });

  it('lists workspace files filtered by agentId', async () => {
    await createWorkspaceFile(userFile);
    await createWorkspaceFile({ ...agentFile, id: 'ws-other', agentId: 'other' });
    const files = await listWorkspaceFiles('main');
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe('ws-1');
  });

  it('lists only user-owned workspace files', async () => {
    await createWorkspaceFile(userFile);
    await createWorkspaceFile(agentFile);
    const files = await listUserWorkspaceFiles();
    expect(files).toHaveLength(1);
    expect(files[0]!.owner).toBe('user');
  });

  it('lists user workspace files filtered by agentId', async () => {
    await createWorkspaceFile(userFile);
    await createWorkspaceFile({ ...userFile, id: 'ws-other', agentId: 'other' });
    const files = await listUserWorkspaceFiles('main');
    expect(files).toHaveLength(1);
    expect(files[0]!.agentId).toBe('main');
  });

  it('lists only agent-owned memory files', async () => {
    await createWorkspaceFile(userFile);
    await createWorkspaceFile(agentFile);
    const files = await listAgentMemoryFiles();
    expect(files).toHaveLength(1);
    expect(files[0]!.owner).toBe('agent');
  });

  it('lists agent memory files filtered by agentId', async () => {
    await createWorkspaceFile(agentFile);
    await createWorkspaceFile({ ...agentFile, id: 'ws-other', agentId: 'other' });
    const files = await listAgentMemoryFiles('main');
    expect(files).toHaveLength(1);
    expect(files[0]!.agentId).toBe('main');
  });

  it('updates workspace file fields', async () => {
    await createWorkspaceFile(userFile);
    await updateWorkspaceFile('ws-1', { content: 'Updated content', name: 'renamed.md' });
    const result = await getWorkspaceFile('ws-1');
    expect(result!.content).toBe('Updated content');
    expect(result!.name).toBe('renamed.md');
    expect(result!.updatedAt).toBeGreaterThanOrEqual(now);
  });

  it('deletes a non-predefined workspace file', async () => {
    await createWorkspaceFile(userFile);
    await deleteWorkspaceFile('ws-1');
    expect(await getWorkspaceFile('ws-1')).toBeUndefined();
  });

  it('throws when deleting a predefined workspace file', async () => {
    const predefined: DbWorkspaceFile = { ...userFile, id: 'ws-pred', predefined: true };
    await createWorkspaceFile(predefined);
    await expect(deleteWorkspaceFile('ws-pred')).rejects.toThrow(
      'Cannot delete predefined workspace files',
    );
  });

  it('returns only enabled workspace files', async () => {
    await createWorkspaceFile(userFile);
    await createWorkspaceFile(disabledFile);
    const files = await getEnabledWorkspaceFiles();
    expect(files).toHaveLength(1);
    expect(files[0]!.enabled).toBe(true);
  });

  it('returns enabled workspace files filtered by agentId', async () => {
    await createWorkspaceFile(userFile);
    await createWorkspaceFile({ ...userFile, id: 'ws-other', agentId: 'other' });
    const files = await getEnabledWorkspaceFiles('main');
    expect(files).toHaveLength(1);
    expect(files[0]!.agentId).toBe('main');
  });
});

describe('seedPredefinedWorkspaceFiles', () => {
  it('seeds all predefined files for an agent', async () => {
    await seedPredefinedWorkspaceFiles('main');
    // Agent-scoped: all predefined files including skills (6 non-skill + 3 skills = 9)
    const agentFiles = await listWorkspaceFiles('main');
    expect(agentFiles.length).toBeGreaterThanOrEqual(9);
    expect(agentFiles.every(f => f.predefined)).toBe(true);
    expect(agentFiles.every(f => f.agentId === 'main')).toBe(true);
    // Skills are now agent-scoped, not global
    const agentSkills = await listSkillFiles('main');
    expect(agentSkills.length).toBeGreaterThanOrEqual(1);
    expect(agentSkills.every(f => f.predefined)).toBe(true);
    expect(agentSkills.every(f => f.agentId === 'main')).toBe(true);
  });

  it('does not re-create already existing predefined files', async () => {
    await seedPredefinedWorkspaceFiles('main');
    const firstCount = (await listWorkspaceFiles('main')).length;
    await seedPredefinedWorkspaceFiles('main');
    const secondCount = (await listWorkspaceFiles('main')).length;
    expect(secondCount).toBe(firstCount);
  });

  it('defaults agentId to main when not provided', async () => {
    await seedPredefinedWorkspaceFiles();
    const files = await listWorkspaceFiles('main');
    expect(files.length).toBeGreaterThan(0);
    expect(files.every(f => f.agentId === 'main')).toBe(true);
  });
});

// ── Memory Chunk CRUD ────────────────────────

describe('Memory Chunk CRUD', () => {
  const now = Date.now();
  const chunks: DbMemoryChunk[] = [
    {
      id: 'mc-1',
      fileId: 'file-1',
      filePath: 'MEMORY.md',
      startLine: 0,
      endLine: 10,
      text: 'First chunk of memory',
      fileUpdatedAt: now,
      agentId: 'main',
    },
    {
      id: 'mc-2',
      fileId: 'file-1',
      filePath: 'MEMORY.md',
      startLine: 11,
      endLine: 20,
      text: 'Second chunk of memory',
      fileUpdatedAt: now,
      agentId: 'main',
    },
    {
      id: 'mc-3',
      fileId: 'file-2',
      filePath: 'NOTES.md',
      startLine: 0,
      endLine: 5,
      text: 'Notes chunk',
      fileUpdatedAt: now,
      agentId: 'other',
    },
  ];

  it('bulk puts and retrieves all memory chunks', async () => {
    await bulkPutMemoryChunks(chunks);
    const all = await getAllMemoryChunks();
    expect(all).toHaveLength(3);
  });

  it('retrieves memory chunks filtered by agentId', async () => {
    await bulkPutMemoryChunks(chunks);
    const mainChunks = await getAllMemoryChunks('main');
    expect(mainChunks).toHaveLength(2);
    expect(mainChunks.every(c => c.agentId === 'main')).toBe(true);
  });

  it('deletes memory chunks by fileId', async () => {
    await bulkPutMemoryChunks(chunks);
    await deleteMemoryChunksByFileId('file-1');
    const remaining = await getAllMemoryChunks();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.fileId).toBe('file-2');
  });

  it('clears all memory chunks', async () => {
    await bulkPutMemoryChunks(chunks);
    await clearAllMemoryChunks();
    const all = await getAllMemoryChunks();
    expect(all).toEqual([]);
  });
});

// ── Skill File Helpers ────────────────────────

describe('Skill File Helpers', () => {
  const now = Date.now();

  it('lists only skill files (paths matching skills/*/SKILL.md)', async () => {
    await createWorkspaceFile({
      id: 'ws-skill',
      name: 'skills/summarize/SKILL.md',
      content: '---\nname: Summarize\ndescription: Summarize content\n---\nContent',
      enabled: true,
      owner: 'user',
      predefined: true,
      createdAt: now,
      updatedAt: now,
      agentId: 'main',
    });
    await createWorkspaceFile({
      id: 'ws-regular',
      name: 'AGENTS.md',
      content: 'Agent info',
      enabled: true,
      owner: 'user',
      predefined: true,
      createdAt: now,
      updatedAt: now,
      agentId: 'main',
    });

    const skills = await listSkillFiles('main');
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toContain('SKILL.md');
  });

  it('returns enabled skills with parsed metadata', async () => {
    await createWorkspaceFile({
      id: 'ws-skill-enabled',
      name: 'skills/summarize/SKILL.md',
      content: '---\nname: Summarize\ndescription: Summarize content\n---\nSummarize instructions',
      enabled: true,
      owner: 'user',
      predefined: true,
      createdAt: now,
      updatedAt: now,
      agentId: 'main',
    });
    await createWorkspaceFile({
      id: 'ws-skill-disabled',
      name: 'skills/disabled-skill/SKILL.md',
      content: '---\nname: Disabled\ndescription: Disabled skill\n---\nDisabled',
      enabled: false,
      owner: 'user',
      predefined: true,
      createdAt: now,
      updatedAt: now,
      agentId: 'main',
    });

    const skills = await getEnabledSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.metadata.name).toBe('Summarize');
  });

  it('filters enabled skills by agentId', async () => {
    await createWorkspaceFile({
      id: 'ws-skill-a',
      name: 'skills/research/SKILL.md',
      content: '---\nname: Research\ndescription: Do research\n---\nContent',
      enabled: true,
      owner: 'user',
      predefined: true,
      createdAt: now,
      updatedAt: now,
      agentId: 'main',
    });
    await createWorkspaceFile({
      id: 'ws-skill-b',
      name: 'skills/other/SKILL.md',
      content: '---\nname: Other\ndescription: Other skill\n---\nOther',
      enabled: true,
      owner: 'user',
      predefined: true,
      createdAt: now,
      updatedAt: now,
      agentId: 'agent-2',
    });

    const skills = await getEnabledSkills('main');
    expect(skills).toHaveLength(1);
    expect(skills[0]!.metadata.name).toBe('Research');
  });
});

// ── Scheduled Task CRUD ──────────────────────

describe('Scheduled Task CRUD', () => {
  const now = Date.now();
  const task1: DbScheduledTask = {
    id: 'task-1',
    name: 'Daily Report',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    schedule: { kind: 'cron', expression: '0 9 * * *' },
    payload: { kind: 'prompt', text: 'Generate daily report' },
    state: {},
  };

  const task2: DbScheduledTask = {
    id: 'task-2',
    name: 'Weekly Summary',
    enabled: false,
    createdAt: now,
    updatedAt: now,
    schedule: { kind: 'cron', expression: '0 9 * * 1' },
    payload: { kind: 'prompt', text: 'Generate weekly summary' },
    state: {},
  };

  it('bulk puts and lists scheduled tasks', async () => {
    await bulkPutScheduledTasks([task1, task2]);
    const tasks = await listScheduledTasks();
    expect(tasks).toHaveLength(2);
  });

  it('gets a scheduled task by id', async () => {
    await bulkPutScheduledTasks([task1]);
    const result = await getScheduledTask('task-1');
    expect(result).toBeDefined();
    expect(result!.name).toBe('Daily Report');
  });

  it('returns undefined for non-existent task', async () => {
    const result = await getScheduledTask('nonexistent');
    expect(result).toBeUndefined();
  });

  it('deletes a scheduled task and its run logs', async () => {
    await bulkPutScheduledTasks([task1]);
    await appendTaskRunLog({
      id: 'log-1',
      taskId: 'task-1',
      timestamp: now,
      status: 'ok',
      durationMs: 100,
    });

    await deleteScheduledTask('task-1');

    expect(await getScheduledTask('task-1')).toBeUndefined();
    const logs = await getTaskRunLogs('task-1');
    expect(logs).toEqual([]);
  });
});

// ── Task Run Log CRUD ────────────────────────

describe('Task Run Log CRUD', () => {
  const now = Date.now();

  it('appends and retrieves task run logs', async () => {
    const log1: DbTaskRunLog = {
      id: 'log-1',
      taskId: 'task-1',
      timestamp: 1000,
      status: 'ok',
      durationMs: 50,
    };
    const log2: DbTaskRunLog = {
      id: 'log-2',
      taskId: 'task-1',
      timestamp: 2000,
      status: 'error',
      error: 'Timeout',
      durationMs: 300,
    };

    await appendTaskRunLog(log1);
    await appendTaskRunLog(log2);

    const logs = await getTaskRunLogs('task-1');
    expect(logs).toHaveLength(2);
    expect(logs[0]!.timestamp).toBe(1000);
    expect(logs[1]!.timestamp).toBe(2000);
  });

  it('limits returned logs to the requested limit', async () => {
    for (let i = 0; i < 10; i++) {
      await appendTaskRunLog({
        id: `log-${i}`,
        taskId: 'task-1',
        timestamp: i * 1000,
        status: 'ok',
      });
    }

    const logs = await getTaskRunLogs('task-1', 3);
    expect(logs).toHaveLength(3);
    // Should return the most recent 3
    expect(logs[0]!.id).toBe('log-7');
    expect(logs[2]!.id).toBe('log-9');
  });

  it('returns empty array for task with no logs', async () => {
    const logs = await getTaskRunLogs('nonexistent');
    expect(logs).toEqual([]);
  });
});

// ── pruneOldSessions ─────────────────────────

describe('pruneOldSessions', () => {
  it('deletes chats older than 90 days', async () => {
    const ninetyOneDaysAgo = Date.now() - 91 * 24 * 60 * 60 * 1000;
    const recent = Date.now();

    await createChat({ id: 'old', title: 'Old', createdAt: ninetyOneDaysAgo, updatedAt: ninetyOneDaysAgo });
    await createChat({ id: 'new', title: 'New', createdAt: recent, updatedAt: recent });

    const pruned = await pruneOldSessions();
    expect(pruned).toBe(1);
    expect(await getChat('old')).toBeUndefined();
    expect(await getChat('new')).toBeDefined();
  });

  it('caps total chats at 500 by deleting oldest excess', async () => {
    const now = Date.now();
    // Create 502 chats — the first 2 should be pruned as excess
    for (let i = 0; i < 502; i++) {
      await createChat({
        id: `chat-${String(i).padStart(4, '0')}`,
        title: `Chat ${i}`,
        createdAt: now,
        updatedAt: now + i, // each slightly newer
      });
    }

    const pruned = await pruneOldSessions();
    expect(pruned).toBe(2);
    const remaining = await chatDb.chats.count();
    expect(remaining).toBe(500);
  });

  it('returns 0 when nothing needs pruning', async () => {
    await createChat({ id: 'c1', title: 'Chat', createdAt: Date.now(), updatedAt: Date.now() });
    const pruned = await pruneOldSessions();
    expect(pruned).toBe(0);
  });
});

// ── reapCronSessions ─────────────────────────

describe('reapCronSessions', () => {
  beforeEach(() => {
    _resetReaperThrottle();
  });

  it('deletes expired cron-sourced sessions', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const recent = Date.now();

    await createChat({
      id: 'cron-old',
      title: 'Old Cron',
      createdAt: eightDaysAgo,
      updatedAt: eightDaysAgo,
      source: 'cron',
    });
    await createChat({
      id: 'cron-new',
      title: 'New Cron',
      createdAt: recent,
      updatedAt: recent,
      source: 'cron',
    });
    await createChat({
      id: 'regular',
      title: 'Regular Chat',
      createdAt: eightDaysAgo,
      updatedAt: eightDaysAgo,
    });

    const reaped = await reapCronSessions();
    expect(reaped).toBe(1);
    expect(await getChat('cron-old')).toBeUndefined();
    expect(await getChat('cron-new')).toBeDefined();
    expect(await getChat('regular')).toBeDefined();
  });

  it('returns -1 when throttled (called within 5 minutes)', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await createChat({
      id: 'cron-old',
      title: 'Old Cron',
      createdAt: eightDaysAgo,
      updatedAt: eightDaysAgo,
      source: 'cron',
    });

    // First call succeeds
    const first = await reapCronSessions();
    expect(first).toBeGreaterThanOrEqual(0);

    // Second call within throttle window
    const second = await reapCronSessions();
    expect(second).toBe(-1);
  });

  it('accepts custom retention period', async () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

    await createChat({
      id: 'cron-recent',
      title: 'Recent Cron',
      createdAt: twoDaysAgo,
      updatedAt: twoDaysAgo,
      source: 'cron',
    });

    // With 1-day retention, 2-day-old sessions should be reaped
    const reaped = await reapCronSessions(1 * 24 * 60 * 60 * 1000);
    expect(reaped).toBe(1);
    expect(await getChat('cron-recent')).toBeUndefined();
  });

  it('returns 0 when no expired cron sessions exist', async () => {
    await createChat({
      id: 'cron-new',
      title: 'New Cron',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: 'cron',
    });

    const reaped = await reapCronSessions();
    expect(reaped).toBe(0);
  });
});

describe('copyGlobalSkillsToAgent', () => {
  it('copies non-predefined global skills to agent', async () => {
    // Create global (no agentId) skill files
    await createWorkspaceFile({
      id: 'global-skill-1',
      name: 'skills/my-skill/SKILL.md',
      content: '---\nname: My Skill\n---\nHello',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await createWorkspaceFile({
      id: 'global-skill-2',
      name: 'skills/my-skill/helper.md',
      content: 'Helper content',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await copyGlobalSkillsToAgent('agent-1');

    const agentFiles = await chatDb.workspaceFiles.where('agentId').equals('agent-1').toArray();
    expect(agentFiles).toHaveLength(2);
    expect(agentFiles.map(f => f.name).sort()).toEqual([
      'skills/my-skill/SKILL.md',
      'skills/my-skill/helper.md',
    ]);
    expect(agentFiles[0]!.predefined).toBe(false);
  });

  it('skips already-existing agent skills (idempotent)', async () => {
    await createWorkspaceFile({
      id: 'global-skill-3',
      name: 'skills/existing/SKILL.md',
      content: 'Global version',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // Agent already has this skill
    await createWorkspaceFile({
      id: 'agent-skill-3',
      name: 'skills/existing/SKILL.md',
      content: 'Agent version',
      enabled: false,
      owner: 'user',
      predefined: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agentId: 'agent-1',
    });

    await copyGlobalSkillsToAgent('agent-1');

    const agentFiles = await chatDb.workspaceFiles.where('agentId').equals('agent-1').toArray();
    expect(agentFiles).toHaveLength(1);
    expect(agentFiles[0]!.content).toBe('Agent version');
    expect(agentFiles[0]!.enabled).toBe(false);
  });

  it('does nothing when no global skills exist', async () => {
    // Create a predefined global skill (should be ignored)
    await createWorkspaceFile({
      id: 'predefined-skill',
      name: 'skills/daily-journal/SKILL.md',
      content: 'Predefined',
      enabled: true,
      owner: 'user',
      predefined: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await copyGlobalSkillsToAgent('agent-1');

    const agentFiles = await chatDb.workspaceFiles.where('agentId').equals('agent-1').toArray();
    expect(agentFiles).toHaveLength(0);
  });
});

describe('copyGlobalSkillsToAllAgents', () => {
  it('copies global skills to all existing agents', async () => {
    // Create two agents
    const now = Date.now();
    await createAgent({
      id: 'agent-a',
      name: 'Agent A',
      identity: { displayName: 'A' },
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });
    await createAgent({
      id: 'agent-b',
      name: 'Agent B',
      identity: { displayName: 'B' },
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    // Create a global skill
    await createWorkspaceFile({
      id: 'global-skill-1',
      name: 'skills/test-skill/SKILL.md',
      content: '---\nname: Test\n---\nHello',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await copyGlobalSkillsToAllAgents();

    const agentAFiles = await chatDb.workspaceFiles.where('agentId').equals('agent-a').toArray();
    const agentBFiles = await chatDb.workspaceFiles.where('agentId').equals('agent-b').toArray();
    expect(agentAFiles).toHaveLength(1);
    expect(agentAFiles[0].name).toBe('skills/test-skill/SKILL.md');
    expect(agentBFiles).toHaveLength(1);
    expect(agentBFiles[0].name).toBe('skills/test-skill/SKILL.md');
  });
});
