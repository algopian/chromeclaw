// ── Alarm timer integration ─────────────────────
// Two `chrome.alarms` are owned by the heartbeat subsystem:
//
//  - `heartbeat-tick`: a periodic (1-minute) alarm that wakes the service
//    worker so the per-agent scheduler can decide whether any agent is due.
//    This is the steady-state driver; it survives SW eviction because MV3
//    re-creates the SW when an alarm fires.
//
//  - `heartbeat-kick`: a one-shot alarm fired at a specific `when` timestamp
//    to catch a due time that would otherwise fall inside a 1-minute gap
//    (e.g. agent due in 30s). Coexists with the periodic tick.
//
// Keeping both names exported lets the SW-level `onAlarm` dispatcher filter
// heartbeat alarms out of the cron dispatcher with a cheap string compare.

const HEARTBEAT_ALARM_NAME = 'heartbeat-tick';
const HEARTBEAT_KICK_ALARM_NAME = 'heartbeat-kick';

/** True when the alarm is owned by the heartbeat subsystem. */
const isSchedulerAlarm = (name: string | undefined | null): boolean =>
  name === HEARTBEAT_ALARM_NAME || name === HEARTBEAT_KICK_ALARM_NAME;

/**
 * Arm the periodic tick. Idempotent — Chrome replaces any existing alarm with
 * the same name. Using `periodInMinutes: 1` is the minimum Chrome honours
 * reliably (30s is technically accepted but drifts under load).
 */
const scheduleTick = (): void => {
  try {
    chrome.alarms.create(HEARTBEAT_ALARM_NAME, {
      periodInMinutes: 1,
      when: Date.now() + 60_000,
    });
  } catch {
    /* alarms unavailable (tests / non-SW ctx) */
  }
};

/**
 * Schedule a one-shot kick at `whenMs`. Chrome enforces a floor of ~30s for
 * `when`; clamp aggressively so callers never miss an event by passing in
 * a past / near-past timestamp.
 */
const scheduleKick = (whenMs: number): void => {
  try {
    const when = Math.max(whenMs, Date.now() + 1_000);
    chrome.alarms.create(HEARTBEAT_KICK_ALARM_NAME, { when });
  } catch {
    /* alarms unavailable */
  }
};

/** Clear both alarms; used on `stop()`. */
const clearAlarms = async (): Promise<void> => {
  try {
    await chrome.alarms.clear(HEARTBEAT_ALARM_NAME);
    await chrome.alarms.clear(HEARTBEAT_KICK_ALARM_NAME);
  } catch {
    /* best-effort */
  }
};

export {
  HEARTBEAT_ALARM_NAME,
  HEARTBEAT_KICK_ALARM_NAME,
  isSchedulerAlarm,
  scheduleTick,
  scheduleKick,
  clearAlarms,
};
