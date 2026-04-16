# R14: Web Providers — `chrome-extension/src/background/web-providers/`

## Scope
Zero-token LLM access via 7+ web providers (Claude, Qwen, Qwen CN, Kimi, GLM, GLM Intl, Gemini) using the user's existing browser sessions. Plugin system with content script injection, SSE/binary stream parsing, and XML-based tool calling.

## Key Files
| File/Package | Role |
|---|---|
| `web-providers/types.ts` | `WebProviderDefinition`, `WebRequestOpts` |
| `web-providers/registry.ts` | Provider registration and lookup |
| `web-providers/auth.ts` | Cookie-based session capture and polling |
| `web-providers/web-llm-bridge.ts` | Main orchestrator (request → stream events) |
| `web-providers/content-fetch-main.ts` | MAIN world: credentialed fetch + binary protocols |
| `web-providers/content-fetch-relay.ts` | ISOLATED world: message forwarding to background |
| `web-providers/sse-parser.ts` | Line-based SSE extraction |
| `web-providers/sse-stream-adapter.ts` | Adapter interface + factory dispatch |
| `web-providers/xml-tag-parser.ts` | `<think>`/`<tool_call>` extraction from text stream |
| `web-providers/tool-strategy.ts` | Per-provider prompt building strategy |
| `web-providers/tool-prompt.ts` | Shared tool prompt templates |
| `web-providers/providers/` | Individual provider definitions + stream adapters |

## Architecture
Web providers integrate as a third stream path in `stream-bridge.ts`:
```
createStreamFn()
  ├── provider === cloud  → streamSimple() (pi-mono)
  ├── provider === local  → requestLocalGeneration() (offscreen + transformers.js)
  └── provider === web    → requestWebGeneration() (tab-context fetch + XML parser)
```
All three return `AssistantMessageEventStream`. Agent loop and UI need zero changes.

**Content injection (two-world model):**
- **MAIN world** (`content-fetch-main.ts`): Runs in provider tab context. Has access to page globals (e.g., `WIZ_global_data` for Gemini). `fetch()` inherits user cookies. Handles binary protocol decoding. Outputs `window.postMessage` chunks.
- **ISOLATED world** (`content-fetch-relay.ts`): Receives `window.postMessage`, forwards via `chrome.runtime.sendMessage` to background. Origin validation + auto-cleanup on timeout.

**Authentication flow:**
```
User clicks Login → chrome.tabs.create(loginUrl)
  → Poll cookies every 2s (5 min max) via chrome.cookies.getAll
  → Session cookie detected → Capture all cookies
  → Optional token refresh (GLM) → Store in IndexedDB
```

**Provider comparison:**
| Provider | Protocol | Text Mode | Tools | Reasoning |
|---|---|---|---|---|
| Claude | SSE (2-step: create + stream) | Delta | Yes | Yes |
| Qwen / Qwen CN | SSE | Delta | Yes | Yes |
| Kimi | Connect Protocol (binary frames) | Delta | Yes | No |
| GLM / GLM Intl | SSE + signing (MD5/HMAC-SHA256) | Cumulative | Yes | GLM Intl only |
| Gemini | Length-prefixed JSON (`f.req` form) | Cumulative | Yes | Yes |

**Tool calling:** All providers use XML-based tool calling (`<tool_call id="..." name="...">JSON</tool_call>`). Native tool calls (Claude `tool_use`, Qwen `function_call`) are converted to XML format by stream adapters. XML tag parser extracts `<think>`, `<tool_call>`, and plain text events.

**Tool strategies:**
- Stateless aggregation (Kimi, Gemini, Claude) — full history in one message
- Stateful with conv ID (Qwen, GLM) — first turn full, continuations last message + tool hint

## Key Types/Interfaces
```typescript
interface WebProviderDefinition {
  id: string; name: string;
  loginUrl: string; cookieDomain: string;
  sessionIndicators: string[];
  defaultModelId: string; defaultModelName: string;
  supportsTools: boolean; supportsReasoning: boolean;
  contextWindow: number;
  refreshAuth?: (opts) => Promise<void>;
  buildRequest: (opts: WebRequestOpts) => { url: string; init: RequestInit; binaryProtocol?: string; setupRequest?: object };
  parseSseDelta: (data: unknown) => string | null;
}
```

## Behavior
- **Stream adapters**: Handle cumulative text dedup (GLM, Gemini), think block wrapping, native tool call → XML conversion, non-standard tag normalization (e.g., `〉` → `>`), abort signaling after tool calls.
- **Malformed tool calls**: XML parser emits malformed `<tool_call>` JSON as plain text rather than crashing.
- **Error handling**: HTTP 4xx, empty responses, stream timeout detection. Logged with `[web-llm]` prefix.
- **Skills**: Work through the same XML tool calling pipeline — no special integration.

## Dependencies
- `chrome.cookies` API (session detection)
- `chrome.scripting.executeScript` (content injection)
- `chrome.tabs` API (provider tab management)
- `croner` (not applicable — this is self-contained)
- Stream infrastructure shared with cloud/local providers

## Gate
`pnpm build && pnpm quality` — exit 0.
