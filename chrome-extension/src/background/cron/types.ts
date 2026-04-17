// ── Scheduled Task Types ─────────────────────

export type TaskSchedule =
  | { kind: 'at'; atMs: number }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

export type TaskPayload =
  | {
      kind: 'agentTurn';
      message: string;
      model?: string;
      timeoutMs?: number;
      /**
       * When 'heartbeat', the cron executor routes this tick through the
       * heartbeat subsystem (skip/dedup/prune/deliver pipeline) instead of
       * running a fresh headless LLM turn. `message` is ignored in that mode.
       */
      wakeMode?: 'heartbeat';
      agentId?: string;
      sessionKey?: string;
    }
  | { kind: 'chatInject'; chatId: string; message: string };

export type TaskPayloadPatch =
  | {
      kind: 'agentTurn';
      message?: string;
      model?: string;
      timeoutMs?: number;
      wakeMode?: 'heartbeat';
      agentId?: string;
      sessionKey?: string;
    }
  | { kind: 'chatInject'; chatId?: string; message?: string };

export type TaskDelivery = {
  channel: string;
  to: string;
  bestEffort?: boolean;
};

export type TaskState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
};

export type ScheduledTask = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  timeoutMs?: number;
  delivery?: TaskDelivery;
  createdAt: number;
  updatedAt: number;
  schedule: TaskSchedule;
  payload: TaskPayload;
  state: TaskState;
};

export type ScheduledTaskCreate = Omit<
  ScheduledTask,
  'id' | 'createdAt' | 'updatedAt' | 'state'
> & {
  state?: Partial<TaskState>;
};

export type ScheduledTaskPatch = Partial<
  Omit<ScheduledTask, 'id' | 'createdAt' | 'state' | 'payload'>
> & {
  payload?: TaskPayloadPatch;
  state?: Partial<TaskState>;
};
