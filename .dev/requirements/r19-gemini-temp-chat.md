# R19: Gemini Web Provider Temp Chat — `chrome-extension/src/background/web-providers/`

## Scope

Make the Gemini web provider default to "temp chat" mode so conversations are not saved to the user's Gemini history. ChromeClaw manages its own conversation state and does not reuse Gemini's server-side conversation IDs.

## Key Files

| File/Package | Role |
|---|---|
| `chrome-extension/src/background/web-providers/content-fetch-gemini.ts` | MAIN world fetch — builds the 69-element inner request array |
| `chrome-extension/src/background/web-providers/providers/gemini-web.ts` | Provider definition (buildRequest, parseSseDelta) |

## Background

The Gemini BardFrontendService `StreamGenerate` endpoint accepts a 69-element inner request array. Index 45 controls temp chat mode:

- `null` or `0` = normal chat (saved to user's Gemini history)
- `1` = temp chat (ephemeral, not saved server-side)

Reference: Analysis in `/mnt/c/Users/Huang/Downloads/gemini-temp-chat/COMPLETE-ANALYSIS.md` and `API-REFERENCE.md`.

## Change Required

In `content-fetch-gemini.ts`, the inner request array indices 42–52 are currently all `null`:

```js
/* [42-52] */  null, null, null, null, null, null, null, null, null, null, null,
```

Split this range to set index 45 to `1`:

```js
/* [42-44] */                        null, null, null,
/* [45] temp chat (1=ephemeral) */   1,
/* [46-52] */                        null, null, null, null, null, null, null,
```

No UI toggle needed — always use temp chat since ChromeClaw's `geminiToolStrategy` is stateless (no `extractConversationId`).

## Dependencies

None — self-contained change.

## Gate

`pnpm build && pnpm type-check` — exit 0.
