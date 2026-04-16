# R11: Chat UI — `pages/side-panel/` + `pages/full-page-chat/`

## Scope
Primary chat interfaces (Side Panel overlay + Full-Page Chat push sidebar) built with React 19. Covers streaming display, tool call rendering, first-run setup, auto-titling, chat history with search, and session management.

## Key Files
| File/Package | Role |
|---|---|
| `pages/side-panel/` | Primary chat UI — overlay sidebar mode |
| `pages/full-page-chat/` | Full-page chat — push sidebar mode with embedded settings |
| `packages/shared/lib/hooks/` | `useLLMStream` hook — Port-based streaming client |
| `packages/ui/` | React components — shadcn/ui + custom chat components |
| `packages/shared/lib/chat-types.ts` | Chat message types, tool part states |
| `packages/storage/` | IndexedDB persistence for chats, messages |

## Architecture
Both UIs share the same core components and streaming infrastructure. The Side Panel renders as a Chrome side panel overlay; Full-Page Chat renders in a dedicated tab with push sidebar layout.

**Streaming data flow:**
```
useLLMStream hook
  → chrome.runtime.Port connection
  → Background SW receives, builds context, starts LLM stream
  → Events flow back: text deltas, reasoning, tool calls, tool results, turn end
  → React state updates → UI renders incrementally
```

**First-run setup:**
When `models.length === 0`, both UIs show `<FirstRunSetup>` instead of the chat interface. Users must configure at least one model/API key before chatting.

**Chat history:**
- Stored in IndexedDB (`chats` + `messages` tables)
- Date grouping: Today, Yesterday, This Week, This Month, Older
- Full-text search across titles and content
- Agent indicator per chat
- Click to resume with full history

**Auto-titling:**
After the first exchange in a new conversation, the LLM generates a short title automatically. Title appears in the chat history sidebar.

## Key Types/Interfaces
```typescript
type ToolPartState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error';

type ChatMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown>; result?: unknown; state?: ToolPartState }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; state?: ToolPartState }
  | { type: 'file'; url: string; filename?: string; mediaType?: string; data?: string };

interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  wasCompacted?: boolean;
  contextUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  persistedByBackground?: boolean;
}
```

## Behavior
- **Streaming display**: Text and reasoning render incrementally as deltas arrive. Tool calls show input-streaming → input-available → output-available/output-error states.
- **Tool call rendering**: Each tool call displays tool name, arguments (collapsible), and result with appropriate state indicators.
- **Session transitions**: Switching chats triggers session journaling — transcript analyzed, durable memories extracted, MEMORY.md updated. 60-second cooldown per chat prevents rapid re-processing.
- **Token usage**: Each session tracks prompt/completion/total tokens, compaction status. Visible on Options → Usage tab.
- **Channel sessions**: Messages from WhatsApp/Telegram create or resume channel-linked chat sessions with distinct context per contact/group.
- **Voice input**: Microphone button records audio → STT transcription → text message.

## Dependencies
- `packages/shared` (`useLLMStream` hook, chat types)
- `packages/ui` (shadcn/ui components, chat components)
- `packages/storage` (IndexedDB via Dexie.js)
- Background service worker (streaming, tool execution, auto-titling)
- `chrome.runtime.Port` API

## Gate
`pnpm build && pnpm quality` — exit 0.
