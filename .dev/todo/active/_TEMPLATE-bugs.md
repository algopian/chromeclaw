## Phase NN: Bug Fixes — BATCH_NAME

**Goal**: Fix reported bugs from CONTEXT.

**Dependency**: None (or list phases that must be complete first).

### Tasks

- [ ] **NN.1**: BUG FIX: SHORT_DESCRIPTION
  - **Severity**: Critical | High | Medium | Low
  - **Repro**: Steps to reproduce the bug
  - **Expected**: What should happen
  - **Actual**: What happens instead
  - **Files**: `packages/example/lib/file.ts`, `pages/side-panel/src/Component.tsx`

- [ ] **NN.2**: BUG FIX: SHORT_DESCRIPTION
  - **Severity**: Critical | High | Medium | Low
  - **Repro**: Steps to reproduce
  - **Expected**: Expected behavior
  - **Actual**: Actual behavior
  - **Files**: `packages/example/lib/file.ts`

- [ ] **NN.T**: Add regression tests for fixed bugs
  - Test file + test cases for each bug fix above

- [ ] **NN.R**: Run full phase gate
  - `pnpm build && pnpm lint && pnpm type-check && pnpm test` — zero errors

- [ ] **NN.C**: Code review — review all bug fix changes
  - Verify root cause is actually addressed (not just symptoms)
  - Check that fix doesn't introduce new edge cases
  - Verify test coverage for each fixed bug

- [ ] **NN.F**: Fix all issues found in review
  - Re-run full gate until clean

- [ ] **NN.G**: Git commit — "fix: BATCH_NAME"

**Gate**: `pnpm build && pnpm lint && pnpm type-check && pnpm test` — exit 0.
