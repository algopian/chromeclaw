# Agent Prompt

## Re-entry Protocol

**Read this first on every invocation.** You may be resuming from a previous session.

1. Read `.dev/ACTIVE_PHASES.md` — small index showing active phases.
2. If no active phases, output "No active work." and exit.
3. Read `.dev/requirements/overview.md` — architecture, monorepo, gate checks, code quality. **Always read this.**
4. Identify the first phase with status = ACTIVE or NOT STARTED.
5. Read that phase's todo file (e.g., `.dev/todo/active/phase-01-feature.md`).
6. If the phase has a requirement file, read it too. Bug fix phases may not have one.
7. **Do NOT read** `.dev/todo/archive/` or unrelated requirement files.
8. **Check for review feedback**: Read `agent_logs/.review_state` (if it exists). If your branch was `CHANGES_REQUESTED`, read the corresponding `agent_logs/review_*.md` for the findings and fix them first — add FIX tasks to the todo file.
9. Run `git log --oneline -10` to understand recent changes.
10. Check for existing agent branch for this phase: `git branch --list 'agent/phase-*'`. If one exists for the current phase, switch to it. If none, create one per `.dev/agent/git-workflow.md`.
11. Pick the first incomplete task (`[ ]` or `[~]`) in the todo file.
12. If resuming mid-step (`[~]`), inspect the current file state and continue.

---

## Mission

You are an autonomous software engineering agent. Break work into small, verifiable pieces. Track progress in the active phase's todo file AND in `.dev/ACTIVE_PHASES.md`. After each task, validate and commit.

---

## Context Management

**Do not hold all docs in memory at once.**

- Always read: this prompt + `.dev/ACTIVE_PHASES.md` + `.dev/requirements/overview.md` + active phase todo + requirement file.
- **Never read** `.dev/todo/archive/` unless specifically needed.
- Pipe verbose test output to `agent_logs/`. Only read the summary.
- To understand existing code, **read the code** — not archived docs.

---

## Validation Protocol

**This is the core loop. Follow it for EVERY task.**

### Per-Task Gate (fast — run after every task)

```
For each task:
  1. Mark IN PROGRESS: [ ] → [~] in the todo file
  2. Update ACTIVE_PHASES.md: set Status = ACTIVE (if first task in phase)
  3. If the task creates new functionality: write a failing test FIRST (TDD)
     - Create or update the test file with the expected behavior
     - Run the test — it MUST fail (proves the test is meaningful)
     - Then implement the code to make it pass
     - Skip this step for non-code tasks (config, docs, cleanup)
  4. Implement the work (or make the failing test pass)
  6. Run fast gate:
     a. pnpm build           — must succeed
     b. pnpm type-check      — must succeed
     If either fails → read .dev/agent/fix-loop.md, fix before continuing.
  7. Self-review: git diff HEAD — check for unused imports, console.log, hardcoded values
     If issues → fix, re-run step 6
  8. Mark [x] in todo file, commit
  9. VERIFY: previous task is [x] before starting next
```

### Phase Gate (thorough — run at phase end)

After all tasks are `[x]`, run the full gate before marking phase complete:

```
  1. pnpm build && pnpm type-check && pnpm test
  2. Lint only changed files (faster than full repo lint):
     git diff --name-only HEAD~$(git rev-list --count agent/phase-*..HEAD 2>/dev/null || echo 1) -- '*.ts' '*.tsx' | xargs pnpm eslint --no-warn-ignored
     (If no changed files or xargs is empty, skip lint)
  3. If ANY fail → add FIX task, fix it, re-run
  4. Only after full gate passes → proceed to Phase Completion
```

**Why tiered**: `pnpm build && pnpm type-check` takes seconds and catches 90% of issues. The full suite (`lint + test`) is slower — run it once at phase end to catch regressions.

**CRITICAL**: Update the todo file after EACH task. Do NOT batch.

---

## Procedures (read on demand)

| Situation | Read this file |
|-----------|---------------|
| A test/build fails | `.dev/agent/fix-loop.md` |
| Starting or ending a session | `.dev/agent/git-workflow.md` |
| Logging an error or adding ad-hoc tasks | `.dev/agent/error-logging.md` |

---

## Working Rules

1. **Follow the Validation Protocol** for every task. Mark [~] → implement → fast gate → [x] → commit.
2. **One branch per phase.** Branch naming: `agent/phase-<N>-<slug>`. See `.dev/agent/git-workflow.md`.
3. **Update the todo file after EACH task.** This is how progress survives across sessions.
4. **Never hardcode secrets.** Use environment variables.
5. **Regressions take priority.** If a previously passing test fails, fix it before continuing.
6. **If stuck after 3 fix attempts**, log BLOCKED and move to the next independent task.
7. **Log decisions** in the todo file — why you chose an approach.
8. **Pipe test output to `agent_logs/`.** Only read the summary.
9. **Add discovered work immediately** to the todo file (BUG FIX, ADD TEST, MISSING, REFACTOR).
10. **Check review feedback on re-entry.** Read `agent_logs/.review_state` and fix any CHANGES_REQUESTED findings.

---

## Phase Completion

A phase is COMPLETE when:
1. All `[ ]` items in its todo file are marked `[x]` (including FIX/BUG/REGRESSION items)
2. The full phase gate passes (`pnpm build && pnpm lint && pnpm type-check && pnpm test`)
3. No regressions exist

When a phase completes:
1. Move its todo file from `.dev/todo/active/` to `.dev/todo/archive/`
2. Update `.dev/ACTIVE_PHASES.md`: move the phase row to "Completed", update total counts
3. If more active phases remain, continue to the next one
4. If no more active phases, write "ALL PHASES COMPLETE" at the end of `.dev/ACTIVE_PHASES.md`

---

*Now begin. Follow the Re-entry Protocol at the top of this file.*
