# R2: Streaming Architecture — `chrome-extension/src/background/`

## Scope
LLM streaming via `chrome.runtime.Port` connecting the chat UI to the background service worker. Covers the `useLLMStream` hook, stream handler, SSE parsing, and tool calling loop.

## Key Files
| File/Package | Role |
|---|---|
| `packages/shared/lib/hooks/useLLMStream.ts` | Client-side hook — opens Port, handles events |
| `chrome-extension/src/background/llm-stream.ts` | Stream handler — receives Port, orchestrates LLM call |
| `chrome-extension/src/background/agents/model-adapter.ts` | Converts ChatModel to pi-mono Model for streaming |
| `packages/shared/lib/chat-types.ts` | Message part types, stream event types |

## Architecture
```
Chat UI (Side Panel / Full-Page Chat)
  → useLLMStream hook opens chrome.runtime.Port
  → Background SW receives Port connection
  → Builds context (workspace files + history + system prompt)
  → Estimates tokens, applies compaction if needed
  → chatModelToPiModel() → pi-mono streamSimple()
  → Provider SSE stream parsed into events
  → Events flow back through Port: text deltas, reasoning, tool calls, tool results, turn end
  → UI updates incrementally
```

**MV3 keep-alive**: Service workers may be terminated after 30s of inactivity. ChromeClaw uses keep-alive mechanisms during long-running LLM streams to prevent termination.

**Agent loop between turns**:
1. Stream LLM response (text + tool calls)
2. Execute any tool calls
3. Process follow-up messages (auto-continuations)
4. Process steering messages (user corrections mid-turn)
5. Repeat until no more tool calls or follow-ups

## Key Types/Interfaces
```typescript
type ToolPartState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error';

type ChatMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown>; result?: unknown; state?: ToolPartState }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; state?: ToolPartState }
  | { type: 'file'; url: string; filename?: string; mediaType?: string; data?: string };

interface LLMStreamRetry { type: 'LLM_STREAM_RETRY'; chatId: string; attempt: number; maxAttempts: number; reason: string; strategy: 'compaction' | 'truncate-tool-results' }
interface LLMTtsAudio { type: 'LLM_TTS_AUDIO'; chatId: string; audioBase64: string; contentType: string; provider: string; chunkIndex?: number; isLastChunk?: boolean }
interface SessionUsage { promptTokens: number; completionTokens: number; totalTokens: number; wasCompacted?: boolean; contextUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }; persistedByBackground?: boolean }
```

## Behavior
- Port-based streaming enables incremental UI updates (text deltas, reasoning blocks, tool call progress)
- Tool calls stream their input arguments before execution (`input-streaming` → `input-available` → `output-available`)
- Errors classified into categories: context overflow, rate limit, auth, network — each with appropriate recovery
- Automatic retry on context overflow: attempt 1 normal → attempt 2 truncate tool results → attempt 3 full compaction
- Tool loop detection (5-level): global no-progress, known poll tools, repeat detection, ping-pong detection, warnings. Severity: `none` → `warning` → `critical` → `circuit_breaker`

## Dependencies
- `chrome.runtime.Port` — streaming communication channel
- pi-mono `streamSimple()` — provider-specific SSE parsing
- Context compaction system (R6) — when tokens exceed budget
- Tool system (R4) — tool call execution within stream loop

## Gate
`pnpm build && pnpm quality` — exit 0.
