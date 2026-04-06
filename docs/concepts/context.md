---
summary: "Context management and compaction — how ChromeClaw handles token limits with sliding-window and LLM-powered summarization."
read_when:
  - Understanding how ChromeClaw manages long conversations
  - Learning about context compaction strategies
  - Troubleshooting context overflow issues
title: "Context Management"
---

# Context Management

ChromeClaw automatically manages the LLM context window to keep conversations flowing even when they exceed token limits. The context system assembles messages, estimates tokens, and applies compaction when needed.

## Token estimation

ChromeClaw uses conservative estimates to avoid context overflow:

- **Text**: 3 characters per token (standard English is ~4, but JSON/code/structured data is ~2.5-3)
- **Base64 data**: 1:1 character-to-token ratio
- **Image files**: 1600 tokens (vision API cost)
- **Non-image files**: 500 token overhead

A safety margin of 1.25x is applied — compaction triggers when the estimated token count exceeds 125% of the available budget.

## Context assembly pipeline

For each LLM call, the context is assembled in this order:

1. **Load conversation history** from IndexedDB
2. **Load workspace files** for the active agent
3. **Build system prompt** (workspace files + tool descriptions + agent config)
4. **Estimate total tokens**
5. **Apply compaction** if over budget
6. **Convert messages** to the provider's format

## Compaction strategies

When conversation history approaches the model's context window, ChromeClaw applies compaction automatically. There are two strategies:

### Sliding-window compaction

A fast, non-LLM fallback that always works:

1. **Anchor** the first user message (preserves original context)
2. **Fill** from the most recent messages backwards until the budget is reached
3. **Insert** a marker: `[N earlier messages omitted to fit context window]`
4. **Guarantee** at least 4 recent messages are preserved regardless of budget

This method is instant and doesn't require an LLM call, but loses the nuance of older messages.

### Summary-based compaction

An LLM-powered strategy that preserves more context:

1. **Split** messages into older (to summarize) and recent (to keep verbatim)
2. **Summarize** older messages using the LLM with a structured prompt requiring 7 sections:
   - Key decisions and outcomes
   - Open TODOs and pending tasks
   - Constraints and rules established
   - Pending user asks
   - Exact identifiers (file paths, URLs, error codes — verbatim)
   - Tool failures and file operations
   - Current task state
3. **Quality audit** the summary:
   - Checks required sections are present
   - Verifies identifier preservation (at least 20% of original identifiers must appear)
   - Confirms the latest user ask is reflected
   - Retries up to 2 times if quality checks fail
4. **Assemble** anchor + summary + recent messages

If summarization fails or times out (120 seconds), ChromeClaw falls back to sliding-window.

### Adaptive multi-part compaction

For very long histories (over 120% of the context window), ChromeClaw splits the conversation into 2-8 parts:

1. **Parallel summarization** — Each part is summarized independently
2. **Merge** — Partial summaries are combined into a single cohesive summary
3. **Partial failure tolerance** — If some parts fail, raw transcript excerpts are used instead

## Tool result management

Large tool results are a common cause of context overflow. ChromeClaw manages them in two ways:

### Truncation

Single tool results are capped at 30% of the effective context window, with a hard maximum of 50,000 characters. Results below 2,000 characters are never truncated.

### Compaction

When overall context is tight, older tool results are replaced with:

```
[compacted: tool output removed to free context]
```

This preserves the fact that a tool was called and what arguments were used, while freeing space for more important recent context.

## Retry on context overflow

If an LLM call fails due to context overflow, ChromeClaw retries automatically:

1. **Attempt 1** — Normal execution
2. **Attempt 2** — Truncate oversized tool results to 30% of their size
3. **Attempt 3** — Apply full context compaction

After 3 consecutive summary failures per stream, ChromeClaw switches to sliding-window only to prevent infinite loops.

## Pre-compaction memory flush

When context tokens approach a soft threshold, ChromeClaw may trigger a memory flush before compaction — converting the conversation transcript into durable memory entries. This ensures important context is preserved in the [memory system](/concepts/memory) before older messages are compacted away.
