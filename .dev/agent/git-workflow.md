# Git Branching Workflow

**One branch per phase.** Each phase gets its own feature branch. Never commit directly to `main` or `master`.

## Branch lifecycle

1. **At session start**, check for an existing branch for the current phase:
   ```bash
   git branch --list 'agent/phase-<N>-*'
   ```
   If one exists, switch to it and continue. If none, create one:
   ```
   git checkout -b agent/phase-<N>-<slug>
   ```
   Examples: `agent/phase-17-workspace-paths`, `agent/phase-18-cli-feature`.

2. **All tasks for that phase** are committed to this branch. Commit incrementally after each task (per the Validation Protocol).

3. **On phase completion** (all tasks done, full gate passes):
   a. Write a **human-readable summary** as the final commit message:
      ```
      <type>: <short summary (imperative, <=72 chars)>

      <Why this change was made.>

      <What changed — bullet list.>

      <How it was verified — which tests/gates passed.>
      ```
      Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.
   b. The branch is now **ready for review**. Do NOT merge or push automatically.

4. **If multiple phases are queued**, create a NEW branch for each phase:
   - Finish phase 17 on `agent/phase-17-workspace-paths` → leave for review
   - Start phase 18 on `agent/phase-18-new-feature` (branched from current main/HEAD)

5. **Do NOT switch back to `main` between tasks within a phase.** Stay on the phase branch.

6. **If the review agent rejected your branch** (CHANGES_REQUESTED in `.review_state`):
   - Switch back to the rejected branch
   - Read `agent_logs/review_*.md` for findings
   - Fix issues, commit, leave for re-review

## Why one branch per phase

- Review agent can merge/reject individual phases independently
- If phase 17 is rejected, phase 18 can still be merged
- Cleaner git history — each branch is a logical unit
- Easier to revert a single phase without affecting others
