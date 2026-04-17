// Unit tests for the coalescing wake queue (R20 / 02.21).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWakeQueue, DEFAULT_RETRY_MS } from './wake';
import type { HeartbeatRunResult } from '../types';

// Minimal chrome.storage.session stub so persist()/hydrate() don't throw.
const installChromeStub = (): void => {
  const store: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (rec: Record<string, unknown>) => {
          Object.assign(store, rec);
        },
        remove: async (key: string) => {
          delete store[key];
        },
      },
    },
  };
};

const flush = async (): Promise<void> => {
  // Let any queued microtasks and timers settle.
  await vi.runAllTimersAsync();
};

describe('wakeQueue', () => {
  beforeEach(() => {
    installChromeStub();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple wakes for the same target into a single invocation', async () => {
    const q = createWakeQueue();
    const handler = vi.fn<(opts: unknown) => Promise<HeartbeatRunResult>>().mockResolvedValue({
      status: 'ran',
    });
    q.setHandler(handler);

    q.requestHeartbeatNow({ reason: 'interval', agentId: 'a' });
    q.requestHeartbeatNow({ reason: 'interval', agentId: 'a' });
    q.requestHeartbeatNow({ reason: 'interval', agentId: 'a' });

    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ reason: 'interval', agentId: 'a' });
  });

  it('higher-priority reason (manual) wins over interval for same target', async () => {
    const q = createWakeQueue();
    const handler = vi.fn<(opts: unknown) => Promise<HeartbeatRunResult>>().mockResolvedValue({
      status: 'ran',
    });
    q.setHandler(handler);

    q.requestHeartbeatNow({ reason: 'interval', agentId: 'a' });
    q.requestHeartbeatNow({ reason: 'manual', agentId: 'a' });

    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ reason: 'manual' });
  });

  it('retry reason does NOT displace a pending interval wake', async () => {
    const q = createWakeQueue();
    const handler = vi.fn<(opts: unknown) => Promise<HeartbeatRunResult>>().mockResolvedValue({
      status: 'ran',
    });
    q.setHandler(handler);

    q.requestHeartbeatNow({ reason: 'interval', agentId: 'a' });
    q.requestHeartbeatNow({ reason: 'retry', agentId: 'a' });

    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ reason: 'interval' });
  });

  it('distinct agents are NOT coalesced', async () => {
    const q = createWakeQueue();
    const handler = vi.fn<(opts: unknown) => Promise<HeartbeatRunResult>>().mockResolvedValue({
      status: 'ran',
    });
    q.setHandler(handler);

    q.requestHeartbeatNow({ reason: 'interval', agentId: 'a' });
    q.requestHeartbeatNow({ reason: 'interval', agentId: 'b' });

    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
    const agentIds = handler.mock.calls.map(c => (c[0] as { agentId: string }).agentId).sort();
    expect(agentIds).toEqual(['a', 'b']);
  });

  it('requeues with retry cooldown on requests-in-flight skip', async () => {
    const q = createWakeQueue();
    const handler = vi
      .fn<(opts: unknown) => Promise<HeartbeatRunResult>>()
      .mockResolvedValueOnce({ status: 'skipped', reason: 'requests-in-flight' })
      .mockResolvedValueOnce({ status: 'ran' });
    q.setHandler(handler);

    q.requestHeartbeatNow({ reason: 'manual', agentId: 'a' });

    // Initial coalesce fires the first call.
    await vi.advanceTimersByTimeAsync(300);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(q.hasPendingWake()).toBe(true);

    // Retry cooldown must wait the full backoff.
    await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_MS + 50);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0]).toMatchObject({ reason: 'retry', agentId: 'a' });
  });

  it('reports hasPendingWake() truthfully through the lifecycle', async () => {
    const q = createWakeQueue();
    const handler = vi.fn<(opts: unknown) => Promise<HeartbeatRunResult>>().mockResolvedValue({
      status: 'ran',
    });
    q.setHandler(handler);

    expect(q.hasPendingWake()).toBe(false);
    q.requestHeartbeatNow({ reason: 'interval', agentId: 'a' });
    expect(q.hasPendingWake()).toBe(true);

    await flush();

    expect(q.hasPendingWake()).toBe(false);
  });
});
