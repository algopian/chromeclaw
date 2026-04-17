// ── Heartbeat subsystem public API ──────────────
// Consumers (SW entry, cron bridge, UI) import from this barrel only. Keeping
// the surface narrow lets internal reshuffles happen without ripple edits.

export { HeartbeatService } from './service';
export { setHeartbeatServiceRef, getHeartbeatServiceRef } from './ref';
export {
  HEARTBEAT_ALARM_NAME,
  HEARTBEAT_KICK_ALARM_NAME,
  isSchedulerAlarm,
  scheduleTick,
  scheduleKick,
} from './service/timer';
export { onHeartbeatEvent } from './events';
export {
  loadHeartbeatConfig,
  loadHeartbeatDefaults,
  saveHeartbeatConfig,
  saveHeartbeatDefaults,
} from './config';
export type {
  HeartbeatConfig,
  HeartbeatEvent,
  HeartbeatReason,
  HeartbeatRunResult,
  HeartbeatTrigger,
  HeartbeatActiveHoursConfig,
  HeartbeatVisibilityConfig,
} from './types';
