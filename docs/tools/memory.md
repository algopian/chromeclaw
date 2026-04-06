---
summary: "Memory tools — search and retrieve from the hybrid memory system (BM25 + vector embeddings)."
read_when:
  - Using memory search in conversations
  - Understanding memory tool parameters
  - Retrieving specific memory content
title: "Memory Tools"
---

# Memory Tools

Two tools for accessing the [memory system](/concepts/memory) during conversations.

## memory_search

Search across all indexed memory chunks using BM25 full-text search and optional vector embeddings.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | Keyword search query |
| `maxResults` | number | 10 | Maximum results (up to 30) |
| `minScore` | number | 0.0 | Minimum relevance score threshold |

### Returns

Ranked results with:
- **path** — Source file path (e.g., `memory/2024-03-15.md`)
- **startLine / endLine** — Line range within the file
- **score** — Relevance score
- **snippet** — First 700 characters of the matching chunk
- **citation** — Formatted citation string

Results are ranked using the full hybrid pipeline: BM25 + vector scores are fused, temporal decay is applied, and MMR re-ranking reduces redundancy.

### Example usage

The agent automatically uses `memory_search` when it needs to recall information from past conversations:

```
User: What did we decide about the database schema last week?

Agent: [calls memory_search with query "database schema decision"]
→ Returns relevant memory chunks from memory/2024-03-12.md
```

---

## memory_get

Retrieve specific content from a memory file by path and line range.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | (required) | File path |
| `from` | number | 1 | Starting line number (1-based) |
| `lines` | number | — | Max lines to return (up to 200) |

### Returns

File content with line numbers, starting from the specified position.

### Example usage

After finding a relevant chunk via `memory_search`, the agent can retrieve more context:

```
Agent: [calls memory_get with path "memory/2024-03-12.md", from 15, lines 30]
→ Returns lines 15-44 of the memory file
```

## When memory tools are used

The agent uses memory tools when:

- You ask about past conversations or decisions
- You reference something discussed previously
- The agent needs context that isn't in the current conversation
- Workspace instructions reference stored knowledge

Memory tools are always available (they use BM25 at minimum). Vector search is used automatically when an embedding provider is configured.
