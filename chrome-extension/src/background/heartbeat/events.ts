// ── In-memory pub/sub for heartbeat events ──────
// Background service worker only: listeners are ephemeral and die with the
// worker, just like the events themselves.

import type { HeartbeatEvent } from './types';

type HeartbeatListener = (event: HeartbeatEvent) => void;

const listeners = new Set<HeartbeatListener>();

/** Register a listener. Returns an unsubscribe function. */
const onHeartbeatEvent = (listener: HeartbeatListener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Fire an event to all listeners; individual listener errors are isolated. */
const emitHeartbeatEvent = (event: HeartbeatEvent): void => {
  for (const l of [...listeners]) {
    try {
      l(event);
    } catch {
      /* ignore */
    }
  }
};

/** Test-only helper to drop all registered listeners. */
const _resetHeartbeatListeners = (): void => {
  listeners.clear();
};

export { onHeartbeatEvent, emitHeartbeatEvent, _resetHeartbeatListeners };
export type { HeartbeatListener };
