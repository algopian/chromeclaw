# ChromeClaw v1.9.4 Release Notes

## Browser Tool Reliability

- **CDP fallback to scripting API**: When Chrome's debugger (CDP) fails to attach or gets immediately detached — common on banking sites, GitHub, and other CDP-resistant pages — the browser tool now automatically falls back to the scripting-based implementation. Supports snapshot (with interactive refs), click, type, evaluate, and screenshot without CDP.
- **Debugger resilience**: Added connection verification via `Runtime.evaluate` ping before trusting stale sessions, detach-and-retry logic for stale debugger state, and auto-reattach on "not attached" errors.
- **Graceful snapshot fallback**: Pages that instantly detach the debugger no longer cause 6+ failed retries. The snapshot action falls back to content extraction in a single step.

## Web Provider Improvements

- **Per-provider stream adapter hooks**: Moved provider-specific post-parse behaviors from the shared bridge into individual `SseStreamAdapter` implementations, reducing blast radius so changes to one provider can't break others.
  - `suppressAfterToolCalls` — per-provider control over text/malformed suppression after tool calls
  - `onFinish` — per-provider finalization for thinking promotion, empty response detection, and error surfacing
- **Gemini adapter**: Promotes thinking-only responses to visible text. Detects and reports empty responses. Suppresses hallucinated content after tool calls.
- **Kimi adapter**: Detects `REASON_COMPLETION_OVERLOADED` server errors delivered via `block.exception` SSE events and surfaces them to the user instead of showing an empty response.
- **Gemini URL stripping**: Strips Gemini's auto-linkified markdown URLs (`[url](url)`) from tool call responses, preventing JSON corruption in `<tool_call>` bodies and fixing cumulative text delta issues.
- **Qwen native web_search**: Excluded `web_search` from Qwen's tool prompt and skipped native call interception, letting Qwen handle search server-side to avoid parameter format mismatches (`queries[]` vs `query`).

## Slash Commands

- **`/copy`**: Copy the last assistant message (or Nth message) to clipboard.
- **`/export`**: Export the current conversation as markdown.
- Slash commands now support argument parsing (e.g., `/copy 2`).

## Other

- Added Firefox Add-ons link to README.
- Added tool result preview logging for debugging.
- Improved browser tool logging throughout attach/detach/action flow.
