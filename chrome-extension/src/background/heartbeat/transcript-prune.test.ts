// Unit tests for transcript prune (R20 / 02.23).

import { beforeEach, describe, expect, it } from 'vitest';
import { snapshotMaxMessageId, pruneMessagesAbove } from './transcript-prune';

describe('transcript-prune', () => {
  beforeEach(async () => {
    const { chatDb } = await import('@extension/storage');
    await chatDb.messages.clear();
  });

  const addMsg = async (chatId: string, id: string, text = 'x') => {
    const { chatDb } = await import('@extension/storage');
    await chatDb.messages.put({
      id,
      chatId,
      role: 'user',
      parts: [{ type: 'text', text }],
      createdAt: Date.now(),
    });
  };

  it('returns null snapshot for an empty chat', async () => {
    expect(await snapshotMaxMessageId('chat-empty')).toBeNull();
  });

  it('captures the lexically-greatest id', async () => {
    await addMsg('c', 'aaa');
    await addMsg('c', 'ccc');
    await addMsg('c', 'bbb');
    expect(await snapshotMaxMessageId('c')).toBe('ccc');
  });

  it('prunes only messages strictly above snapshot', async () => {
    await addMsg('c', 'm1');
    await addMsg('c', 'm2');
    const snap = await snapshotMaxMessageId('c');
    await addMsg('c', 'm3');
    await addMsg('c', 'm4');

    const deleted = await pruneMessagesAbove('c', snap);
    expect(deleted).toBe(2);

    const { chatDb } = await import('@extension/storage');
    const remaining = await chatDb.messages.where('chatId').equals('c').toArray();
    expect(remaining.map(m => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('prunes everything when snapshot is null', async () => {
    await addMsg('c', 'm1');
    await addMsg('c', 'm2');
    const deleted = await pruneMessagesAbove('c', null);
    expect(deleted).toBe(2);

    const { chatDb } = await import('@extension/storage');
    expect(await chatDb.messages.where('chatId').equals('c').count()).toBe(0);
  });

  it('does not touch messages in other chats', async () => {
    await addMsg('a', 'a1');
    await addMsg('b', 'b1');
    await pruneMessagesAbove('a', null);
    const { chatDb } = await import('@extension/storage');
    expect(await chatDb.messages.where('chatId').equals('b').count()).toBe(1);
  });
});
