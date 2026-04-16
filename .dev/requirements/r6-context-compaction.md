# R6: Context Compaction — `chrome-extension/src/background/context/`

## Scope
Adaptive context compaction handling token limits via sliding-window, LLM-powered summarization, and multi-part strategies. Includes token estimation, tool result truncation, and retry mechanism.

## Key Files
| File/Package | Role |
|---|---|
| `chrome-extension/src/background/context/` | System prompt assembly, context compaction logic |
| `chrome-extension/src/background/llm-stream.ts` | Retry mechanism on context overflow |
| `packages/storage/` | Conversation history in IndexedDB |

## Architecture
**Context assembly pipeline** (per LLM call):
1. Load conversation history from IndexedDB
2. Load workspace files for active agent
3. Build system prompt (workspace files + tool descriptions + agent config)
4. Estimate total tokens
5. Apply compaction if over budget
6. Convert messages to provider format

**Token estimation** (conservative):
- Text: 3 chars/token (standard English ~4, JSON/code ~2.5-3)
- Base64 data: 1:1 char-to-token
- Image files: 1600 tokens
- Non-image files: 500 token overhead
- Safety margin: 1.25× — compaction triggers at 125% of available budget

## Compaction Strategies

### Sliding-window (fast, no LLM)
1. Anchor first user message (preserves original context)
2. Fill from most recent messages backwards until budget reached
3. Insert marker: `[N earlier messages omitted to fit context window]`
4. Guarantee at least 4 recent messages preserved

### Summary-based (LLM-powered)
1. Split into older (summarize) and recent (keep verbatim)
2. LLM summarizes older messages with 7 required sections: key decisions, open TODOs, constraints, pending asks, exact identifiers (verbatim), tool failures, current task state
3. Quality audit: required sections present, ≥20% identifier preservation, latest user ask reflected. Up to 2 retries.
4. Assemble: anchor + summary + recent messages
5. Fallback to sliding-window on failure or 120s timeout

### Adaptive multi-part (very long histories, >120% context window)
1. Split conversation into 2-8 parts
2. Parallel summarization of each part
3. Merge partial summaries into single cohesive summary
4. Partial failure tolerance — failed parts use raw transcript excerpts

## Tool Result Management
- **Truncation**: Single results capped at 30% of effective context window, hard max 50,000 chars. Results <2,000 chars never truncated.
- **Compaction**: Older tool results replaced with `[compacted: tool output removed to free context]`, preserving call metadata.

## Behavior
- **Retry on overflow**: Attempt 1 normal → Attempt 2 truncate tool results to 30% → Attempt 3 full compaction
- **After 3 consecutive summary failures per stream**, switches to sliding-window only (prevents infinite loops)
- **Pre-compaction memory flush**: When approaching soft threshold, triggers memory flush to preserve context before compaction

## Dependencies
- Memory system (R5) — pre-compaction flush
- Streaming architecture (R2) — retry mechanism integration
- Workspace files (R8) — included in system prompt budget
- `packages/storage/` — conversation history

## Gate
`pnpm build && pnpm quality` — exit 0.
