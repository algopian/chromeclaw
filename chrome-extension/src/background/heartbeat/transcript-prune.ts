// ── Transcript prune ────────────────────────────
// Replaces OpenClaw's fs-based `fs.truncate` with a Dexie-level equivalent.
//
// A "snapshot" is the highest message id observed for a chat at the start of
// a heartbeat run. If the run is later classified as skip (empty HEARTBEAT.md
// ack, dedup hit, effectively-empty response), we delete every message strictly
// added after the snapshot so the chat transcript looks unchanged.

import { chatDb } from '@extension/storage';

/**
 * Capture the lexically-greatest message id for a chat. Returns `null` when
 * the chat has no messages yet.
 */
const snapshotMaxMessageId = async (chatId: string): Promise<string | null> => {
  const messages = await chatDb.messages.where('chatId').equals(chatId).toArray();
  if (messages.length === 0) return null;
  let max = messages[0]!.id;
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]!.id > max) max = messages[i]!.id;
  }
  return max;
};

/**
 * Delete every message in the chat whose id is strictly greater than
 * `snapshotId`. Returns the number of rows deleted.
 *
 * A null snapshot means "chat was empty at snapshot time" — prune everything.
 */
const pruneMessagesAbove = async (
  chatId: string,
  snapshotId: string | null,
): Promise<number> => {
  const all = await chatDb.messages.where('chatId').equals(chatId).toArray();
  const toDelete = snapshotId === null ? all : all.filter(m => m.id > snapshotId);
  if (toDelete.length === 0) return 0;
  await chatDb.messages.bulkDelete(toDelete.map(m => m.id));
  return toDelete.length;
};

export { snapshotMaxMessageId, pruneMessagesAbove };
