// ── Types used across the heartbeat subsystem ────
// Plain-object schemas. Kept separate so cycles between prompt / config /
// service modules remain impossible.

interface HeartbeatActiveHoursConfig {
  start: string; // "HH:MM" 24-hour
  end: string; // "HH:MM" 24-hour (24:00 allowed)
  /** IANA zone, "user" / "local", or undefined for host zone. */
  timezone?: string;
}

interface HeartbeatVisibilityConfig {
  showOk?: boolean;
  showAlerts?: boolean;
  useIndicator?: boolean;
}

/**
 * Per-agent heartbeat config persisted in `chrome.storage.local` under
 * `heartbeat.<agentId>`. Global defaults live at `heartbeat.defaults`.
 */
interface HeartbeatConfig {
  enabled: boolean;
  /** Duration string, e.g. "30m", "1h". Defaults to DEFAULT_HEARTBEAT_EVERY. */
  every: string;
  /** Per-agent model override — model id or name. */
  model?: string;
  /** Overrides the default heartbeat prompt. */
  prompt?: string;
  /** Max chars that still count as an ack ("HEARTBEAT_OK + note"). */
  ackMaxChars?: number;
  /** 'last' = latest active channel; 'none' = suppress delivery; channel id otherwise. */
  target?: 'last' | 'none' | string;
  /** Recipient / chat id inside the channel. */
  to?: string;
  activeHours?: HeartbeatActiveHoursConfig;
  /** If true, skip heavy workspace context when prompting. */
  lightContext?: boolean;
  /** If true, request model reasoning. */
  includeReasoning?: boolean;
  visibility?: HeartbeatVisibilityConfig;
}

/** Normalized classification of why a tick is firing. */
type HeartbeatReason =
  | 'interval'
  | 'manual'
  | 'retry'
  | 'exec-event'
  | 'wake'
  | 'other'
  | `cron:${string}`;

type HeartbeatTriggerKind =
  | 'interval'
  | 'manual'
  | 'retry'
  | 'exec-event'
  | 'wake'
  | 'cron'
  | 'other';

interface HeartbeatTrigger {
  kind: HeartbeatTriggerKind | string;
  /** Optional descriptor (e.g. cron job id) appended after ':' in the reason. */
  detail?: string;
  /** Arbitrary metadata; ignored for routing but carried in events. */
  meta?: Record<string, unknown>;
}

type HeartbeatRunStatus = 'ran' | 'skipped' | 'failed';

interface HeartbeatRunResult {
  status: HeartbeatRunStatus;
  reason?: string;
  chatId?: string;
  durationMs?: number;
}

interface HeartbeatEvent {
  agentId: string;
  /** Monotonic timestamp. */
  atMs: number;
  /** Normalized classification. */
  reason: HeartbeatReason;
  status: HeartbeatRunStatus | 'requested' | 'started';
  chatId?: string;
  error?: string;
  durationMs?: number;
  /** Short, user-presentable description of the outcome. */
  summary?: string;
}

export type {
  HeartbeatActiveHoursConfig,
  HeartbeatVisibilityConfig,
  HeartbeatConfig,
  HeartbeatReason,
  HeartbeatTriggerKind,
  HeartbeatTrigger,
  HeartbeatRunStatus,
  HeartbeatRunResult,
  HeartbeatEvent,
};
