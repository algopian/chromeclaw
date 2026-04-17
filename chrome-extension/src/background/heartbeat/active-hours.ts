// ── Active-hours evaluation ─────────────────────
// Ported from OpenClaw's `heartbeat-active-hours.ts`, adapted for the
// extension: no OpenClaw `cfg` dependency — takes a plain
// `HeartbeatConfig.activeHours` object directly.

import type { HeartbeatActiveHoursConfig } from './types';

const ACTIVE_HOURS_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

const parseTimeToMinutes = (opts: { allow24: boolean }, raw?: string): number | null => {
  if (!raw || !ACTIVE_HOURS_TIME_PATTERN.test(raw)) return null;
  const [hourStr, minuteStr] = raw.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour === 24) {
    if (!opts.allow24 || minute !== 0) return null;
    return 24 * 60;
  }
  return hour * 60 + minute;
};

const resolveTimezone = (raw?: string): string => {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === 'user' || trimmed === 'local') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
};

const minutesInZone = (nowMs: number, timeZone: string): number | null => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
    const hour = Number(map.hour);
    const minute = Number(map.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
};

/**
 * Returns true if `nowMs` (default: Date.now()) falls within the configured
 * active hours. Missing / malformed config → permissive (true).
 */
const isWithinActiveHours = (
  active: HeartbeatActiveHoursConfig | undefined,
  nowMs?: number,
): boolean => {
  if (!active) return true;

  const startMin = parseTimeToMinutes({ allow24: false }, active.start);
  const endMin = parseTimeToMinutes({ allow24: true }, active.end);
  if (startMin === null || endMin === null) return true;
  if (startMin === endMin) return false;

  const timeZone = resolveTimezone(active.timezone);
  const currentMin = minutesInZone(nowMs ?? Date.now(), timeZone);
  if (currentMin === null) return true;

  if (endMin > startMin) return currentMin >= startMin && currentMin < endMin;
  return currentMin >= startMin || currentMin < endMin;
};

export { isWithinActiveHours };
