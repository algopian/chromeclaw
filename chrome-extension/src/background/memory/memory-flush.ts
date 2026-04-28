/**
 * Pre-compaction memory flush — agent-based.
 *
 * Instead of a separate completeText() LLM call, the flush runs as an
 * agent turn so the agent can write memories using its own tools (workspace
 * write, memory search). This prevents excessive triggering and avoids
 * wasting a full LLM call when there's nothing to save.
 */

import { runAgent } from '../agents/agent-setup';
import { makeConvertToLlm } from '../agents/message-adapter';
import { estimateMessageTokens, shouldRunMemoryFlush } from '../context/compaction';
import { createLogger } from '../logging/logger-buffer';
import { getChat, getMessagesByChatId, updateMemoryFlush } from '@extension/storage';
import type { ChatModel, ChatMessage } from '@extension/shared';

const flushLog = createLogger('journal');

const SILENT_REPLY_TOKEN = 'NO_REPLY';

const DEFAULT_MEMORY_FLUSH_PROMPT = [
  'Pre-compaction memory flush.',
  'Store durable memories now:',
  '- Raw session notes → memory/YYYY-MM-DD.md (create memory/ if needed). APPEND only, do not overwrite.',
  '- Important long-term learnings (user preferences, key decisions) → also update MEMORY.md. Keep MEMORY.md concise — it is injected into every prompt.',
  `If nothing to store, reply with ${SILENT_REPLY_TOKEN}.`,
].join(' ');

const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  'Pre-compaction memory flush turn.',
  'The session is near auto-compaction; capture durable memories to disk.',
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(' ');

/**
 * Replace YYYY-MM-DD placeholders in the flush prompt with today's date.
 */
const resolveMemoryFlushPromptForRun = (prompt: string): string => {
  const today = new Date().toISOString().split('T')[0];
  return prompt.replace(/YYYY-MM-DD/g, today);
};

// ── Main flush function ─────────────────────────

interface MemoryFlushParams {
  chatId: string;
  modelConfig: ChatModel;
  systemPrompt: string;
  systemPromptTokens: number;
}

/**
 * Run a pre-compaction memory flush as an agent turn if conditions are met.
 *
 * Conditions:
 * 1. Chat has at least 4 messages
 * 2. Token count exceeds the soft threshold
 * 3. Flush hasn't already run for this compaction cycle
 */
const runMemoryFlushIfNeeded = async (params: MemoryFlushParams): Promise<void> => {
  const { chatId, modelConfig, systemPrompt, systemPromptTokens } = params;

  // 1. Load chat record for compaction count
  const chatRecord = await getChat(chatId);

  // 2. Cheap cycle guard — skip expensive message loading if already flushed
  //    for this compaction cycle (hoisted from shouldRunMemoryFlush)
  const currentCycle = chatRecord?.compactionCount ?? 0;
  const lastFlushCycle = chatRecord?.memoryFlushCompactionCount;
  if (lastFlushCycle !== undefined && lastFlushCycle === currentCycle) return;

  // 3. Load messages and check minimum count
  const messages = await getMessagesByChatId(chatId);
  if (messages.length < 4) return;

  // 4. Estimate tokens from current messages (DbChatMessage → ChatMessage cast:
  //    parts share the same shape at runtime, DB type is just less specific)
  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateMessageTokens(m as unknown as ChatMessage),
    0,
  );

  // 5. Check shouldRunMemoryFlush (threshold only — cycle guard already checked above)
  if (
    !shouldRunMemoryFlush({
      totalTokens,
      modelId: modelConfig.id,
      systemPromptTokens,
      compactionCount: chatRecord?.compactionCount,
      memoryFlushCompactionCount: chatRecord?.memoryFlushCompactionCount,
      contextWindowOverride: modelConfig.contextWindow,
    })
  )
    return;

  // 6. Run flush as agent turn
  const flushPrompt = resolveMemoryFlushPromptForRun(DEFAULT_MEMORY_FLUSH_PROMPT);
  const flushSystemPrompt = [systemPrompt, DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT]
    .filter(Boolean)
    .join('\n\n');

  flushLog.info('Memory flush starting', { chatId, totalTokens });

  try {
    const result = await runAgent({
      model: modelConfig,
      systemPrompt: flushSystemPrompt,
      prompt: flushPrompt,
      headlessTools: true, // uses write + memory_search tools, no scheduler/research
      convertToLlm: makeConvertToLlm(modelConfig),
    });

    // 7. Update memoryFlushCompactionCount
    //    If the flush turn itself triggered compaction, the count was already
    //    incremented by transformContext — re-read to get the current value.
    let memoryFlushCompactionCount = chatRecord?.compactionCount ?? 0;
    if (result.stepCount > 0) {
      const updated = await getChat(chatId);
      memoryFlushCompactionCount = updated?.compactionCount ?? memoryFlushCompactionCount;
    }
    await updateMemoryFlush(chatId, memoryFlushCompactionCount);

    flushLog.info('Memory flush complete', {
      chatId,
      steps: result.stepCount,
      timedOut: result.timedOut,
    });
  } catch (err) {
    flushLog.warn('Memory flush failed', { chatId, error: String(err) });
  }
};

export { runMemoryFlushIfNeeded, resolveMemoryFlushPromptForRun, SILENT_REPLY_TOKEN };
export type { MemoryFlushParams };
