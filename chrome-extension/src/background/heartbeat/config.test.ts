// Unit tests for heartbeat config resolver (phase 03).
//
// Mirrors OpenClaw's `isHeartbeatEnabledForAgent` + `resolveHeartbeatConfig`:
//
//   Rule 1: If any agent has an explicit `heartbeat.<id>` entry in
//           chrome.storage.local, semantics are opt-in — only agents whose
//           explicit config has `enabled: true` run.
//   Rule 2: Otherwise, the default agent (isDefault=1 in the agents table)
//           runs with `enabled: true` + `every: DEFAULT_HEARTBEAT_EVERY`.
//           Non-default agents are disabled.
//   Rule 3: `heartbeat.defaults` merges under per-agent explicit config
//           (per-agent wins on conflicting keys).

import { DEFAULTS_KEY, agentKey, isHeartbeatEnabledForAgent, loadHeartbeatConfig } from './config';
import { DEFAULT_HEARTBEAT_EVERY } from './prompt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ── Minimal chrome.storage.local stub ──────────────
// Must be installed BEFORE importing `@extension/storage`, which builds
// liveUpdate listeners on chrome.storage.local.onChanged.
const chromeStore: Record<string, unknown> = {};
const chromeListeners = new Set<() => void>();
const installChromeStub = (): Record<string, unknown> => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string | string[] | Record<string, unknown> | null) => {
          if (key == null) return { ...chromeStore };
          if (typeof key === 'string') return { [key]: chromeStore[key] };
          if (Array.isArray(key)) {
            const out: Record<string, unknown> = {};
            for (const k of key) out[k] = chromeStore[k];
            return out;
          }
          return { ...key, ...chromeStore };
        },
        set: async (rec: Record<string, unknown>) => {
          Object.assign(chromeStore, rec);
        },
        remove: async (key: string) => {
          delete chromeStore[key];
        },
        clear: async () => {
          for (const k of Object.keys(chromeStore)) delete chromeStore[k];
        },
        onChanged: {
          addListener: (fn: () => void) => chromeListeners.add(fn),
          removeListener: (fn: () => void) => chromeListeners.delete(fn),
        },
      },
      session: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
  };
  return chromeStore;
};
installChromeStub();

describe('heartbeat config resolver', () => {
  const store = chromeStore;

  beforeEach(async () => {
    for (const k of Object.keys(store)) delete store[k];
    const { chatDb } = await import('@extension/storage');
    await chatDb.agents.clear();
  });

  afterEach(() => {
    for (const k of Object.keys(store)) delete store[k];
  });

  const putAgent = async (id: string, isDefault: boolean): Promise<void> => {
    const { chatDb } = await import('@extension/storage');
    await chatDb.agents.put({
      id,
      name: id,
      identity: '',
      model: undefined,
      toolConfig: {},
      customTools: [],
      isDefault: (isDefault ? 1 : 0) as unknown as boolean,
      createdAt: 0,
      updatedAt: 0,
    } as never);
  };

  it('rule 2: no explicit configs → default agent is enabled', async () => {
    await putAgent('main', true);
    await putAgent('other', false);

    expect(await isHeartbeatEnabledForAgent('main')).toBe(true);
    const cfg = await loadHeartbeatConfig('main');
    expect(cfg.enabled).toBe(true);
    expect(cfg.every).toBe(DEFAULT_HEARTBEAT_EVERY);
  });

  it('rule 2: no explicit configs → non-default agent is disabled', async () => {
    await putAgent('main', true);
    await putAgent('other', false);

    expect(await isHeartbeatEnabledForAgent('other')).toBe(false);
    const cfg = await loadHeartbeatConfig('other');
    expect(cfg.enabled).toBe(false);
  });

  it('rule 1: explicit config for non-default agent flips semantics to opt-in (default agent becomes disabled)', async () => {
    await putAgent('main', true);
    await putAgent('other', false);
    store[agentKey('other')] = { enabled: true };

    expect(await isHeartbeatEnabledForAgent('other')).toBe(true);
    expect(await isHeartbeatEnabledForAgent('main')).toBe(false);

    const mainCfg = await loadHeartbeatConfig('main');
    expect(mainCfg.enabled).toBe(false);

    const otherCfg = await loadHeartbeatConfig('other');
    expect(otherCfg.enabled).toBe(true);
  });

  it('rule 1: explicit disabled config counts as explicit (flips semantics)', async () => {
    await putAgent('main', true);
    await putAgent('other', false);
    // User explicitly opted default agent out
    store[agentKey('main')] = { enabled: false };

    expect(await isHeartbeatEnabledForAgent('main')).toBe(false);
    expect(await isHeartbeatEnabledForAgent('other')).toBe(false);
  });

  it('rule 3: heartbeat.defaults merges under explicit per-agent config; per-agent wins', async () => {
    await putAgent('main', true);
    store[DEFAULTS_KEY] = { every: '15m', ackMaxChars: 500, target: 'none' };
    store[agentKey('main')] = { enabled: true, every: '5m' };

    const cfg = await loadHeartbeatConfig('main');
    expect(cfg.enabled).toBe(true);
    // per-agent override wins on `every`
    expect(cfg.every).toBe('5m');
    // merged from defaults
    expect(cfg.ackMaxChars).toBe(500);
    expect(cfg.target).toBe('none');
  });

  it('rule 2 + defaults merge: default agent gets defaults merged in even without per-agent config', async () => {
    await putAgent('main', true);
    store[DEFAULTS_KEY] = { every: '10m' };

    const cfg = await loadHeartbeatConfig('main');
    expect(cfg.enabled).toBe(true);
    // defaults override built-in every
    expect(cfg.every).toBe('10m');
  });
});
