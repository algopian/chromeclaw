// Unit tests for runHeartbeatOnce (R20 / 02.22, 02.25 sleep-catchup, 02.26 dedup).

import { runHeartbeatOnce } from './run-once';
import { loadHeartbeatConfig } from '../config';
import { _resetHeartbeatListeners } from '../events';
import { HEARTBEAT_TOKEN } from '../prompt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the agent-setup module so we don't pull in pi-mono / providers.
const mockModel = {
  id: 'm1',
  name: 'mock',
  provider: 'custom' as const,
  apiKey: 'x',
  baseUrl: 'http://localhost',
};

vi.mock('../../agents/agent-setup', () => ({
  runHeadlessLLM: vi.fn(),
  resolveDefaultModel: vi.fn(async () => mockModel),
  dbModelToChatModel: vi.fn((m: unknown) => m),
}));

vi.mock('../config', () => ({
  loadHeartbeatConfig: vi.fn(async () => ({
    enabled: true,
    every: '30m',
    ackMaxChars: 300,
    target: 'last',
  })),
  isHeartbeatEnabledForAgent: vi.fn(async () => true),
}));

const ts = Date.UTC(2026, 3, 1, 12, 0, 0);

const setConfig = (patch: Partial<Awaited<ReturnType<typeof loadHeartbeatConfig>>>) => {
  vi.mocked(loadHeartbeatConfig).mockResolvedValueOnce({
    enabled: true,
    every: '30m',
    ackMaxChars: 300,
    target: 'last',
    ...patch,
  });
};

describe('runHeartbeatOnce', () => {
  beforeEach(async () => {
    const { chatDb } = await import('@extension/storage');
    await chatDb.heartbeatState.clear();
    await chatDb.heartbeatLocks.clear();
    await chatDb.workspaceFiles.clear();
    await chatDb.messages.clear();
    await chatDb.chats.clear();
  });

  afterEach(() => {
    _resetHeartbeatListeners();
    vi.clearAllMocks();
  });

  it('skips when config is disabled', async () => {
    setConfig({ enabled: false });
    const runHeadless = vi.fn();
    const res = await runHeartbeatOnce({
      agentId: 'a',
      reason: 'interval',
      nowMs: () => ts,
      runHeadless: runHeadless as never,
    });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('disabled');
    expect(runHeadless).not.toHaveBeenCalled();
  });

  it('does not skip "disabled" when config.enabled is true', async () => {
    // loadHeartbeatConfig resolves `enabled` via the two-rule resolver, so
    // run-once simply trusts config.enabled without a separate resolver call.
    setConfig({ enabled: true });
    const runHeadless = vi.fn().mockResolvedValue({
      status: 'ok',
      chatId: 'chat-x',
      responseText: HEARTBEAT_TOKEN,
    });
    const res = await runHeartbeatOnce({
      agentId: 'a',
      reason: 'manual',
      nowMs: () => ts,
      runHeadless: runHeadless as never,
    });
    expect(res.reason).not.toBe('disabled');
    expect(runHeadless).toHaveBeenCalledTimes(1);
  });

  it('skips interval tick when HEARTBEAT.md is effectively empty', async () => {
    const { chatDb } = await import('@extension/storage');
    await chatDb.workspaceFiles.put({
      id: 'wf-1',
      agentId: 'a',
      name: 'HEARTBEAT.md',
      content: '# Heading\n\n- [ ]\n',
      enabled: true,
      owner: 'agent',
      predefined: true,
      createdAt: 0,
      updatedAt: 0,
    });

    const runHeadless = vi.fn();
    const res = await runHeartbeatOnce({
      agentId: 'a',
      reason: 'interval',
      nowMs: () => ts,
      runHeadless: runHeadless as never,
    });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('empty-heartbeat');
    expect(runHeadless).not.toHaveBeenCalled();
  });

  it('runs on manual trigger even with empty HEARTBEAT.md', async () => {
    const runHeadless = vi.fn().mockResolvedValue({
      status: 'ok',
      chatId: 'chat-1',
      responseText: HEARTBEAT_TOKEN,
    });
    const res = await runHeartbeatOnce({
      agentId: 'a',
      reason: 'manual',
      nowMs: () => ts,
      runHeadless: runHeadless as never,
    });
    expect(runHeadless).toHaveBeenCalledTimes(1);
    // HEARTBEAT_OK token alone → shouldSkip → 'ack'
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('ack');
  });

  it('persists lastHeartbeatText on delivered run', async () => {
    const runHeadless = vi.fn().mockResolvedValue({
      status: 'ok',
      chatId: 'chat-2',
      responseText: 'something the agent wants to say that is longer than the ack limit'.repeat(20),
    });
    const res = await runHeartbeatOnce({
      agentId: 'a',
      reason: 'manual',
      nowMs: () => ts,
      runHeadless: runHeadless as never,
    });
    expect(res.status).toBe('ran');

    const { chatDb } = await import('@extension/storage');
    const state = await chatDb.heartbeatState.get('a');
    expect(state?.lastStatus).toBe('ran');
    expect(state?.lastHeartbeatText).toBeTruthy();
    expect(state?.lastHeartbeatSentAt).toBe(ts);
  });

  it('dedups identical non-ack text within 24h', async () => {
    const longText = 'identical text '.repeat(40);

    const runHeadless = vi.fn().mockResolvedValue({
      status: 'ok',
      chatId: 'chat-3',
      responseText: longText,
    });

    const first = await runHeartbeatOnce({
      agentId: 'a',
      reason: 'manual',
      nowMs: () => ts,
      runHeadless: runHeadless as never,
    });
    expect(first.status).toBe('ran');

    const second = await runHeartbeatOnce({
      agentId: 'a',
      reason: 'manual',
      nowMs: () => ts + 60_000,
      runHeadless: runHeadless as never,
    });
    expect(second.status).toBe('skipped');
    expect(second.reason).toBe('dedup');
  });

  it('skips outside active hours', async () => {
    setConfig({
      activeHours: { start: '09:00', end: '17:00', timezone: 'UTC' },
    });
    const runHeadless = vi.fn();
    // 03:00 UTC is outside 09:00 - 17:00
    const nightMs = Date.UTC(2026, 3, 1, 3, 0, 0);
    const res = await runHeartbeatOnce({
      agentId: 'a',
      reason: 'interval',
      nowMs: () => nightMs,
      runHeadless: runHeadless as never,
    });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('inactive-hours');
    expect(runHeadless).not.toHaveBeenCalled();
  });
});
