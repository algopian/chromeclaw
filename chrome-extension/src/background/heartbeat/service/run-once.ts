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
import type { HeartbeatRunResult } from '../types';
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

const hashText = (s: string): string => {
  // Lightweight 53-bit hash (DJB2 xor). Sufficient for dedup bucket keys.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return String(h >>> 0);
};

const isInFlight = async (agentId: string, nowMs: number): Promise<boolean> => {
  try {
    const lock = await chatDb.heartbeatLocks.get(agentId);
    if (!lock) return false;
    if (lock.expiresAt <= nowMs) return false;
    return true;
  } catch {
    return false;
  }
};

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
    return hashText(prior.lastHeartbeatText) === hashText(text);
  } catch {
    return false;
  }
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

  // 1. enabled?
  const config = await loadHeartbeatConfig(agentId);
  if (!config.enabled) return finishSkip('disabled');

  // 2. active hours?
  if (config.activeHours && !isWithinActiveHours(config.activeHours, startedAt)) {
    return finishSkip('inactive-hours');
  }

  // 3. in-flight?
  if (await isInFlight(agentId, startedAt)) {
    return finishSkip('requests-in-flight');
  }

  // 4. empty HEARTBEAT.md with non-action trigger?
  const heartbeatMd = await loadHeartbeatMdContent(agentId);
  if (!isActionLikeReason(reason) && isHeartbeatContentEffectivelyEmpty(heartbeatMd)) {
    return finishSkip('empty-heartbeat');
  }

  // 5. Snapshot the transcript so skip-cases can prune additions.
  //    Heartbeat starts its own chat — we snapshot after chat creation by
  //    pruning against the known chatId returned from runHeadlessLLM.
  emitHeartbeatEvent({ agentId, atMs: startedAt, reason, status: 'started' });

  // 6. Build & run.
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

  // Deliver: persist state, emit `ran` event. Channel dispatch is handled
  // by a listener (AgentsPanel UI, channels bridge). Keeping delivery out of
  // this module avoids a hard dep on the channels registry and lets the UI
  // be the single source of truth for alert rendering.
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

export { runHeartbeatOnce, DEDUP_WINDOW_MS, hashText };
export type { RunHeartbeatOnceOptions };
