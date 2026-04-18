# Agent Development Workflow

Autonomous agent framework for building and maintaining the ChromeClaw extension. Two agents — a **coding agent** and a **review agent** — work in a loop driven by task files and requirement specs.

## Overview

```
You (human)                      Coding Agent                    Review Agent
    |                                 |                               |
    |-- 1. Write tasks + specs        |                               |
    |-- 2. .dev/run_agent.sh -------->|                               |
    |                                 |-- reads ACTIVE_PHASES.md      |
    |                                 |-- reads overview.md           |
    |                                 |-- reads active todo file      |
    |                                 |-- implements tasks             |
    |                                 |-- runs gate checks            |
    |                                 |-- marks [x] in todo           |
    |                                 |-- commits to agent/* branch   |
    |                                 |-- archives phase when done    |
    |                                 |-- stops                       |
    |                                 |                               |
    |-- 3. Review (optional) ---------|------------------------------>|
    |                                 |                   |-- finds agent/* branch
    |                                 |                   |-- reviews diff
    |                                 |                   |-- runs quality gate
    |                                 |                   |-- merges or rejects
    |                                 |                               |
    |-- 4. Check results, repeat      |                               |
```

## Directory Structure

```
.dev/
  README.md                         # This file
  ACTIVE_PHASES.md                  # Index of active work (agent reads first)
  AGENT_PROMPT.md                   # Coding agent instructions
  CODE_REVIEW_AGENT_PROMPT.md       # Review agent instructions
  run_agent.sh                      # Coding agent runner loop
  run_pipeline.sh                   # Full pipeline: code → review → fix loop
  run_parallel.sh                   # Parallel agent runner (concurrent worktrees)
  agent/                            # Agent procedure files (read on demand)
    fix-loop.md                     #   When tests fail
    git-workflow.md                 #   Branch lifecycle
    error-logging.md                #   Error conventions + ad-hoc task creation
    parallel-tasks.md               #   Parallel task execution rules
  hooks/                            # Shell hook scripts
    format-stream.sh                #   Format Claude stream output
    log-session.sh                  #   Log session start/end
    log-stop.sh                     #   Log stop events
    log-tool.sh                     #   Log tool usage
  requirements/                     # Requirement specs (existing implementation)
    overview.md                     #   Architecture, monorepo, gate checks
    r1-*.md ... r18-*.md            #   Individual requirement specs
  todo/
    active/                         # Task files for in-progress phases
      _TEMPLATE-bugs.md             #   Template for bug fix phases
      _TEMPLATE-feature.md          #   Template for feature phases
    archive/                        # Completed phases (never read by agent)
```

## Setup

Prerequisites:
- Claude Code CLI (`claude`) installed and in PATH
- Node.js 22.15+, pnpm 10.11+

No additional setup needed. The framework is file-driven.

## How to Add a Bug Fix

1. Copy the template:
   ```bash
   cp .dev/todo/active/_TEMPLATE-bugs.md .dev/todo/active/phase-01-my-bug.md
   ```

2. Edit the file — replace placeholders (`NN`, `SHORT_DESCRIPTION`, etc.) with real content.

3. Update the index (`.dev/ACTIVE_PHASES.md`):
   ```markdown
   ## Currently Active

   | Phase | Status | Todo File | Requirement File | Tasks | Done |
   |-------|--------|-----------|------------------|-------|------|
   | 1 | NOT STARTED | todo/active/phase-01-my-bug.md | _(bug fix, no separate spec)_ | 6 | 0 |
   ```

4. Run:
   ```bash
   .dev/run_agent.sh
   ```

## How to Add a New Feature

1. Write the spec — create `.dev/requirements/r19-my-feature.md`.

2. Copy the template and fill it in:
   ```bash
   cp .dev/todo/active/_TEMPLATE-feature.md .dev/todo/active/phase-01-my-feature.md
   ```

3. Update `.dev/ACTIVE_PHASES.md`.

4. Run:
   ```bash
   .dev/run_agent.sh
   ```

## How to Queue Multiple Phases

Add multiple rows to `.dev/ACTIVE_PHASES.md`. The agent processes them top to bottom.

## How to Run the Full Pipeline (Recommended)

```bash
.dev/run_pipeline.sh
```

Flow:
1. Coding agent implements tasks, commits to `agent/phase-<N>-*` branch
2. Review agent reviews the diff, runs quality gate
3. If approved → merges branch
4. If rejected → writes findings, coding agent reads feedback and fixes
5. Repeats up to `MAX_CYCLES` (default 3)

Configuration:
```bash
MAX_CYCLES=5 .dev/run_pipeline.sh
AGENT_MAX_ITERATIONS=20 .dev/run_pipeline.sh
NOTIFY_WEBHOOK=https://hooks.slack.com/services/... .dev/run_pipeline.sh
PARALLEL=1 .dev/run_pipeline.sh
```

## Runner Configuration

### run_agent.sh

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_ITERATIONS` | 100 | Max loop iterations before stopping |
| `COOLDOWN` | 2 | Seconds between iterations |
| `MAX_CONSECUTIVE_FAILURES` | 5 | Stop after N consecutive failures |
| `RAW_OUTPUT` | 0 | Set to 1 for raw JSON output |

### run_pipeline.sh

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CYCLES` | 3 | Max code→review→fix cycles |
| `AGENT_MAX_ITERATIONS` | 10 | Cap iterations per coding agent run |
| `REVIEW_MODEL` | `claude-opus-4-7` | Model for review agent |
| `NOTIFY_WEBHOOK` | _(empty)_ | Slack/Discord webhook URL |
| `PARALLEL` | 0 | Set to 1 to use parallel mode |

### run_parallel.sh

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_PARALLEL` | 3 | Max concurrent agents |
| `AGENT_MODEL` | `claude-opus-4-7` | Model for parallel coding agents |

## Progress Tracking

| Marker | Meaning |
|--------|---------|
| `- [ ]` | Not started |
| `- [~]` | In progress |
| `- [x]` | Complete |

## Validation Protocol (Tiered Gates)

| Gate | When | Commands | Time |
|------|------|----------|------|
| **TDD** | Before implementing new functionality | Write failing test first | varies |
| **Fast gate** | After every task | `pnpm build && pnpm type-check` | ~10-30s |
| **Full gate** | At phase end | `pnpm build && pnpm lint && pnpm type-check && pnpm test` | ~2-5 min |

## Branching Model

One branch per phase: `agent/phase-<N>-<slug>`.

## Parallel Execution

Mark tasks as parallelizable in the todo file with `(parallel)` in the group heading. See `.dev/agent/parallel-tasks.md`.

## Logs

All agent output goes to `agent_logs/`:

| File | Contents |
|------|----------|
| `agent_logs/agent_<commit>_<timestamp>.log` | Raw JSON output |
| `agent_logs/run_summary.log` | One-line entries per iteration |
| `agent_logs/.review_state` | Review agent decisions |
| `agent_logs/review_<branch>.md` | Detailed review reports |
| `agent_logs/pipeline_summary.log` | Pipeline cycle summaries |

## Phase Lifecycle

```
1. Create todo file in .dev/todo/active/
2. Add to .dev/ACTIVE_PHASES.md
3. Agent works on it (marks [ ] → [~] → [x])
4. Agent runs gate check
5. Agent commits
6. When all tasks [x]: agent moves todo to .dev/todo/archive/
7. Agent updates ACTIVE_PHASES.md
8. If no more active phases: writes "ALL PHASES COMPLETE", runner stops
```
