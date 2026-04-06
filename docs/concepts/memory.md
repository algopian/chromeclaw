---
summary: "Memory system — BM25 full-text search, vector embeddings, MMR re-ranking, temporal decay, and session journaling."
read_when:
  - Understanding how ChromeClaw remembers across sessions
  - Configuring the memory system
  - Learning about hybrid search (BM25 + vectors)
title: "Memory"
---

# Memory

ChromeClaw's memory system provides long-term context recall across sessions. It combines BM25 full-text search with optional vector embeddings, applies temporal decay to prioritize recent information, and uses MMR re-ranking to reduce redundancy.

## How memory works

Memory is built from two sources:

1. **Workspace files** — All files in the workspace (including `memory/YYYY-MM-DD.md` daily journals) are chunked and indexed
2. **Session journaling** — When you switch chats, the LLM extracts durable memories from the conversation and writes them to daily memory files

The memory search tools let the agent query this indexed knowledge during conversations.

## Search pipeline

### BM25 full-text search

Always available, no external API required.

**Tokenization** supports 7 languages:
- **Latin/Cyrillic/Arabic** — Word-boundary splitting (words ≥ 2 characters, stop words filtered)
- **Chinese/Japanese Kanji** — Character bigrams (overlapping pairs)
- **Japanese Kana** — Hiragana/Katakana runs as complete tokens
- **Korean Hangul** — Individual syllable blocks

**Scoring** uses the standard BM25 algorithm (K1=1.2, B=0.75):
- IDF weighting by document frequency
- Term frequency normalization by document length
- AND-first with OR fallback (tries all query terms first, relaxes if no matches)

### Vector embeddings (optional)

When configured, ChromeClaw generates vector embeddings for memory chunks using an OpenAI-compatible embedding API.

- Vectors are L2-normalized for efficient cosine similarity (dot product after normalization)
- Embeddings are cached in IndexedDB to avoid redundant API calls
- Supports any embedding model accessible via OpenAI-compatible endpoints

**To enable**: Configure an embedding provider on the Options page with a base URL, API key, and model name.

### Hybrid ranking

When both BM25 and vector search are available, results are combined:

1. **Parallel candidate generation** — BM25 and vector search each return 4x the requested results
2. **Score normalization** — BM25 scores normalized to [0,1]; vector scores already in [0,1]
3. **Weighted fusion** — `normalizedVectorWeight × vectorScore + normalizedBm25Weight × bm25Score`
4. **Temporal decay** — Exponential decay applied to dated entries
5. **MMR re-ranking** — Maximal Marginal Relevance reduces redundancy

If no embedding provider is configured, pure BM25 results are still passed through temporal decay and MMR.

## Temporal decay

Older memories are gradually down-weighted to prioritize recent context:

- **Formula**: `score × exp((-ln(2) / halfLifeDays) × ageDays)`
- **Default half-life**: 30 days (at 30 days old, a memory's score is halved)
- **Date extraction**: Parsed from file paths like `memory/YYYY-MM-DD.md`

**Evergreen files** are exempt from decay:
- `MEMORY.md` (root-level summary)
- Files in `memory/` without dates in their names

This means your curated `MEMORY.md` summary always has full weight, while daily journal entries naturally fade over time.

## MMR re-ranking

Maximal Marginal Relevance prevents search results from being redundant:

- **Jaccard similarity** between token sets measures diversity
- **Formula**: `mmrScore = λ × relevance - (1-λ) × maxSimilarityToSelected`
- **Default λ**: 0.7 (70% relevance, 30% diversity)
- Greedy iterative selection — picks the highest MMR score from remaining candidates

This ensures that even when multiple memory chunks are relevant, the returned results cover different aspects of the query.

## Text chunking

Memory content is split into chunks for indexing:

- **Chunk size**: 1600 characters
- **Overlap**: 320 characters between adjacent chunks

Each chunk stores its source file path, start/end line numbers, and full text for retrieval.

## Session journaling

When you switch chats, ChromeClaw automatically extracts durable memories:

1. **Guard**: 60-second cooldown per chat prevents rapid re-processing
2. **Transcript preparation**: Messages serialized into a readable format (minimum 4 messages required)
3. **Deduplication**: Searches existing memories to avoid writing duplicate facts
4. **LLM extraction**: A prompt asks the LLM to extract bullet-point memories from the transcript
5. **Writing**: New memories appended to `memory/YYYY-MM-DD.md` with timestamp and session title
6. **MEMORY.md curation**: LLM integrates new entries into the summary (kept under 4000 chars)
7. **Transcript indexing**: The conversation is chunked and stored as searchable memory

If the LLM returns `NO_REPLY`, no new memories are written (the conversation didn't contain anything new).

## Memory tools

Two tools are available for memory access during conversations:

### memory_search

Search across all indexed memory chunks:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | Keyword search query |
| `maxResults` | number | 10 | Maximum results (up to 30) |
| `minScore` | number | 0.0 | Minimum relevance score |

Returns ranked results with file paths, line ranges, scores, and text snippets.

### memory_get

Retrieve specific content from a memory file:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | (required) | File path |
| `from` | number | 1 | Starting line number |
| `lines` | number | — | Max lines to return (up to 200) |

## Configuration

Memory settings are managed on the Options page:

- **BM25** — Always enabled, no configuration required
- **Embeddings** — Optional; configure provider URL, API key, and model
- **Temporal decay** — Half-life in days (default 30)
- **MMR lambda** — Relevance vs. diversity balance (default 0.7)
