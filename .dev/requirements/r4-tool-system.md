# R4: Tool System — `chrome-extension/src/background/tools/`

## Scope
31 built-in tools with central registry, TypeBox schema validation, timeout management, result formatting, caching, filtering, and custom JS tool support.

## Key Files
| File/Package | Role |
|---|---|
| `chrome-extension/src/background/tools/` | All tool implementations |
| `chrome-extension/src/background/agents/` | Tool call execution within agent loop |
| `packages/storage/` | Tool config persistence (Chrome storage) |
| `docs/tools/` | Tool documentation |

## Architecture
Tools are registered in a central registry. Each tool declares:
- **Name** and **description** (for LLM tool-use prompting)
- **TypeBox schema** for argument validation
- **Handler function** with optional `needsContext: true` for chat-aware tools
- **Result formatter** (text, image blocks, JSON)

**Execution flow**:
1. LLM decides to call a tool based on conversation + tool descriptions
2. Arguments validated against TypeBox schema
3. Tool executes with 5-minute default timeout (configurable per model via `toolTimeoutSeconds`)
4. Results formatted and returned to LLM as content blocks
5. LLM continues with tool results

## Built-in Tools (31 total)
| Category | Tools |
|---|---|
| **Web** | Web Search (Tavily/browser), Fetch URL |
| **Browser** | Browser (CDP — DOM snapshots, click/type, screenshots, JS eval), Debugger (raw CDP commands, Chrome-only) |
| **Google** | Gmail (4 tools), Calendar (4 tools), Drive (3 tools) — via OAuth |
| **Documents** | Create Document (text, code, spreadsheet, image artifacts) |
| **Research** | Deep Research (multi-step parallel search + synthesis), Subagent (3 tools — nested LLM calls) |
| **Code** | Execute JavaScript (sandboxed tab or specific browser tab) |
| **Memory** | Memory Search (BM25 + vector), Memory Get (file retrieval) |
| **Workspace** | Read, Write, Edit, List, Delete, Rename (6 tools) |
| **Automation** | Scheduler (one-shot, interval, cron-expression tasks) |
| **Meta** | Agents List |
| **Custom** | User-defined JS tools with `@tool` metadata, per-agent scoped |

## Key Types/Interfaces
```typescript
interface SubagentProgressInfo {
  runId: string; chatId: string; task: string;
  startedAt: number; stepCount: number; steps: SubagentProgressStep[];
}
```

## Behavior
- **Caching**: Web search and fetch cached 5 minutes; POST requests skip cache; empty results not cached
- **Filtering**: By user config (`enabledTools`), platform (Chrome-only hidden on Firefox), mode (some excluded in headless/subagent), agent overrides
- **Custom tools**: `@tool` metadata comments define name, description, params. Run in JS sandbox. Registered per-agent via `execute_javascript` with `action: "register"`. 30s default timeout, configurable up to 5 minutes.
- **Tool context**: Tools with `needsContext: true` receive `{ chatId }` for linking results to current chat
- **Result formatting**: Text (stringified), Browser (image content blocks), Web fetch (base64 images or text metadata), JSON (structured data preserved)
- **Timeout**: 5-minute default, configurable per model

## Dependencies
- Agent system (R3) — tool calls executed within agent loop
- Streaming architecture (R2) — tool call states streamed to UI
- Memory system (R5) — memory_search and memory_get tools
- Workspace files (R8) — workspace CRUD tools
- `chrome.debugger` API — browser/debugger tools
- Tavily API — web search (or browser-based fallback)

## Gate
`pnpm build && pnpm quality` — exit 0.
