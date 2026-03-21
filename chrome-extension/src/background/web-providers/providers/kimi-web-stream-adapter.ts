/**
 * Kimi SSE stream adapter — handles Connect Protocol JSON frames
 * with done detection and error frame handling.
 */

import type { SseStreamAdapter } from '../sse-stream-adapter';

const createKimiStreamAdapter = (): SseStreamAdapter => {
  return {
    processEvent({ parsed, delta }) {
      const obj = parsed as Record<string, unknown>;

      // End-of-stream frame — emit any final delta
      if (obj.done === true) {
        return delta ? { feedText: delta } : null;
      }

      // Detect error frames
      if (obj.error) {
        const err = obj.error as Record<string, unknown>;
        const msg = (err.message ?? err.code ?? 'Unknown Kimi error') as string;
        throw new Error(msg);
      }

      // Regular text delta
      return delta ? { feedText: delta } : null;
    },

    flush() {
      return null;
    },

    shouldAbort() {
      return false;
    },
  };
};

export { createKimiStreamAdapter };
