# R17: Storage Layer — `packages/storage/`

## Scope
All persistence: Chrome storage (local/session) for settings and small key-value data, plus IndexedDB via Dexie.js (`chromeclaw` database, schema v13, 9 tables) for structured data including chats, messages, models, artifacts, workspace files, memory, scheduled tasks, and embeddings.

## Key Files
| File/Package | Role |
|---|---|
| `packages/storage/` | Chrome storage wrappers + Dexie.js IndexedDB schema and access |
| `chrome-extension/src/background/` | Primary consumer — reads/writes all tables |
| `pages/side-panel/` | Reads chats, messages for UI display |
| `pages/options/` | Reads/writes models, agents, settings |

## Architecture

**Two storage mechanisms:**

### Chrome Storage (local/session)
Settings, tool configurations, channel credentials, and small key-value data. Uses `chrome.storage.local` for persistent data and `chrome.storage.session` for ephemeral session state.

### IndexedDB via Dexie.js
The `chromeclaw` database at schema version 13:

| Table | Contents |
|---|---|
| `chats` | Conversation metadata, token usage, compaction info, channel metadata |
| `messages` | Chat messages with typed parts (text, reasoning, tool calls, files) |
| `models` | Saved model configurations (`DbChatModel`) |
| `artifacts` | Generated documents (text, code, spreadsheets, images) |
| `workspaceFiles` | Context files — predefined (AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md, MEMORY.md) + custom, scoped per agent |
| `memoryChunks` | Indexed text chunks with optional vector embeddings |
| `scheduledTasks` | Persistent cron/scheduler tasks |
| `taskRunLogs` | Scheduled task execution history |
| `embeddingCache` | Cached vector embeddings for memory search |

**Data flow patterns:**
```
Background SW → Dexie.js → IndexedDB (chats, messages, tasks, memory)
Options page → Dexie.js → IndexedDB (models, agents, skills)
Options page → chrome.storage.local (settings, tool configs)
Side Panel → Dexie.js → IndexedDB (read chats, messages)
```

## Key Types/Interfaces
```typescript
// From packages/shared/lib/chat-types.ts
interface ChatModel {
  id: string; name: string;
  provider: 'openai' | 'anthropic' | 'google' | 'openrouter' | 'custom' | 'local';
  apiKey?: string; baseUrl?: string;
  supportsTools?: boolean; supportsReasoning?: boolean;
  contextWindow?: number;
}

interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  wasCompacted?: boolean;
  contextUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  persistedByBackground?: boolean;
}

// Messages stored with typed parts
type ChatMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown>; result?: unknown; state?: ToolPartState }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; state?: ToolPartState }
  | { type: 'file'; url: string; filename?: string; mediaType?: string; data?: string };
```

## Behavior
- **Schema migrations**: Dexie.js handles schema versioning. Current version is 13 with 9 tables.
- **Workspace files**: Predefined files (AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md, MEMORY.md) are created per agent. Enabled files are injected into the system prompt.
- **Memory chunks**: Text chunks with optional embeddings for hybrid BM25 + cosine similarity search.
- **Embedding cache**: Caches computed vector embeddings to avoid redundant API calls.
- **Task persistence**: Scheduled tasks and run logs survive browser restarts.
- **Channel metadata**: Stored alongside chat records (`ChannelMeta` with channelId, chatId, senderId, senderName).
- **Test mocking**: Unit tests use `fake-indexeddb` for storage mocks.

## Dependencies
- `dexie` (IndexedDB wrapper)
- `chrome.storage.local` / `chrome.storage.session`
- `fake-indexeddb` (test dependency)

## Gate
`pnpm build && pnpm quality` — exit 0.
