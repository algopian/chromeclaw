/**
 * Keep-alive alarm manager for MV3 background scripts.
 *
 * Both Chrome service workers and Firefox MV3 event pages can be suspended
 * after ~30 s of inactivity. A periodic alarm prevents this while streams
 * or background tasks are active.
 */

interface KeepAliveManager {
  /** Increment the active-task counter and create the alarm if first. */
  acquire: () => void;
  /** Decrement the counter and clear the alarm when it reaches zero. */
  release: () => void;
  /** Clear any orphaned alarm from a previous SW crash (call at module init). */
  clearOrphan: () => void;
}

/**
 * Create a keep-alive manager backed by `chrome.alarms`.
 * Works on both Chrome (service worker) and Firefox (MV3 event page).
 */
const createKeepAliveManager = (alarmName: string): KeepAliveManager => {
  let refCount = 0;

  return {
    acquire() {
      refCount++;
      if (refCount === 1) {
        chrome.alarms.create(alarmName, { periodInMinutes: 0.4 });
      }
    },
    release() {
      refCount = Math.max(0, refCount - 1);
      if (refCount === 0) {
        chrome.alarms.clear(alarmName);
      }
    },
    clearOrphan() {
      chrome.alarms.clear(alarmName);
    },
  };
};

export { createKeepAliveManager };
export type { KeepAliveManager };
