// ── HeartbeatService orchestrator ───────────────
// Facade over state + wake queue + alarm timer + runHeartbeatOnce.
//
// Responsibilities:
//  - Own the per-agent scheduler state (nextDueMs, intervalMs).
//  - Translate chrome.alarms events into due-agent sweeps.
//  - Serialize per-agent runs through a Dexie TTL lock (5 min) so the SW can
//    be evicted mid-run without stranding the agent indefinitely.
//  - Expose an imperative `requestHeartbeatNow` that routes through the
//    coalescing wake queue.
//
// Not in scope: the actual heartbeat pipeline (see `service/run-once.ts`),
// delivery / channel dispatch (see `AgentsPanel` + channel bridges),
// config persistence (see `config.ts`).

import { loadHeartbeatConfig } from './config';
import { runHeartbeatOnce } from './service/run-once';
import { createInitialState } from './service/state';
import {
  HEARTBEAT_ALARM_NAME,
  HEARTBEAT_KICK_ALARM_NAME,
  clearAlarms,
  isSchedulerAlarm,
  scheduleKick,
  scheduleTick,
} from './service/timer';
import { createWakeQueue } from './service/wake';
import { chatDb, listAgents } from '@extension/storage';
import type { HeartbeatDeps, HeartbeatServiceState, AgentState } from './service/state';
import type { HeartbeatRunResult } from './types';

const LOCK_TTL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000; // 1 minute floor

const parseEveryToMs = (every: string | undefined): number => {
  if (!every) return 30 * 60 * 1000;
  const m = /^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/i.exec(every);
  if (!m) return 30 * 60 * 1000;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  const mult =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1_000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000;
  return Math.max(MIN_INTERVAL_MS, n * mult);
};

const acquireLock = async (agentId: string, nowMs: number, reason?: string): Promise<boolean> => {
  try {
    return await chatDb.transaction('rw', chatDb.heartbeatLocks, async () => {
      const existing = await chatDb.heartbeatLocks.get(agentId);
      if (existing && existing.expiresAt > nowMs) return false;
      await chatDb.heartbeatLocks.put({
        agentId,
        acquiredAt: nowMs,
        expiresAt: nowMs + LOCK_TTL_MS,
        reason,
      });
      return true;
    });
  } catch {
    return false;
  }
};

const releaseLock = async (agentId: string): Promise<void> => {
  try {
    await chatDb.heartbeatLocks.delete(agentId);
  } catch {
    /* best-effort */
  }
};

class HeartbeatService {
  private readonly state: HeartbeatServiceState;
  private readonly wake = createWakeQueue();

  constructor(deps: HeartbeatDeps) {
    this.state = createInitialState(deps);
    this.wake.setHandler(opts => this.runForAgent(opts.agentId, opts.reason));
  }

  /** Set up chrome.alarms + rehydrate wake queue. Idempotent. */
  async start(): Promise<void> {
    if (this.state.started) return;
    this.state.started = true;
    await this.refreshAgents();
    scheduleTick();
    await this.wake.hydrate();
  }

  /** Tear down; the SW may still be evicted after this. */
  async stop(): Promise<void> {
    this.state.started = false;
    await clearAlarms();
  }

  /** Imperative run request (manual button, cron bridge, exec-event). */
  requestHeartbeatNow(opts?: { reason?: string; agentId?: string; sessionKey?: string }): void {
    this.wake.requestHeartbeatNow(opts);
  }

  /**
   * Handle a chrome.alarms event. Swallows non-heartbeat alarms so the SW
   * dispatcher can forward the same event to other subsystems.
   */
  async handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
    if (!isSchedulerAlarm(alarm.name)) return;
    if (!this.state.started) return;
    if (this.state.running) return;
    this.state.running = true;
    try {
      await this.refreshAgents();
      await this.runDueAgents();
      this.rearmKick();
    } finally {
      this.state.running = false;
    }
  }

  /** Test hook — returns a snapshot of per-agent runtime state. */
  getAgentSnapshots(): AgentState[] {
    return Array.from(this.state.agents.values()).map(a => ({ ...a }));
  }

  static isSchedulerAlarm(name: string): boolean {
    return isSchedulerAlarm(name);
  }

  static readonly HEARTBEAT_ALARM_NAME = HEARTBEAT_ALARM_NAME;
  static readonly HEARTBEAT_KICK_ALARM_NAME = HEARTBEAT_KICK_ALARM_NAME;

  // ── internals ────────────────────────────────

  private async refreshAgents(): Promise<void> {
    const agents = await listAgents().catch(() => []);
    const seen = new Set<string>();
    const nowMs = this.state.deps.nowMs();
    for (const agent of agents) {
      seen.add(agent.id);
      const config = await loadHeartbeatConfig(agent.id);
      const intervalMs = parseEveryToMs(config.every);
      const existing = this.state.agents.get(agent.id);
      if (existing) {
        existing.intervalMs = intervalMs;
        // Only reset nextDueMs if unset (first refresh) to preserve drift.
        if (!existing.nextDueMs) existing.nextDueMs = nowMs + intervalMs;
      } else {
        this.state.agents.set(agent.id, {
          agentId: agent.id,
          intervalMs,
          nextDueMs: nowMs + intervalMs,
          lastRunMs: 0,
          inFlight: false,
        });
      }
    }
    // Drop agents that no longer exist.
    for (const id of [...this.state.agents.keys()]) {
      if (!seen.has(id)) this.state.agents.delete(id);
    }
  }

  private async runDueAgents(): Promise<void> {
    const nowMs = this.state.deps.nowMs();
    for (const agent of this.state.agents.values()) {
      if (agent.inFlight) continue;
      if (agent.nextDueMs > nowMs) continue;
      // Fire through the wake queue so concurrent manual requests coalesce.
      this.wake.requestHeartbeatNow({
        reason: 'interval',
        agentId: agent.agentId,
      });
    }
  }

  /** Schedule a one-shot kick at the earliest upcoming due time. */
  private rearmKick(): void {
    const nowMs = this.state.deps.nowMs();
    let earliest = Infinity;
    for (const agent of this.state.agents.values()) {
      if (agent.nextDueMs < earliest) earliest = agent.nextDueMs;
    }
    if (!Number.isFinite(earliest)) return;
    // Only kick when the next due is before the next periodic tick (~60s).
    if (earliest > nowMs + 55_000) return;
    scheduleKick(earliest);
  }

  private async runForAgent(
    agentIdMaybe: string | undefined,
    reason: string | undefined,
  ): Promise<HeartbeatRunResult> {
    const log = this.state.deps.log;
    const nowMs = this.state.deps.nowMs();
    if (!agentIdMaybe) {
      // Fan-out across due agents. Rare path — wake queue only queues single
      // targets today, but we handle it defensively.
      return { status: 'skipped', reason: 'no-agent' };
    }
    const agentId = agentIdMaybe;
    const agent = this.state.agents.get(agentId);
    if (agent?.inFlight) return { status: 'skipped', reason: 'requests-in-flight' };

    const got = await acquireLock(agentId, nowMs, reason);
    if (!got) return { status: 'skipped', reason: 'requests-in-flight' };

    if (agent) agent.inFlight = true;
    try {
      const result = await runHeartbeatOnce({
        agentId,
        reason,
        nowMs: this.state.deps.nowMs,
        log,
      });
      if (agent) {
        agent.lastRunMs = nowMs;
        agent.nextDueMs = this.state.deps.nowMs() + agent.intervalMs;
      }
      this.state.deps.onEvent?.({
        agentId,
        atMs: nowMs,
        reason: (reason as never) ?? 'interval',
        status: result.status,
        chatId: result.chatId,
        durationMs: result.durationMs,
        summary: result.reason,
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('heartbeat runForAgent crashed', { agentId, error: msg });
      return { status: 'failed', reason: msg };
    } finally {
      if (agent) agent.inFlight = false;
      await releaseLock(agentId);
    }
  }
}

export { HeartbeatService, LOCK_TTL_MS, parseEveryToMs, acquireLock, releaseLock };
