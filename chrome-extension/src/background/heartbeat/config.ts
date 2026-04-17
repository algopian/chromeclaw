// ── Config resolution ───────────────────────────
// Per-agent heartbeat config is stored in `chrome.storage.local` under
// `heartbeat.<agentId>`. Defaults live at `heartbeat.defaults`. Loading an
// unknown agent returns the defaults with `enabled: false` so the subsystem
// opts in explicitly.

import { DEFAULT_HEARTBEAT_EVERY, DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from './prompt';
import type { HeartbeatConfig } from './types';

const DEFAULTS_KEY = 'heartbeat.defaults';
const agentKey = (agentId: string): string => `heartbeat.${agentId}`;

const BUILT_IN_DEFAULTS: HeartbeatConfig = {
  enabled: false,
  every: DEFAULT_HEARTBEAT_EVERY,
  ackMaxChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  target: 'last',
};

const getLocal = async (key: string): Promise<Partial<HeartbeatConfig> | undefined> => {
  try {
    const record = await chrome.storage.local.get(key);
    const raw = record?.[key];
    if (raw && typeof raw === 'object') return raw as Partial<HeartbeatConfig>;
  } catch {
    /* storage unavailable (e.g. in tests) */
  }
  return undefined;
};

const setLocal = async (key: string, value: Partial<HeartbeatConfig>): Promise<void> => {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch {
    /* best-effort */
  }
};

/** Load the global defaults, merged on top of the built-ins. */
const loadHeartbeatDefaults = async (): Promise<HeartbeatConfig> => {
  const stored = await getLocal(DEFAULTS_KEY);
  return { ...BUILT_IN_DEFAULTS, ...(stored ?? {}) } as HeartbeatConfig;
};

/**
 * Load per-agent config; missing rows fall back to defaults. The returned
 * config is fully populated (never undefined `every` / `ackMaxChars`).
 */
const loadHeartbeatConfig = async (agentId: string): Promise<HeartbeatConfig> => {
  const defaults = await loadHeartbeatDefaults();
  const stored = await getLocal(agentKey(agentId));
  return { ...defaults, ...(stored ?? {}) } as HeartbeatConfig;
};

const saveHeartbeatConfig = async (agentId: string, cfg: Partial<HeartbeatConfig>): Promise<void> =>
  setLocal(agentKey(agentId), cfg);

const saveHeartbeatDefaults = async (cfg: Partial<HeartbeatConfig>): Promise<void> =>
  setLocal(DEFAULTS_KEY, cfg);

export {
  DEFAULTS_KEY,
  BUILT_IN_DEFAULTS,
  agentKey,
  loadHeartbeatConfig,
  loadHeartbeatDefaults,
  saveHeartbeatConfig,
  saveHeartbeatDefaults,
};
