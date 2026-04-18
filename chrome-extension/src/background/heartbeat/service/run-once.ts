// ── runHeartbeatOnce ────────────────────────────
// Single-tick heartbeat execution for one agent. Mirrors OpenClaw's
// `runHeartbeat` pipeline, collapsed for ChromeClaw:
//
//   1. config.enabled?                → skip 'disabled'
//   2. inside activeHours?            → skip 'inactive-hours'
//   3. agent already in-flight?       → skip 'requests-in-flight'
//   4. HEARTBEAT.md empty + non-action trigger?  → skip 'empty-heartbeat'
//   5. snapshot message id
//   6. runHeadlessLLM with heartbeat prompt
//   7. stripHeartbeatToken → ack? dedup hit? effectively empty?
//        yes → pruneMessagesAbove(snapshot) + skip / skipped-ack
//        no  → deliver via channel (best-effort) and persist state
//
// The implementation is intentionally self-contained: the caller (the service
// orchestrator) owns lock acquisition, alarm scheduling, and retry.

import { runHeadlessLLM, resolveDefaultModel, dbModelToChatModel } from '../../agents/agent-setup';
import { getChannelConfigs } from '../../channels/config';
import { getChannelAdapter } from '../../channels/registry';
import { isWithinActiveHours } from '../active-hours';
import { loadHeartbeatConfig } from '../config';
import { emitHeartbeatEvent } from '../events';
import {
  isHeartbeatContentEffectivelyEmpty,
  resolveHeartbeatPrompt,
  stripHeartbeatToken,
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
} from '../prompt';
import { classifyReason, isActionLikeReason } from '../reason';
import { pruneMessagesAbove } from '../transcript-prune';
import { customModelsStorage, chatDb } from '@extension/storage';
import type { HeartbeatConfig, HeartbeatRunResult } from '../types';
import type { HeartbeatLogger, RunOutcome } from './state';

interface RunHeartbeatOnceOptions {
  agentId: string;
  reason?: string;
  nowMs?: () => number;
  log?: HeartbeatLogger;
  /** Allows tests to force the chat id associated with the run. */
  chatTitle?: string;
  /** If set, `runHeadlessLLM` is replaced by this callable (tests). */
  runHeadless?: typeof runHeadlessLLM;
}

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

const loadHeartbeatMdContent = async (agentId: string): Promise<string | undefined> => {
  try {
    const files = await chatDb.workspaceFiles.where('agentId').equals(agentId).toArray();
    const match = files.find(f => f.name === 'HEARTBEAT.md');
    return match?.content;
  } catch {
    return undefined;
  }
};

const resolveModelForAgent = async (modelHint?: string) => {
  let model = await resolveDefaultModel();
  if (modelHint) {
    const models = await customModelsStorage.get();
    const override = models?.find(m => m.modelId === modelHint || m.name === modelHint);
    if (override) model = dbModelToChatModel(override);
  }
  return model;
};

const persistState = async (
  agentId: string,
  patch: Partial<{
    lastRunAtMs: number;
    lastStatus: 'ran' | 'skipped' | 'failed';
    lastReason: string;
    lastResultSummary: string;
    lastHeartbeatText: string;
    lastHeartbeatSentAt: number;
    lastChatId: string;
  }>,
): Promise<void> => {
  try {
    const existing = await chatDb.heartbeatState.get(agentId);
    await chatDb.heartbeatState.put({
      agentId,
      ...(existing ?? {}),
      ...patch,
    });
  } catch {
    /* storage unavailable */
  }
};

const shouldSuppressByDedup = async (
  agentId: string,
  text: string,
  nowMs: number,
): Promise<boolean> => {
  try {
    const prior = await chatDb.heartbeatState.get(agentId);
    if (!prior?.lastHeartbeatText || !prior.lastHeartbeatSentAt) return false;
    if (nowMs - prior.lastHeartbeatSentAt > DEDUP_WINDOW_MS) return false;
    return prior.lastHeartbeatText === text;
  } catch {
    return false;
  }
};

/**
 * Deliver heartbeat text to a channel (Telegram, WhatsApp, etc.).
 * Follows the same pattern as cron executor's `deliverResult`.
 */
const deliverToChannel = async (
  config: HeartbeatConfig,
  text: string,
  log?: HeartbeatLogger,
): Promise<void> => {
  // config.target: 'last' = first active channel, 'none' = skip, string = channel id
  const target = config.target ?? 'last';
  if (target === 'none') return;

  let channelId: string | undefined;
  let to: string | undefined;

  if (target === 'last') {
    // Auto-resolve: pick first active channel with allowed senders
    const configs = await getChannelConfigs();
    const active = configs.find(
      c => c.enabled && c.status !== 'idle' && c.allowedSenderIds.length > 0,
    );
    if (!active) return; // No active channel — silently skip
    channelId = active.channelId;
    to = config.to ?? active.allowedSenderIds[0];
  } else {
    channelId = target;
    to = config.to;
  }

  if (!channelId || !to) return;

  const adapter = await getChannelAdapter(channelId);
  if (!adapter) {
    log?.warn?.('heartbeat channel delivery: no adapter', { channelId });
    return;
  }

  const msg =
    text.length > adapter.maxMessageLength ? text.slice(0, adapter.maxMessageLength) : text;

  const result = await adapter.sendMessage({ to, text: msg, parseMode: 'markdown' });
  if (result.ok) {
    log?.info?.('heartbeat delivered to channel', { channelId, to, messageId: result.messageId });
  } else {
    log?.warn?.('heartbeat channel delivery failed', { channelId, error: result.error });
  }
};

/** Notify the chat UI that a heartbeat produced a message worth showing. */
const notifyChatUI = (chatId: string, agentId: string): void => {
  chrome.runtime
    .sendMessage({
      type: 'HEARTBEAT_CHAT_DELIVERED',
      chatId,
      agentId,
    })
    .catch(() => {}); // No listeners is fine
};

/**
 * Execute one heartbeat tick for the given agent. Safe to call concurrently
 * across agents; the caller must serialize per-agent calls via the Dexie lock.
 */
const runHeartbeatOnce = async (opts: RunHeartbeatOnceOptions): Promise<HeartbeatRunResult> => {
  const { agentId } = opts;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const log = opts.log;
  const runHeadless = opts.runHeadless ?? runHeadlessLLM;
  const reasonRaw = opts.reason ?? 'interval';
  const reason = classifyReason(reasonRaw);
  const startedAt = nowMs();

  const finishSkip = async (skipReason: string): Promise<RunOutcome> => {
    log?.debug?.('heartbeat skipped', { agentId, skipReason, reason });
    await persistState(agentId, {
      lastRunAtMs: startedAt,
      lastStatus: 'skipped',
      lastReason: skipReason,
    });
    emitHeartbeatEvent({
      agentId,
      atMs: startedAt,
      reason,
      status: 'skipped',
      summary: skipReason,
    });
    return { status: 'skipped', reason: skipReason };
  };

  // 1. enabled? — consult the resolver so the default agent runs out of the
  //    box and explicit opt-in configs flip semantics correctly.
  const config = await loadHeartbeatConfig(agentId);
  if (!config.enabled) return finishSkip('disabled');

  // 2. active hours?
  if (config.activeHours && !isWithinActiveHours(config.activeHours, startedAt)) {
    return finishSkip('inactive-hours');
  }

  // 3. empty HEARTBEAT.md with non-action trigger?
  const heartbeatMd = await loadHeartbeatMdContent(agentId);
  if (!isActionLikeReason(reason) && isHeartbeatContentEffectivelyEmpty(heartbeatMd)) {
    return finishSkip('empty-heartbeat');
  }

  // 4. Emit started event.
  emitHeartbeatEvent({ agentId, atMs: startedAt, reason, status: 'started' });

  // 5. Build & run.
  const model = await resolveModelForAgent(config.model);
  if (!model) {
    log?.warn?.('heartbeat failed: no model', { agentId });
    await persistState(agentId, {
      lastRunAtMs: startedAt,
      lastStatus: 'failed',
      lastReason: 'no-model',
    });
    emitHeartbeatEvent({
      agentId,
      atMs: startedAt,
      reason,
      status: 'failed',
      error: 'no-model',
    });
    return { status: 'failed', reason: 'no-model' };
  }

  const prompt = resolveHeartbeatPrompt(config.prompt);
  const chatTitle = opts.chatTitle ?? `Heartbeat: ${agentId}`;

  log?.info?.('heartbeat request', {
    agentId,
    reason,
    model: model.id,
    prompt,
    heartbeatMd: heartbeatMd?.slice(0, 500),
  });

  let result: Awaited<ReturnType<typeof runHeadlessLLM>>;
  try {
    result = await runHeadless({
      message: prompt,
      chatTitle,
      model,
      source: 'heartbeat',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.error?.('heartbeat runHeadlessLLM threw', { agentId, error: msg });
    await persistState(agentId, {
      lastRunAtMs: startedAt,
      lastStatus: 'failed',
      lastReason: 'exception',
      lastResultSummary: msg,
    });
    emitHeartbeatEvent({
      agentId,
      atMs: startedAt,
      reason,
      status: 'failed',
      error: msg,
      durationMs: nowMs() - startedAt,
    });
    return { status: 'failed', reason: msg };
  }

  const chatId = result.chatId;

  log?.info?.('heartbeat response', {
    agentId,
    chatId,
    status: result.status,
    responseText: result.responseText?.slice(0, 1000),
    durationMs: nowMs() - startedAt,
  });

  if (result.status === 'error') {
    const err = result.error ?? 'unknown-error';
    await persistState(agentId, {
      lastRunAtMs: startedAt,
      lastStatus: 'failed',
      lastReason: err,
      lastChatId: chatId,
    });
    emitHeartbeatEvent({
      agentId,
      atMs: startedAt,
      reason,
      status: 'failed',
      error: err,
      chatId,
      durationMs: nowMs() - startedAt,
    });
    return { status: 'failed', reason: err, chatId };
  }

  // 7. Strip HEARTBEAT_OK + dedup.
  const stripped = stripHeartbeatToken(result.responseText, {
    mode: 'heartbeat',
    maxAckChars: config.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  });

  const shouldPrune = stripped.shouldSkip || !stripped.text;
  if (shouldPrune) {
    // Snapshot was "chat before run"; since we created the chat fresh,
    // null snapshot prunes everything, giving us a no-op transcript.
    if (chatId) {
      await pruneMessagesAbove(chatId, null).catch(() => 0);
    }
    await persistState(agentId, {
      lastRunAtMs: startedAt,
      lastStatus: 'skipped',
      lastReason: 'ack',
      lastChatId: chatId,
    });
    emitHeartbeatEvent({
      agentId,
      atMs: startedAt,
      reason,
      status: 'skipped',
      summary: 'ack',
      chatId,
      durationMs: nowMs() - startedAt,
    });
    return { status: 'skipped', reason: 'ack', chatId };
  }

  // Dedup: identical non-ack text within 24h → prune and skip.
  if (await shouldSuppressByDedup(agentId, stripped.text, startedAt)) {
    if (chatId) {
      await pruneMessagesAbove(chatId, null).catch(() => 0);
    }
    await persistState(agentId, {
      lastRunAtMs: startedAt,
      lastStatus: 'skipped',
      lastReason: 'dedup',
      lastChatId: chatId,
    });
    emitHeartbeatEvent({
      agentId,
      atMs: startedAt,
      reason,
      status: 'skipped',
      summary: 'dedup',
      chatId,
      durationMs: nowMs() - startedAt,
    });
    return { status: 'skipped', reason: 'dedup', chatId };
  }

  // Deliver: persist state, notify chat UI, and send to channel.
  await persistState(agentId, {
    lastRunAtMs: startedAt,
    lastStatus: 'ran',
    lastReason: String(reason),
    lastResultSummary: stripped.text.slice(0, 200),
    lastHeartbeatText: stripped.text,
    lastHeartbeatSentAt: startedAt,
    lastChatId: chatId,
  });
  const durationMs = nowMs() - startedAt;

  // Notify chat UI so it can show the heartbeat conversation
  if (chatId) {
    notifyChatUI(chatId, agentId);
  }

  // Deliver to channel (Telegram/WhatsApp) — best-effort, don't fail the run
  try {
    await deliverToChannel(config, stripped.text, log);
  } catch (err) {
    log?.warn?.('heartbeat channel delivery error', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  emitHeartbeatEvent({
    agentId,
    atMs: startedAt,
    reason,
    status: 'ran',
    chatId,
    durationMs,
    summary: stripped.text.slice(0, 200),
  });
  return { status: 'ran', chatId, durationMs };
};

export { runHeartbeatOnce, DEDUP_WINDOW_MS };
export type { RunHeartbeatOnceOptions };
