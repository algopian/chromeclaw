// ── Log Levels ──────────────────────────────────

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;

type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

// ── Log Categories ──────────────────────────────

type LogCategory =
  | 'tool'
  | 'stream'
  | 'agent'
  | 'auth'
  | 'storage'
  | 'general'
  | 'channel'
  | 'channel-init'
  | 'channel-bridge'
  | 'channel-poller'
  | 'channel-cmd'
  | 'offscreen-mgr'
  | 'media'
  | 'journal'
  | 'cron'
  | 'tts'
  | 'local-llm'
  | 'embedding'
  | 'memory-sync'
  | 'wa-adapter'
  | 'channel-sw'
  | 'slash-cmd'
  | 'web-auth'
  | 'web-llm';

// ── Log Entry ───────────────────────────────────

interface LogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: unknown;
}

// ── Log Config ──────────────────────────────────

interface LogConfig {
  enabled: boolean;
  level: LogLevel;
}

// ── Formatting Utilities ────────────────────────

const padTime = (n: number, len: number): string => String(n).padStart(len, '0');

const formatTimestamp = (ts: number): string => {
  const d = new Date(ts);
  return `${padTime(d.getHours(), 2)}:${padTime(d.getMinutes(), 2)}:${padTime(d.getSeconds(), 2)}.${padTime(d.getMilliseconds(), 3)}`;
};

const formatLogEntry = (entry: LogEntry): string => {
  const ts = formatTimestamp(entry.timestamp);
  const base = `${ts} [${entry.level.toUpperCase()}] [${entry.category}] ${entry.message}`;
  if (entry.data !== undefined) {
    try {
      return `${base} ${JSON.stringify(entry.data)}`;
    } catch {
      return `${base} [unserializable data]`;
    }
  }
  return base;
};

const formatLogsForExport = (entries: LogEntry[], format: 'text' | 'json'): string => {
  if (format === 'json') {
    return JSON.stringify(entries, null, 2);
  }
  return entries.map(formatLogEntry).join('\n');
};

export { LOG_LEVELS, LOG_LEVEL_PRIORITY, formatLogEntry, formatLogsForExport, formatTimestamp };
export type { LogLevel, LogCategory, LogEntry, LogConfig };
