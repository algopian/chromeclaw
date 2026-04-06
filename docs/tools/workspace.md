---
summary: "Workspace tools — read, write, edit, list, delete, and rename workspace files; scheduler and agents list tools."
read_when:
  - Managing workspace files via tools
  - Understanding workspace file operations
  - Using the scheduler tool
title: "Workspace & Utility Tools"
---

# Workspace & Utility Tools

Six tools for managing workspace files, plus the scheduler and agents list tools.

## Workspace file tools

### write

Create or update a workspace file.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | (required) File path |
| `content` | string | (required) File content |
| `mode` | string | `overwrite` (default) or `append` |

### read

Read a workspace file's content.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | (required) File path |

### edit

Find-and-replace within a workspace file. The `oldText` must match exactly one location in the file.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | (required) File path |
| `oldText` | string | (required) Text to find (must be unique) |
| `newText` | string | (required) Replacement text |

Returns an error if the `oldText` is not found or matches multiple locations.

### list

List all workspace files with name, owner (agent), and enabled status. No parameters.

### delete

Delete a workspace file.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | (required) File path |

<Warning>
Predefined files (AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md, MEMORY.md) cannot be deleted.
</Warning>

### rename

Rename a workspace file.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | (required) Current file path |
| `newPath` | string | (required) New file path |

---

## Scheduler tool

Create and manage scheduled tasks. See [Scheduler](/automation/scheduler) for full details.

| Action | Description |
|--------|-------------|
| `status` | Check scheduler status |
| `list` | List all tasks |
| `add` | Create a new task |
| `update` | Update a task |
| `remove` | Delete a task |
| `run` | Execute a task immediately |
| `runs` | View task run history |

---

## Agents list tool

List available agents with ID, name, emoji, default status, and active status.

```json
{
  "agentCount": 3,
  "activeAgentId": "default",
  "agents": [
    { "id": "default", "name": "Assistant", "emoji": "🤖", "isDefault": true, "isActive": true },
    { "id": "researcher", "name": "Researcher", "emoji": "🔬", "isDefault": false, "isActive": false }
  ]
}
```

<Note>
The scheduler and agents list tools are excluded from headless mode (cron jobs, channel messages).
</Note>
