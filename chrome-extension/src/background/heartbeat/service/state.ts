// ── Heartbeat service state + deps ──────────────
// In-memory structures owned by the singleton HeartbeatService.

import type { HeartbeatEvent, HeartbeatRunResult } from '../types';

/** Output of a single `runHeartbeatOnce` invocation. */
type RunOutcome = HeartbeatRunResult;

interface HeartbeatLogger {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
  trace?: (message: string, data?: unknown) => void;
}

/** Per-agent runtime state kept across ticks (durable data lives in Dexie). */
interface AgentState {
  agentId: string;
  /** Next scheduled tick wall-clock ms (alarm-driven). */
  nextDueMs: number;
  /** Last successful run (either `ran` or `skipped`). */
  lastRunMs: number;
  /** Millisecond interval derived from HeartbeatConfig.every. */
  intervalMs: number;
  /** True while `runHeartbeatOnce` is executing for this agent. */
  inFlight: boolean;
}

interface HeartbeatDeps {
  nowMs?: () => number;
  log: HeartbeatLogger;
  onEvent?: (event: HeartbeatEvent) => void;
}

interface HeartbeatDepsInternal extends HeartbeatDeps {
  nowMs: () => number;
}

interface HeartbeatServiceState {
  deps: HeartbeatDepsInternal;
  agents: Map<string, AgentState>;
  started: boolean;
  running: boolean;
}

const createInitialState = (deps: HeartbeatDeps): HeartbeatServiceState => ({
  deps: { ...deps, nowMs: deps.nowMs ?? (() => Date.now()) },
  agents: new Map(),
  started: false,
  running: false,
});

export { createInitialState };
export type {
  RunOutcome,
  HeartbeatLogger,
  AgentState,
  HeartbeatDeps,
  HeartbeatDepsInternal,
  HeartbeatServiceState,
};
