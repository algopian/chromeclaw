---
summary: "Deep Research tool — multi-step autonomous research with parallel search, fetch, and synthesis phases."
read_when:
  - Using the deep research tool
  - Understanding how autonomous research works
  - Learning about the subagent system
title: "Deep Research"
---

# Deep Research

The `deep_research` tool conducts multi-step autonomous research on a topic. It runs in the background via a subagent, returning results as a system message when complete.

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `topic` | string | (required) | Research topic or question |
| `focusAreas` | string[] | — | Specific sub-questions to investigate |
| `saveToWorkspace` | boolean | `true` | Save the final report to a workspace file |

## How it works

1. **Returns immediately** — The tool confirms the research has started and the agent can continue the conversation
2. **Sub-question decomposition** — The research agent breaks the topic into focused sub-questions
3. **Multi-iteration search** — For each sub-question, performs web searches and fetches relevant pages
4. **Parallel execution** — Multiple searches run concurrently for speed
5. **Synthesis** — Findings are compiled into a structured markdown report
6. **Delivery** — The report appears as a system message in the chat

If `saveToWorkspace` is enabled, the report is also saved as a workspace file for future reference.

<Note>
Deep research is excluded from headless mode (cron jobs, channel messages) to prevent uncontrolled background research.
</Note>

## Subagent system

Deep research uses the subagent system, which is also available directly via three tools:

### spawn_subagent

Spawn a nested LLM call with its own tool set for complex sub-tasks.

| Parameter | Type | Description |
|-----------|------|-------------|
| `task` | string | (required) Self-contained task description |
| `tools` | string[] | Allowed tool names (optional, defaults to all) |

Returns immediately. Results appear as a system message. Maximum 3 concurrent subagents. Results expire after 30 minutes.

### list_subagents

List active and recent subagent runs with status, task, and duration.

### kill_subagent

Cancel a running subagent by its run ID.

## Progress tracking

Subagent progress is streamed to the UI via `SubagentProgressInfo` events:

- Run ID and task description
- Step count and individual step summaries
- Start time and duration
