## Phase NN: FEATURE_NAME (RNN)

**Goal**: One sentence describing the feature.

**Dependency**: Phase X (package-name), Phase Y (package-name).
<!-- The agent will not start this phase until listed dependencies are in the Completed section of ACTIVE_PHASES.md -->

**Requirement**: `.dev/requirements/rNN-SLUG.md`

### Tasks — Group A (parallel)
<!-- Tasks in this group run concurrently. Each must be independent — different files, no shared state. -->
<!-- Remove this group if all tasks must be sequential. -->

- [ ] **NN.1**: FIRST_INDEPENDENT_TASK
  - File: `packages/example/lib/component-a.ts`

- [ ] **NN.2**: SECOND_INDEPENDENT_TASK
  - File: `packages/example/lib/component-b.ts`

- [ ] **NN.3**: THIRD_INDEPENDENT_TASK
  - File: `packages/example/lib/component-c.ts`

### Tasks — Group B (sequential)
<!-- Tasks here run one at a time, after parallel group completes. -->

- [ ] **NN.4**: WIRE_COMPONENTS_TOGETHER
  - Depends on Group A outputs
  - File: `packages/example/lib/index.ts`

- [ ] **NN.5**: ADD_TESTS
  - `packages/example/tests/new.test.ts`

### Gate

- [ ] **NN.R**: Run full phase gate
  - `pnpm build && pnpm lint && pnpm type-check && pnpm test` — zero errors

- [ ] **NN.C**: Code review — review all changes in this phase
  - Check for SOLID violations, security risks, dead code
  - Verify error handling covers edge cases
  - Verify test coverage for new functionality

- [ ] **NN.F**: Fix all issues found in review
  - Re-run full gate until clean

- [ ] **NN.G**: Git commit — "feat: FEATURE_NAME"

**Gate**: `pnpm build && pnpm lint && pnpm type-check && pnpm test` — exit 0.
