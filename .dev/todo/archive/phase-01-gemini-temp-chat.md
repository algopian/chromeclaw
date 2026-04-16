## Phase 01: Gemini Web Provider Temp Chat (R19)

**Goal**: Make the Gemini web provider default to temp chat mode so conversations are not saved to the user's Gemini history.

**Dependency**: None.

**Requirement**: `.dev/requirements/r19-gemini-temp-chat.md`

### Tasks (sequential)

- [x] **01.1**: Set temp chat flag in Gemini inner request array
  - File: `chrome-extension/src/background/web-providers/content-fetch-gemini.ts`
  - Split indices 42–52 null range to set index 45 to `1`

### Gate

- [x] **01.R**: Run full phase gate — build ✓, type-check ✓, 3195 tests pass ✓, lint ✓

- [x] **01.C**: Code review — change is minimal and correct, no issues

- [x] **01.F**: Fix all issues found in review — no issues found, skipped

- [x] **01.G**: Git commit — "feat: gemini web provider default to temp chat"

**Gate**: `pnpm build && pnpm lint && pnpm type-check && pnpm test` — exit 0.
