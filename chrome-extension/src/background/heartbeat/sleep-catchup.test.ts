// Service-level test: sleep catch-up (R20 / 02.25).
//
// When the host machine sleeps, in-memory state and alarms are paused. On
// resume, the next `heartbeat-tick` may find `nextDueMs` hours in the past.
// The service must collapse all that backlog into a single `runForAgent`
// invocation and then rearm for `now + intervalMs`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the real chatDb (fake-indexeddb) but stub listAgents since HeartbeatService.refreshAgents calls it.
vi.mock('@extension/storage', async () => {
  const actual = await vi.importActual<typeof import('@extension/storage')>('@extension/storage');
  return {
    ...actual,
    listAgents: vi.fn(async () => [{ id: 'a', name: 'a' } as never]),
  };
});

vi.mock('./config', () => ({
  loadHeartbeatConfig: vi.fn(async () => ({
    enabled: true,
    every: '30m',
    ackMaxChars: 300,
    target: 'last',
  })),
}));

// Neutralise alarm calls in test env.
vi.mock('./service/timer', async () => {
  const actual = await vi.importActual<typeof import('./service/timer')>('./service/timer');
  return {
    ...actual,
    scheduleTick: vi.fn(),
    scheduleKick: vi.fn(),
    clearAlarms: vi.fn(async () => {}),
  };
});

// Stub runHeartbeatOnce to observe invocations without real work.
const runOnceMock = vi.fn(async () => ({ status: 'ran' as const, chatId: 'c1' }));
vi.mock('./service/run-once', () => ({
  runHeartbeatOnce: (...args: unknown[]) => runOnceMock(...args),
}));

import { HeartbeatService } from './service';

const makeLog = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
});

describe('HeartbeatService sleep catch-up', () => {
  beforeEach(async () => {
    const { chatDb } = await import('@extension/storage');
    await chatDb.heartbeatLocks.clear();
    await chatDb.heartbeatState.clear();
    vi.useFakeTimers();
    runOnceMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a backlog into a single run and rearms nextDueMs to now+interval', async () => {
    const intervalMs = 30 * 60_000;
    let fakeNow = Date.UTC(2026, 3, 1, 12, 0, 0);
    const svc = new HeartbeatService({ log: makeLog(), nowMs: () => fakeNow });
    await svc.start();

    // Force the agent's nextDueMs 8 hours in the past.
    const snap = svc.getAgentSnapshots();
    expect(snap).toHaveLength(1);
    // Reach into internal state to simulate post-sleep drift.
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    const agents = (svc as unknown as { state: { agents: Map<string, { nextDueMs: number }> } })
      .state.agents;
    agents.get('a')!.nextDueMs = fakeNow - 8 * 60 * 60_000;

    // Fire alarm; handleAlarm sweeps due agents through the wake queue.
    await svc.handleAlarm({ name: 'heartbeat-tick' } as chrome.alarms.Alarm);

    // Wake queue coalesces with a ~250ms timer; advance it.
    await vi.advanceTimersByTimeAsync(500);

    expect(runOnceMock).toHaveBeenCalledTimes(1);

    // nextDueMs should now be in the future (~now + interval), NOT another
    // backlog step.
    const after = agents.get('a')!.nextDueMs;
    expect(after).toBeGreaterThanOrEqual(fakeNow);
    expect(after - fakeNow).toBeLessThanOrEqual(intervalMs + 1_000);
  });
});
