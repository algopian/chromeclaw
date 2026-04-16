# Fix Loop Procedure

When a validation fails:

```
  1. Log in the active phase's todo file:
     ERROR: [step] [test name] — [failure message]
  2. Add a FIX task to the todo file:
     - [ ] FIX [step]: [what needs fixing based on the failure]
  3. Read ONLY the failing test output (not the full log) to understand the failure
  4. Implement the fix
  5. Re-run the validation command
  6. If PASS → mark the FIX task [x], log RESOLVED, continue
  7. If FAIL again → repeat from step 1 (max 3 attempts per failure)
  8. After 3 failed attempts on the SAME issue:
     a. Log: BLOCKED: [step] [description] — tried [approach1], [approach2], [approach3]
     b. Move to the next INDEPENDENT step (one not blocked by this failure)
     c. Do NOT skip dependent steps — mark them BLOCKED too
```

## Regression Detection

Before starting any work in a phase, capture the baseline:

```bash
pnpm test 2>&1 | tail -20 > agent_logs/baseline-tests.log
```

After ANY code change, compare:

1. Run `pnpm test` and check for new failures.
2. If a test that passed in baseline now fails, this is a **regression**. Do NOT continue.
3. Add to the todo file:
   ```
   - [ ] REGRESSION FIX: [test_file::test_name] was passing, now fails after changes to [file you changed]
   ```
4. Fix the regression BEFORE continuing.
5. Regressions take priority over new work.
