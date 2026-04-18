// ── Service ref ─────────────────────────────────
// Module-level singleton accessor for the HeartbeatService. The SW entry
// (`background/index.ts`) wires the instance here; other subsystems (cron
// executor) read via `getHeartbeatServiceRef()` without forcing a cyclic
// import on the service class.

import type { HeartbeatService } from './service';

let ref: HeartbeatService | null = null;

const setHeartbeatServiceRef = (svc: HeartbeatService | null): void => {
  ref = svc;
};

const getHeartbeatServiceRef = (): HeartbeatService | null => ref;

export { setHeartbeatServiceRef, getHeartbeatServiceRef };
