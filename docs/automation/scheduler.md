---
summary: "Scheduler — alarm-based task scheduling with one-shot, interval, and cron-expression modes."
read_when:
  - Setting up scheduled tasks
  - Understanding cron expressions in ChromeClaw
  - Configuring recurring automations
title: "Scheduler"
---

# Scheduler

ChromeClaw includes an alarm-based scheduler for running tasks on a schedule. Tasks can trigger LLM prompts, inject messages into chats, and deliver results to messaging channels.

## Schedule types

| Type | Description | Example |
|------|-------------|---------|
| `at` | One-shot at a specific time | `"2024-03-15T09:00:00Z"` |
| `every` | Recurring interval | `60000` (every 60 seconds) |
| `cron` | Cron expression with timezone | `"0 9 * * 1-5"` (weekdays at 9am) |

### One-shot (`at`)

Run once at a specific datetime (ISO 8601 or Unix milliseconds). The task is automatically removed after execution.

### Interval (`every`)

Run repeatedly at a fixed interval in milliseconds. Minimum interval is 30 seconds (Chrome alarms API resolution). Supports optional anchoring to a start time.

### Cron expressions (`cron`)

Standard 5-field cron expressions with optional timezone:

```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-7, Sun=0 or 7)
│ │ │ │ │
* * * * *
```

Timezone defaults to the browser's local timezone. Uses the `croner` library for parsing and scheduling.

## Payload types

### agentTurn

Run the LLM agent with a prompt. The agent processes the prompt using the configured model and tools, just like a regular conversation turn.

### chatInject

Inject a message into a specific chat session.

## Delivery channels

Task results can be delivered to messaging channels:

- **Telegram** — Send results to a specific Telegram chat
- **Chat** — Results appear in the linked ChromeClaw chat

## Using the scheduler tool

The `scheduler` tool has these actions:

| Action | Description |
|--------|-------------|
| `status` | Check scheduler status (running/stopped) |
| `list` | List all scheduled tasks |
| `add` | Create a new task |
| `update` | Modify a task (partial updates) |
| `remove` | Delete a task |
| `run` | Execute a task immediately |
| `runs` | View execution history for a task |

### Example: Daily briefing

```
Create a scheduled task that runs every weekday at 9am:
- Search my Gmail for unread messages
- Check my calendar for today's events
- Send a summary to my Telegram
```

The agent will use the scheduler tool to create a cron task with the appropriate schedule and prompt.

## Persistence

Tasks are stored in IndexedDB (`scheduledTasks` table) and survive browser restarts. The scheduler uses Chrome alarms API to wake the service worker at the next due time.

Execution history is stored in the `taskRunLogs` table with:

- Task ID
- Start/end timestamps
- Duration
- Status (success/error)
- Error message (if failed)

## Error handling

- Consecutive errors are tracked per task
- Tasks are automatically disabled after too many consecutive failures
- Error details are logged in the run history

## Configuration

Tasks can be configured via:

- **Scheduler tool** — The agent creates and manages tasks through conversation
- **Options page** — View and manage tasks under **Control** → **Cron Jobs**
