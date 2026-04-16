# R9: Scheduler & Cron — `chrome-extension/src/background/cron/`

## Scope
Persistent alarm-based task scheduling with one-shot (`at`), interval (`every`), and cron-expression (`cron`) schedule types. Tasks trigger LLM prompts or inject messages, with optional delivery to messaging channels.

## Key Files
| File/Package | Role |
|---|---|
| `chrome-extension/src/background/cron/` | Scheduler core — task management, alarm handling, execution |
| `packages/storage/` | IndexedDB tables: `scheduledTasks`, `taskRunLogs` |
| `chrome-extension/src/background/tools/` | `scheduler` tool (7 actions) |
| `packages/config-panels/` | Options → Control → Cron Jobs UI |

## Architecture
The scheduler uses Chrome Alarms API to wake the service worker at the next due time. Tasks are persisted in IndexedDB and survive browser restarts.

**Schedule types:**
- `at` — One-shot at ISO 8601 datetime or Unix ms. Auto-removed after execution.
- `every` — Recurring interval in milliseconds. Minimum 30s (Chrome alarms resolution). Optional start-time anchoring.
- `cron` — Standard 5-field cron expressions with optional timezone. Parsed via the `croner` library. Defaults to browser local timezone.

**Payload types:**
- `agentTurn` — Run the LLM agent with a prompt (full tool access, like a regular conversation turn).
- `chatInject` — Inject a message directly into a specific chat session.

**Delivery channels:**
- Chat — Results appear in the linked ChromeClaw chat.
- Telegram — Results sent to a specific Telegram chat.

**Execution flow:**
```
Chrome Alarm fires
  → Service worker wakes
  → Scheduler checks due tasks
  → Execute payload (agentTurn or chatInject)
  → Log result to taskRunLogs
  → Schedule next alarm
```

## Key Types/Interfaces
```typescript
// scheduledTasks table
interface ScheduledTask {
  id: string;
  schedule: { type: 'at'; time: string | number }
           | { type: 'every'; interval: number; startTime?: number }
           | { type: 'cron'; expression: string; timezone?: string };
  payload: { type: 'agentTurn'; prompt: string } | { type: 'chatInject'; chatId: string; message: string };
  delivery?: { channel: 'telegram'; chatId: string } | { channel: 'chat' };
  enabled: boolean;
  consecutiveErrors: number;
}

// taskRunLogs table
interface TaskRunLog {
  taskId: string;
  startedAt: number;
  endedAt: number;
  duration: number;
  status: 'success' | 'error';
  error?: string;
}
```

## Behavior
- **Scheduler tool** has 7 actions: `status`, `list`, `add`, `update`, `remove`, `run`, `runs`.
- `update` supports partial updates to existing tasks.
- `run` executes a task immediately regardless of schedule.
- `runs` shows execution history for a specific task.
- **Error handling**: Consecutive errors tracked per task. Tasks auto-disabled after too many consecutive failures.
- **Persistence**: All tasks and run logs survive browser restarts via IndexedDB.
- **Configuration**: Via scheduler tool (agent creates tasks through conversation) or Options page (Control → Cron Jobs).

## Dependencies
- Chrome Alarms API
- `croner` library (cron expression parsing)
- `packages/storage` (IndexedDB via Dexie.js)
- Background service worker (agent execution, channel delivery)

## Gate
`pnpm build && pnpm quality` — exit 0.
