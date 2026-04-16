# Error Logging Convention

When you encounter an error, log it in the active phase's todo file as:

```
ERROR: [step number] [brief description] — [root cause]
```

When you resolve it:

```
RESOLVED: [step number] [what fixed it]
```

This makes it easy to grep for issues across sessions.

## Automatic TODO Generation

When you discover work that isn't in the todo file, **add it immediately**:

- Found a bug during testing? Add: `- [ ] BUG FIX: [description]`
- Need a missing test? Add: `- [ ] ADD TEST: [what to test]`
- Discovered a missing requirement? Add: `- [ ] MISSING: [requirement description]`
- Need to refactor to unblock progress? Add: `- [ ] REFACTOR: [what and why]`

Add new items BEFORE the gate check tasks so they get done in order.
