// ── Coalescing wake queue ───────────────────────
// Ported from OpenClaw's `heartbeat-wake.ts`, adapted for MV3 service workers:
// - The in-memory timer still drives fast coalescing (tens to hundreds of ms).
// - Pending wake intents are mirrored to `chrome.storage.session` so they
//   survive short SW evictions. A subsequent tick rehydrates and drains them.
//
// Priority ordering for merging wakes that target the same (agentId,
// sessionKey) tuple: RETRY < INTERVAL < DEFAULT < ACTION. A higher-priority
// request wins; equal priority keeps the most recent request.

import { classifyReason, isActionLikeReason } from '../reason';
import type { HeartbeatRunResult } from '../types';

interface WakeOptions {
  reason?: string;
  agentId?: string;
  sessionKey?: string;
}

type WakeHandler = (opts: WakeOptions) => Promise<HeartbeatRunResult>;

type WakeTimerKind = 'normal' | 'retry';

interface PendingWake {
  reason: string;
  priority: number;
  requestedAt: number;
  agentId?: string;
  sessionKey?: string;
}

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;
const SESSION_STORAGE_KEY = 'heartbeat.pendingWakes';

const REASON_PRIORITY = {
  RETRY: 0,
  INTERVAL: 1,
  DEFAULT: 2,
  ACTION: 3,
} as const;

const normalizeReason = (reason?: string): string => {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  return trimmed || 'interval';
};

const normalizeTarget = (value?: string): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
};

const targetKey = (agentId?: string, sessionKey?: string): string =>
  `${agentId ?? ''}::${sessionKey ?? ''}`;

const resolvePriority = (reason: string): number => {
  const kind = classifyReason(reason);
  if (kind === 'retry') return REASON_PRIORITY.RETRY;
  if (kind === 'interval') return REASON_PRIORITY.INTERVAL;
  if (isActionLikeReason(kind)) return REASON_PRIORITY.ACTION;
  return REASON_PRIORITY.DEFAULT;
};

interface WakeQueue {
  /** Queue a wake; returns once the pending entry has been persisted. */
  requestHeartbeatNow: (opts?: WakeOptions & { coalesceMs?: number }) => void;
  /** Install (or replace) the wake handler. Returns a disposer. */
  setHandler: (next: WakeHandler | null) => () => void;
  hasPendingWake: () => boolean;
  /** Re-hydrate pending wakes from session storage; call on SW startup. */
  hydrate: () => Promise<void>;
  /** Test helper. */
  _reset: () => void;
}

const createWakeQueue = (): WakeQueue => {
  const pending = new Map<string, PendingWake>();
  let handler: WakeHandler | null = null;
  let handlerGeneration = 0;
  let scheduled = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDueAt: number | null = null;
  let timerKind: WakeTimerKind | null = null;

  const persist = (): void => {
    try {
      const snapshot = Array.from(pending.values());
      if (snapshot.length === 0) {
        void chrome.storage?.session?.remove?.(SESSION_STORAGE_KEY);
        return;
      }
      void chrome.storage?.session?.set?.({ [SESSION_STORAGE_KEY]: snapshot });
    } catch {
      /* chrome.storage.session unavailable (tests / non-SW ctx) */
    }
  };

  const enqueue = (params: {
    reason?: string;
    requestedAt?: number;
    agentId?: string;
    sessionKey?: string;
  }): void => {
    const requestedAt = params.requestedAt ?? Date.now();
    const reason = normalizeReason(params.reason);
    const agentId = normalizeTarget(params.agentId);
    const sessionKey = normalizeTarget(params.sessionKey);
    const key = targetKey(agentId, sessionKey);
    const next: PendingWake = {
      reason,
      priority: resolvePriority(reason),
      requestedAt,
      agentId,
      sessionKey,
    };
    const prev = pending.get(key);
    if (!prev) {
      pending.set(key, next);
    } else if (next.priority > prev.priority) {
      pending.set(key, next);
    } else if (next.priority === prev.priority && next.requestedAt >= prev.requestedAt) {
      pending.set(key, next);
    }
    persist();
  };

  const schedule = (coalesceMs: number, kind: WakeTimerKind = 'normal'): void => {
    const delay = Number.isFinite(coalesceMs) ? Math.max(0, coalesceMs) : DEFAULT_COALESCE_MS;
    const dueAt = Date.now() + delay;
    if (timer) {
      // Retry cooldown is sticky — do not collapse backoff.
      if (timerKind === 'retry') return;
      if (typeof timerDueAt === 'number' && timerDueAt <= dueAt) return;
      clearTimeout(timer);
      timer = null;
      timerDueAt = null;
      timerKind = null;
    }
    timerDueAt = dueAt;
    timerKind = kind;
    timer = setTimeout(() => {
      void fire(delay, kind);
    }, delay);
  };

  const fire = async (delay: number, kind: WakeTimerKind): Promise<void> => {
    timer = null;
    timerDueAt = null;
    timerKind = null;
    scheduled = false;

    const active = handler;
    if (!active) return;
    if (running) {
      scheduled = true;
      schedule(delay, kind);
      return;
    }

    const batch = Array.from(pending.values());
    pending.clear();
    persist();
    running = true;
    const ranAgentKeys = new Set<string>();
    try {
      for (const w of batch) {
        const opts: WakeOptions = {
          reason: w.reason,
          ...(w.agentId ? { agentId: w.agentId } : {}),
          ...(w.sessionKey ? { sessionKey: w.sessionKey } : {}),
        };
        const res = await active(opts);
        if (res.status === 'skipped' && res.reason === 'requests-in-flight') {
          enqueue({
            reason: 'retry',
            agentId: w.agentId,
            sessionKey: w.sessionKey,
          });
          schedule(DEFAULT_RETRY_MS, 'retry');
        } else {
          // Track agents that ran (or were skipped for non-lock reasons) so we
          // can drop stale wakes that accumulated during this run.
          ranAgentKeys.add(targetKey(w.agentId, w.sessionKey));
        }
      }
    } catch {
      for (const w of batch) {
        enqueue({
          reason: 'retry',
          agentId: w.agentId,
          sessionKey: w.sessionKey,
        });
      }
      schedule(DEFAULT_RETRY_MS, 'retry');
    } finally {
      running = false;
      // Drop pending wakes for agents that just ran successfully — they were
      // enqueued during execution and are stale duplicates of the user's intent.
      if (ranAgentKeys.size > 0) {
        for (const key of ranAgentKeys) {
          pending.delete(key);
        }
        persist();
      }
      if (pending.size > 0 || scheduled) {
        schedule(delay, 'normal');
      }
    }
  };

  const requestHeartbeatNow = (opts?: WakeOptions & { coalesceMs?: number }): void => {
    enqueue({
      reason: opts?.reason,
      agentId: opts?.agentId,
      sessionKey: opts?.sessionKey,
    });
    schedule(opts?.coalesceMs ?? DEFAULT_COALESCE_MS, 'normal');
  };

  const setHandler = (next: WakeHandler | null): (() => void) => {
    handlerGeneration += 1;
    const generation = handlerGeneration;
    handler = next;
    if (next) {
      if (timer) clearTimeout(timer);
      timer = null;
      timerDueAt = null;
      timerKind = null;
      running = false;
      scheduled = false;
      if (pending.size > 0) {
        schedule(DEFAULT_COALESCE_MS, 'normal');
      }
    }
    return () => {
      if (handlerGeneration !== generation) return;
      if (handler !== next) return;
      handlerGeneration += 1;
      handler = null;
    };
  };

  const hasPendingWake = (): boolean => pending.size > 0 || Boolean(timer) || scheduled;

  const hydrate = async (): Promise<void> => {
    try {
      const rec = await chrome.storage?.session?.get?.(SESSION_STORAGE_KEY);
      const raw = rec?.[SESSION_STORAGE_KEY];
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        if (item && typeof item === 'object') {
          const w = item as Partial<PendingWake>;
          enqueue({
            reason: w.reason,
            requestedAt: w.requestedAt,
            agentId: w.agentId,
            sessionKey: w.sessionKey,
          });
        }
      }
      if (handler && pending.size > 0) {
        schedule(DEFAULT_COALESCE_MS, 'normal');
      }
    } catch {
      /* storage unavailable */
    }
  };

  const _reset = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    timerDueAt = null;
    timerKind = null;
    pending.clear();
    scheduled = false;
    running = false;
    handlerGeneration += 1;
    handler = null;
    persist();
  };

  return { requestHeartbeatNow, setHandler, hasPendingWake, hydrate, _reset };
};

export {
  createWakeQueue,
  DEFAULT_COALESCE_MS,
  DEFAULT_RETRY_MS,
  SESSION_STORAGE_KEY,
  REASON_PRIORITY,
};
export type { WakeQueue, WakeHandler, WakeOptions, PendingWake };
