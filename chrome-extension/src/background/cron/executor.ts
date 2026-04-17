// ── Task executor ───────────────────────────
// Executes scheduled tasks via headless LLM

import { runHeadlessLLM, resolveDefaultModel, dbModelToChatModel } from '../agents/agent-setup';
import { getChannelConfigs } from '../channels/config';
import { getChannelAdapter } from '../channels/registry';
import { getHeartbeatServiceRef } from '../heartbeat';
import { createLogger } from '../logging/logger-buffer';
import { createKeepAliveManager } from '../utils/keep-alive';
import {
  addMessage,
  getChat,
  getMostRecentChat,
  touchChat,
  customModelsStorage,
  lastActiveSessionStorage,
} from '@extension/storage';
import { nanoid } from 'nanoid';
import type { TaskExecResult } from './service/state';
import type { ScheduledTask, TaskDelivery } from './types';

const cronLog = createLogger('cron');
const cronKeepAlive = createKeepAliveManager('cron-keep-alive');

const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Resolve a default delivery target from the first active channel with allowed senders. */
const resolveDefaultDelivery = async (): Promise<TaskDelivery | undefined> => {
  const configs = await getChannelConfigs();
  const active = configs.find(
    c => c.enabled && c.status !== 'idle' && c.allowedSenderIds.length > 0,
  );
  if (!active) return undefined;
  return { channel: active.channelId, to: active.allowedSenderIds[0], bestEffort: true };
};

const deliverResult = async (task: ScheduledTask, responseText: string): Promise<void> => {
  if (!task.delivery) return;

  const { channel, to, bestEffort } = task.delivery;
  const adapter = await getChannelAdapter(channel);

  if (!adapter) {
    if (bestEffort) {
      cronLog.warn('No adapter for delivery channel, skipping (bestEffort)', { channel });
      return;
    }
    throw new Error(`No adapter for delivery channel: ${channel}`);
  }

  const text =
    responseText.length > adapter.maxMessageLength
      ? responseText.slice(0, adapter.maxMessageLength)
      : responseText;

  const result = await adapter.sendMessage({ to, text, parseMode: 'markdown' });

  if (!result.ok) {
    if (bestEffort) {
      cronLog.warn('Delivery failed (bestEffort)', { channel, error: result.error });
      return;
    }
    throw new Error(`Delivery failed: ${result.error}`);
  }

  cronLog.info('Result delivered', { channel, to, messageId: result.messageId });
};

const executeScheduledTask = async (task: ScheduledTask): Promise<TaskExecResult> => {
  cronLog.info('Executing task', { taskId: task.id, name: task.name, kind: task.payload.kind });

  cronKeepAlive.acquire();

  const payloadTimeout = task.payload.kind === 'agentTurn' ? task.payload.timeoutMs : undefined;
  const timeoutMs = task.timeoutMs ?? payloadTimeout ?? DEFAULT_TASK_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (task.payload.kind === 'agentTurn') {
      if (task.payload.wakeMode === 'heartbeat') {
        return await executeHeartbeatBridge(task);
      }
      return await executeAgentTurn(task, controller.signal);
    }

    if (task.payload.kind === 'chatInject') {
      return await executeChatInject(task);
    }

    return {
      status: 'error',
      error: `Unknown payload kind: ${(task.payload as { kind: string }).kind}`,
    };
  } finally {
    clearTimeout(timer);
    cronKeepAlive.release();
  }
};

const executeHeartbeatBridge = async (task: ScheduledTask): Promise<TaskExecResult> => {
  if (task.payload.kind !== 'agentTurn' || task.payload.wakeMode !== 'heartbeat') {
    return { status: 'error', error: 'Expected heartbeat agentTurn payload' };
  }
  const svc = getHeartbeatServiceRef();
  if (!svc) {
    return { status: 'error', error: 'HeartbeatService not initialized' };
  }
  svc.requestHeartbeatNow({
    reason: `cron:${task.id}`,
    agentId: task.payload.agentId,
    sessionKey: task.payload.sessionKey,
  });
  cronLog.info('Cron delegated to heartbeat service', {
    taskId: task.id,
    agentId: task.payload.agentId,
  });
  // Heartbeat runs async; cron fires-and-forgets. 'ok' surfaces success in
  // the scheduler UI. Failures show up in heartbeat state telemetry.
  return { status: 'ok' };
};

const executeAgentTurn = async (
  task: ScheduledTask,
  signal: AbortSignal,
): Promise<TaskExecResult> => {
  if (task.payload.kind !== 'agentTurn') {
    return { status: 'error', error: 'Expected agentTurn payload' };
  }

  // Resolve model if specified
  const payload = task.payload;
  let model = await resolveDefaultModel();
  if (payload.kind === 'agentTurn' && payload.model) {
    const models = await customModelsStorage.get();
    const override = models?.find(m => m.modelId === payload.model || m.name === payload.model);
    if (override) model = dbModelToChatModel(override);
  }

  if (!model) {
    return { status: 'error', error: 'No model configured' };
  }

  const result = await runHeadlessLLM({
    message: task.payload.message,
    chatTitle: `Scheduled: ${task.name}`,
    model,
    timeoutMs: task.timeoutMs ?? (payload.kind === 'agentTurn' ? payload.timeoutMs : undefined),
    signal,
  });

  cronLog.info('Task completed', {
    taskId: task.id,
    status: result.status,
    chatId: result.chatId,
  });

  // Attempt delivery — use explicit config or fall back to active channel
  const effectiveDelivery = task.delivery ?? (await resolveDefaultDelivery());
  if (result.status === 'ok' && effectiveDelivery) {
    try {
      await deliverResult({ ...task, delivery: effectiveDelivery }, result.responseText);
    } catch (err) {
      if (!effectiveDelivery.bestEffort) {
        return {
          status: 'error',
          error: `Execution succeeded but delivery failed: ${err instanceof Error ? err.message : String(err)}`,
          chatId: result.chatId,
        };
      }
    }
  }

  return {
    status: result.status,
    error: result.error,
    chatId: result.chatId,
  };
};

const executeChatInject = async (task: ScheduledTask): Promise<TaskExecResult> => {
  if (task.payload.kind !== 'chatInject') {
    return { status: 'error', error: 'Expected chatInject payload' };
  }

  const { message } = task.payload;
  let { chatId } = task.payload;

  if (!chatId) {
    return { status: 'error', error: 'chatInject payload missing chatId' };
  }

  try {
    // Verify target chat exists; fall back to active/most-recent session
    let chat = await getChat(chatId);
    if (!chat) {
      cronLog.warn('Target chat not found, falling back', { originalChatId: chatId });
      const activeId = await lastActiveSessionStorage.get();
      if (activeId) chat = await getChat(activeId);
      if (!chat) {
        chat = await getMostRecentChat();
      }
      if (!chat) {
        return { status: 'error', error: 'No available chat to inject into' };
      }
      chatId = chat.id;
      cronLog.info('Using fallback chat', { chatId });
    }

    // Add the message to the existing chat
    await addMessage({
      id: nanoid(),
      chatId,
      role: 'user',
      parts: [{ type: 'text', text: `[Scheduled: ${task.name}] ${message}` }],
      createdAt: Date.now(),
    });
    await touchChat(chatId);

    // Notify UI to reload messages for this chat
    chrome.runtime
      .sendMessage({
        type: 'CRON_CHAT_INJECT',
        chatId,
        taskName: task.name,
      })
      .catch(() => {}); // No listeners is fine

    cronLog.info('Chat inject completed', { taskId: task.id, chatId });
    return { status: 'ok', chatId };
  } catch (err) {
    return {
      status: 'error',
      error: `Failed to inject: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

export { executeScheduledTask };
