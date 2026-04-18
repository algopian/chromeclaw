// ── Config resolution ───────────────────────────
// Per-agent heartbeat config is stored in `chrome.storage.local` under
// `heartbeat.<agentId>`. Defaults live at `heartbeat.defaults`.
//
// Enablement follows OpenClaw's two-rule resolver (see
// `/src/infra/heartbeat-runner.ts isHeartbeatEnabledForAgent`):
//
//   Rule 1 — Explicit opt-in mode: if ANY agent has a `heartbeat.<id>`
//            entry in chrome.storage.local (whether enabled: true or false),
//            semantics flip to opt-in. Only agents whose explicit config has
//            `enabled: true` run; all other agents — including the default
//            one — are disabled.
//   Rule 2 — Implicit default mode: when no explicit per-agent configs
//            exist, the agent flagged as `isDefault=1` in the agents table
//            runs with `enabled: true` + DEFAULT_HEARTBEAT_EVERY. Non-default
//            agents stay disabled.
//
// `heartbeat.defaults` merges beneath explicit per-agent config; per-agent
// keys win on conflict.

import { DEFAULT_HEARTBEAT_EVERY, DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from './prompt';
import { getDefaultAgent, getAgent, listAgents } from '@extension/storage';
import type { HeartbeatConfig } from './types';

const DEFAULTS_KEY = 'heartbeat.defaults';
const AGENT_KEY_PREFIX = 'heartbeat.';
const agentKey = (agentId: string): string => `${AGENT_KEY_PREFIX}${agentId}`;

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

/** Return every `heartbeat.<agentId>` entry currently in local storage. */
const getExplicitAgentConfigs = async (): Promise<Record<string, Partial<HeartbeatConfig>>> => {
  try {
    const record = await chrome.storage.local.get(null as unknown as string);
    const out: Record<string, Partial<HeartbeatConfig>> = {};
    if (record && typeof record === 'object') {
      for (const [key, value] of Object.entries(record)) {
        if (!key.startsWith(AGENT_KEY_PREFIX)) continue;
        if (key === DEFAULTS_KEY) continue;
        if (value && typeof value === 'object') {
          out[key.slice(AGENT_KEY_PREFIX.length)] = value as Partial<HeartbeatConfig>;
        }
      }
    }
    return out;
  } catch {
    return {};
  }
};

const resolveDefaultAgentId = async (): Promise<string | undefined> => {
  try {
    // Primary: look for agent with isDefault flag
    const agent = await getDefaultAgent();
    if (agent) return agent.id;
    // Fallback: if no agent has isDefault set (stale DB), try 'main' or first agent
    const main = await getAgent('main');
    if (main) return main.id;
    const all = await listAgents();
    return all[0]?.id;
  } catch {
    return undefined;
  }
};

/** Load the global defaults, merged on top of the built-ins. */
const loadHeartbeatDefaults = async (): Promise<HeartbeatConfig> => {
  const stored = await getLocal(DEFAULTS_KEY);
  return { ...BUILT_IN_DEFAULTS, ...(stored ?? {}) } as HeartbeatConfig;
};

/**
 * Return true when the heartbeat should run for this agent, following the
 * two-rule resolver documented at the top of this file.
 */
const isHeartbeatEnabledForAgent = async (agentId: string): Promise<boolean> => {
  const explicit = await getExplicitAgentConfigs();
  const explicitIds = Object.keys(explicit);
  if (explicitIds.length > 0) {
    // Rule 1: opt-in mode — only enabled if this agent has an explicit entry
    // whose `enabled` is truthy.
    const entry = explicit[agentId];
    return Boolean(entry && entry.enabled === true);
  }
  // Rule 2: implicit mode — only the default agent runs (with fallback).
  const defaultAgentId = await resolveDefaultAgentId();
  return defaultAgentId !== undefined && defaultAgentId === agentId;
};

/**
 * Load per-agent config, merging `heartbeat.defaults` under explicit per-agent
 * overrides. `enabled` is resolved through {@link isHeartbeatEnabledForAgent}
 * so the default agent gets `enabled: true` out of the box while non-default
 * agents stay off unless they opt in.
 */
const loadHeartbeatConfig = async (agentId: string): Promise<HeartbeatConfig> => {
  const [defaults, explicit] = await Promise.all([
    loadHeartbeatDefaults(),
    getExplicitAgentConfigs(),
  ]);
  const stored = explicit[agentId];
  const merged = { ...defaults, ...(stored ?? {}) } as HeartbeatConfig;
  const explicitIds = Object.keys(explicit);
  let resolvedDefaultId: string | undefined;
  if (explicitIds.length > 0) {
    merged.enabled = Boolean(stored && stored.enabled === true);
  } else {
    resolvedDefaultId = await resolveDefaultAgentId();
    merged.enabled = resolvedDefaultId === agentId;
  }
  return merged;
};

const saveHeartbeatConfig = async (agentId: string, cfg: Partial<HeartbeatConfig>): Promise<void> =>
  setLocal(agentKey(agentId), cfg);

const saveHeartbeatDefaults = async (cfg: Partial<HeartbeatConfig>): Promise<void> =>
  setLocal(DEFAULTS_KEY, cfg);

export {
  DEFAULTS_KEY,
  BUILT_IN_DEFAULTS,
  agentKey,
  isHeartbeatEnabledForAgent,
  loadHeartbeatConfig,
  loadHeartbeatDefaults,
  saveHeartbeatConfig,
  saveHeartbeatDefaults,
};
