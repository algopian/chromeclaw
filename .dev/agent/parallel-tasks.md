# Parallel Task Groups

## How It Works

`run_parallel.sh` reads a phase todo file, identifies task groups marked `(parallel)`, and spawns concurrent Claude Code agents — each in its own git worktree with its own branch. After all parallel tasks complete, their branches are merged into the phase branch, then sequential tasks (gate, review, commit) run normally.

```
Phase todo file:
  Group A (parallel) → 3 agents run concurrently, each in own worktree
  Group B (sequential) → runs after Group A merges, one task at a time
  Gate → always sequential
```

## Task Group Syntax

Add `(parallel)` to a group heading to mark its tasks as parallelizable:

```markdown
### Tasks — Group A (parallel)

- [ ] **18.1**: Create ComponentX.tsx
  - File: `packages/chat-ui/lib/components/ComponentX.tsx`

- [ ] **18.2**: Create ComponentY.tsx
  - File: `packages/chat-ui/lib/components/ComponentY.tsx`

- [ ] **18.3**: Create ComponentZ.tsx
  - File: `packages/chat-ui/lib/components/ComponentZ.tsx`

### Tasks — Group B (sequential)

- [ ] **18.4**: Wire components into page
  - Depends on all components from Group A

- [ ] **18.5**: Integration tests

### Gate

- [ ] **18.R**: Run full phase gate
- [ ] **18.C**: Code review
- [ ] **18.F**: Fix all issues
- [ ] **18.G**: Git commit
```

## Rules for Parallel Tasks

1. **Tasks in a parallel group must be independent** — no task can depend on another task in the same group
2. **Each task should touch different files** — avoid two parallel tasks editing the same file (causes merge conflicts)
3. **Keep tasks small and focused** — one component, one module, one test file per task
4. **No shared state** — each agent runs in its own worktree with its own copy of the repo

## Good Candidates for Parallel Groups

- Creating independent UI components (each in its own file)
- Writing independent test files
- Implementing independent tool definitions
- Creating independent utility modules

## Bad Candidates (keep sequential)

- Tasks that modify the same file (e.g., "add export to index.ts" x3)
- Tasks where output of one feeds input of another
- Integration/wiring tasks that depend on multiple components
- Gate checks, code review, final commit

## How Agents Are Isolated

Each parallel agent gets:
- Its own git worktree: `/tmp/chromeclaw-worktrees/wt-<phase>-<task>/`
- Its own branch: `agent/<phase>-task-<id>`
- Its own Claude Code session
- A focused prompt with ONLY its task description

After completion, branches merge into the phase branch. If a merge conflict occurs, the runner tries auto-resolution. If that fails, it logs a warning for manual resolution.

## Running

```bash
# Auto-detect active phase
.dev/run_parallel.sh

# Explicit phase file
.dev/run_parallel.sh .dev/todo/active/phase-18-feature.md

# Control concurrency
MAX_PARALLEL=5 .dev/run_parallel.sh

# Use with pipeline (review after parallel work)
PARALLEL=1 .dev/run_pipeline.sh
```
