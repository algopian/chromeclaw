# R5: Memory System — `chrome-extension/src/background/memory/`

## Scope
Hybrid search combining BM25 full-text and vector embeddings with temporal decay, MMR re-ranking, session journaling, and MEMORY.md auto-curation.

## Key Files
| File/Package | Role |
|---|---|
| `chrome-extension/src/background/memory/` | Search pipeline, journaling, chunking, indexing |
| `chrome-extension/src/background/tools/` | `memory_search` and `memory_get` tool implementations |
| `packages/storage/` | `memoryChunks`, `embeddingCache` tables in IndexedDB |

## Architecture
Memory is built from two sources:
1. **Workspace files** — All files (including `memory/YYYY-MM-DD.md` daily journals) chunked and indexed
2. **Session journaling** — On chat switch, LLM extracts durable memories → daily files → MEMORY.md curation

**Search pipeline**:
1. Parallel candidate generation — BM25 and vector search each return 4× requested results
2. Score normalization — BM25 normalized to [0,1]; vector scores already in [0,1]
3. Weighted fusion — `normalizedVectorWeight × vectorScore + normalizedBm25Weight × bm25Score`
4. Temporal decay — exponential decay on dated entries
5. MMR re-ranking — reduces redundancy in final results

**BM25 tokenization** supports 7 languages:
- Latin/Cyrillic/Arabic — word-boundary splitting (words ≥ 2 chars, stop words filtered)
- Chinese/Japanese Kanji — character bigrams
- Japanese Kana — complete runs as tokens
- Korean Hangul — individual syllable blocks

**BM25 scoring**: K1=1.2, B=0.75. AND-first with OR fallback.

## Key Types/Interfaces
```typescript
// memory_search tool params
interface MemorySearchParams {
  query: string;       // required
  maxResults?: number; // default 10, max 30
  minScore?: number;   // default 0.0
}

// memory_get tool params
interface MemoryGetParams {
  path: string;        // required
  from?: number;       // starting line, default 1
  lines?: number;      // max 200
}
```

## Behavior
- **Text chunking**: 1600 chars per chunk, 320 char overlap. Each chunk stores source path, line range, full text.
- **Vector embeddings** (optional): OpenAI-compatible API, L2-normalized for cosine similarity via dot product, cached in IndexedDB
- **Temporal decay**: `score × exp((-ln(2) / halfLifeDays) × ageDays)`, default half-life 30 days. Evergreen files exempt: root `MEMORY.md` and undated files in `memory/`
- **MMR**: Jaccard similarity for diversity. `mmrScore = λ × relevance - (1-λ) × maxSimilarityToSelected`, default λ=0.7. Greedy iterative selection.
- **Session journaling flow**: 60s cooldown per chat → serialize transcript (min 4 messages) → search for deduplication → LLM extraction → append to `memory/YYYY-MM-DD.md` → curate MEMORY.md (≤4000 chars) → chunk and index transcript. Returns `NO_REPLY` if nothing new.
- **Pre-compaction memory flush**: When tokens approach soft threshold, memory flush triggered before compaction to preserve context.

## Dependencies
- Workspace files (R8) — source content for indexing
- Context compaction (R6) — pre-compaction flush trigger
- Agent system (R3) — per-agent memory scoping
- OpenAI-compatible embedding API (optional) — vector search
- `packages/storage/` — IndexedDB persistence

## Gate
`pnpm build && pnpm quality` — exit 0.
