// ── Heartbeat reason / trigger classification ────
// Ported from OpenClaw's `heartbeat-reason.ts`. Simplified: we don't need the
// full taxonomy here — just a normalized kind used by the runner to decide
// between skip policies.

import type { HeartbeatReason, HeartbeatTrigger } from './types';

const trimReason = (raw?: string): string => (typeof raw === 'string' ? raw.trim() : '');

/**
 * Classify a raw trigger string into a normalized reason. Unknown / empty
 * triggers collapse to `'interval'` so the subsystem degrades to the safest
 * path (skip-when-empty).
 */
const classifyReason = (trigger?: HeartbeatTrigger | string): HeartbeatReason => {
  const raw = typeof trigger === 'string' ? trigger : trigger?.kind;
  const trimmed = trimReason(raw);
  if (!trimmed) return 'interval';
  if (trimmed === 'interval') return 'interval';
  if (trimmed === 'manual') return 'manual';
  if (trimmed === 'retry') return 'retry';
  if (trimmed === 'exec-event') return 'exec-event';
  if (trimmed === 'wake') return 'wake';
  if (trimmed.startsWith('cron:')) return trimmed as HeartbeatReason;
  if (trimmed === 'cron') return 'cron:unknown';
  return 'other';
};

/** True for reasons that bypass the "empty HEARTBEAT.md" short-circuit. */
const isActionLikeReason = (reason: HeartbeatReason): boolean =>
  reason === 'manual' || reason === 'exec-event' || reason === 'wake' || reason.startsWith('cron:');

export { classifyReason, isActionLikeReason };
