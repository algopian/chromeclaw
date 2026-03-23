# Web Providers — Design & Architecture

Zero API keys, zero cost — uses the user's existing browser sessions to access LLMs.

---

## Problem

ChromeClaw supports cloud LLM providers (via pi-mono SDK) and local models (via offscreen/transformers.js), both requiring API keys or local model downloads. Many users already have active sessions on provider websites (claude.ai, chatglm.cn, etc.). Web providers let them use those sessions directly.

## How It Fits

Web providers integrate as a third stream path alongside cloud and local:

```
stream-bridge.ts createStreamFn()
  |
  ├── provider === cloud  →  streamSimple()            (pi-mono native)
  ├── provider === local  →  requestLocalGeneration()   (offscreen + transformers.js)
  └── provider === web    →  requestWebGeneration()     (tab-context fetch + XML parser)
```

All three return `AssistantMessageEventStream`. The agent loop, stream-handler, and UI need zero changes.

### Chrome Extension Advantage

ChromeClaw IS the browser — no Playwright, no CDP browser launch needed.

- `chrome.cookies` API for session detection
- `chrome.scripting.executeScript()` for credentialed fetch in tab context
- `chrome.tabs` for provider tab management

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Background Service Worker                     │
│                                                                      │
│  ┌──────────┐   ┌─────────────┐   ┌──────────┐   ┌──────────────┐  │
│  │ Tool      │──▶│ Web LLM     │──▶│ SSE      │──▶│ Stream       │  │
│  │ Strategy  │   │ Bridge      │   │ Parser   │   │ Adapter      │  │
│  └──────────┘   └──────┬──────┘   └──────────┘   └──────┬───────┘  │
│                         │                                 │          │
│  ┌──────────┐           │                          ┌──────▼───────┐  │
│  │ Auth     │           │                          │ XML Tag      │  │
│  │ Manager  │           │                          │ Parser       │  │
│  └──────────┘           │                          └──────┬───────┘  │
│                         │                                 │          │
│  ┌──────────┐           │                          ┌──────▼───────┐  │
│  │ Registry │           │                          │ Stream       │  │
│  │          │           │                          │ Events       │  │
│  └──────────┘           │                          │ (to UI)      │  │
│                         │                          └──────────────┘  │
└─────────────────────────┼────────────────────────────────────────────┘
                          │ chrome.scripting.executeScript
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Provider Website Tab                             │
│                                                                      │
│  ┌────────────────────────┐     ┌────────────────────────────────┐  │
│  │  ISOLATED World        │     │  MAIN World                    │  │
│  │  (content-fetch-relay) │◀────│  (content-fetch-main)          │  │
│  │                        │ msg │                                │  │
│  │  Forwards messages     │     │  • Inherits user session       │  │
│  │  to background via     │     │  • Runs fetch with cookies     │  │
│  │  chrome.runtime API    │     │  • Handles binary protocols    │  │
│  └────────────────────────┘     │  • Streams SSE chunks back     │  │
│                                 └────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Request/Response Pipeline

```
User Message
    │
    ▼
┌──────────────┐
│ Tool Strategy │  Build tool prompt + aggregate history per provider rules
│ buildPrompt() │  (stateful vs stateless, single message vs multi-turn)
└──────┬───────┘
       ▼
┌──────────────┐
│ Provider     │  buildRequest() → { url, init, binaryProtocol?, setupRequest? }
│ Definition   │  Provider-specific URL, headers, body format
└──────┬───────┘
       ▼
┌──────────────┐
│ Content Fetch │  MAIN world: fetch() with credentials: 'include'
│ (in tab)      │  Optional: setupRequest (token exchange, session creation)
└──────┬───────┘  Optional: binary protocol decoding (connect-json, gemini-chunks)
       │
       │ window.postMessage → chrome.runtime.sendMessage
       ▼
┌──────────────┐
│ SSE Parser   │  Line-based SSE extraction → { event, data } pairs
└──────┬───────┘
       ▼
┌──────────────┐
│ parseSseDelta │  Provider-specific: extract text delta from parsed JSON
│ (provider)    │  (e.g. choices[0].delta.content, parts[0].content[0].text)
└──────┬───────┘
       ▼
┌──────────────┐
│ Stream       │  Provider-specific processing:
│ Adapter      │  • Cumulative text dedup (GLM, Gemini)
│              │  • Think block wrapping (GLM, Claude, Gemini)
│              │  • Native tool call interception (Claude, Qwen)
│              │  • Non-standard tag normalization (GLM)
│              │  • Abort signaling on tool failure
└──────┬───────┘
       ▼
┌──────────────┐
│ XML Tag      │  Extract structured events from raw text stream:
│ Parser       │  • <think>...</think> → thinking_start/delta/end
│              │  • <tool_call id="..." name="...">JSON</tool_call> → tool_call
│              │  • Plain text → text events
│              │  • <tool_response> → discarded (hallucination)
└──────┬───────┘
       ▼
  Stream Events → UI (via chrome.runtime.Port)
```

---

## Provider Comparison

| Provider | ID | Request Format | Response Protocol | Text Mode | Auth | Context | Tools | Reasoning |
|---|---|---|---|---|---|---|---|---|
| **Claude** | `claude-web` | JSON POST (2-step: create + stream) | SSE | Delta | Cookie (`sessionKey`) | 200K | Yes | Yes |
| **Qwen** | `qwen-web` | JSON POST (2-step: new chat + completions) | SSE | Delta | Cookie (`token`, `ctoken`) | 32K | Yes | Yes |
| **Qwen CN** | `qwen-cn-web` | JSON POST (single endpoint) | SSE | Delta | Cookie (`tongyi_sso_ticket`) | 32K | Yes | Yes |
| **Kimi** | `kimi-web` | Connect Protocol (binary frames) | Connect-JSON | Delta | Cookie → Bearer | 128K | Yes | No |
| **GLM** | `glm-web` | JSON POST + MD5 signing | SSE | Cumulative | Cookie + token refresh | 128K | Yes | No |
| **GLM Intl** | `glm-intl-web` | JSON POST + HMAC-SHA256 signing | SSE | Cumulative | Cookie + token refresh | 128K | Yes | Yes |
| **Gemini** | `gemini-web` | URL-encoded form (`f.req` + `at`) | Length-prefixed JSON | Cumulative | Cookie (`__Secure-1PSID`) | 1M | Yes | Yes |

---

## Per-Provider Architecture

### Claude (`claude-web`)

```
buildRequest()                          Stream Adapter
┌────────────────────┐                  ┌──────────────────────────────┐
│ POST /api/prompt    │                  │ Event type routing:          │
│  → creates chat     │                  │  content_block_delta         │
│  → URL template     │                  │   ├─ text_delta → feedText  │
│  {uuid} substitution│                  │   └─ thinking_delta → <think>│
│                     │                  │                              │
│ Single prompt field │                  │ Native tool_use → XML convert│
│ (last message only) │                  │ tool_result → discard        │
└────────────────────┘                  │ shouldAbort after tool_use   │
                                        └──────────────────────────────┘
Tool Strategy: Stateless, full history aggregation
  └─ Prepends "use XML format, ignore built-in tools" instruction
```

### Qwen (`qwen-web` / `qwen-cn-web`)

```
buildRequest()                          Stream Adapter
┌────────────────────┐                  ┌──────────────────────────────┐
│ qwen-web:           │                  │ Phase tracking:              │
│  POST /chats/new    │                  │  think → <think>...</think>  │
│  then /completions  │                  │  answer → plain text         │
│  with chat_id       │                  │                              │
│                     │                  │ Native function_call:        │
│ qwen-cn-web:        │                  │  Accumulate → XML convert    │
│  POST /completions  │                  │  function_id tracking/FIFO   │
│  (single endpoint)  │                  │                              │
└────────────────────┘                  │ "Tool X does not exists"     │
                                        │  → abort signal              │
Tool Strategy: Stateful (conv ID reuse) └──────────────────────────────┘
  └─ First turn: full aggregation
  └─ Continuation: last message + tool hint
```

### Kimi (`kimi-web`)

```
buildRequest()                          Stream Adapter
┌────────────────────┐                  ┌──────────────────────────────┐
│ Connect Protocol    │                  │ Simple passthrough:          │
│  Binary frames      │                  │  op: set/append → feedText   │
│  [flags][len][json] │                  │  done: true → stream end     │
│                     │                  │  error → throw               │
│ Bearer token auth   │                  │                              │
│  from cookie        │                  │                              │
└────────────────────┘                  └──────────────────────────────┘

Tool Strategy: Stateless, full history aggregation
  └─ content-fetch-main decodes binary frames → SSE
```

### GLM (`glm-web`)

```
buildRequest()                          Stream Adapter
┌────────────────────┐                  ┌──────────────────────────────┐
│ JSON POST + signing │                  │ Cumulative text dedup:       │
│  X-Sign (MD5)       │                  │  prevText tracking, delta    │
│  X-Nonce (UUID)     │                  │                              │
│  X-Timestamp        │                  │ Think content (cumulative):  │
│                     │                  │  type:"think" → <think> wrap │
│ Optional token      │                  │                              │
│  refresh via        │                  │ Closing tag normalization:   │
│  setupRequest       │                  │  的工具结果 / 〉 / ＞ → >    │
│                     │                  │                              │
│ Shared: glm-shared  │                  │ Error frame detection        │
└────────────────────┘                  └──────────────────────────────┘

Tool Strategy: Stateful (conv ID reuse)
  └─ extractConversationId from response
  └─ First turn: full aggregation
  └─ Continuation: last message + tool hint
```

### GLM Intl (`glm-intl-web`)

```
buildRequest()                          Stream Adapter
┌────────────────────┐                  ┌──────────────────────────────┐
│ JSON POST + signing │                  │ Cumulative text dedup:       │
│  HMAC-SHA256        │                  │  prevText tracking, delta    │
│  X-Signature        │                  │                              │
│  X-FE-Version       │                  │ Phase-based think/answer:    │
│                     │                  │  thinking phase → <think>    │
│ JWT from            │                  │  answer phase → plain text   │
│  localStorage       │                  │                              │
│                     │                  │ Closing tag normalization    │
│ Chat session create │                  │  (shared with GLM domestic)  │
│  before streaming   │                  │                              │
└────────────────────┘                  └──────────────────────────────┘

Tool Strategy: Stateful (conv ID reuse)
  └─ extractConversationId from response
  └─ First turn: full aggregation
  └─ Continuation: last message + tool hint
```

### Gemini (`gemini-web`)

```
buildRequest()                          Stream Adapter
┌────────────────────┐                  ┌──────────────────────────────┐
│ URL-encoded form    │                  │ Cumulative text dedup:       │
│  f.req = nested     │                  │  deeply nested extraction    │
│    JSON (69 fields) │                  │  inner[4][0][1] text array   │
│  at = CSRF token    │                  │                              │
│                     │                  │ Bare "think\n" prefix:       │
│ Page state from     │                  │  Suppress until <think> or   │
│  WIZ_global_data:   │                  │  <tool_call> appears         │
│  f.sid, at, bl      │                  │                              │
│                     │                  │ shouldAbort after            │
│ content-fetch-main  │                  │  </tool_call> completion     │
│  builds real request│                  │                              │
│  (anti-XSS strip)   │                  │ Completion marker:           │
└────────────────────┘                  │  status [1]→[2], [null,null,7]│
                                        └──────────────────────────────┘
Tool Strategy: Stateless, full history aggregation
  └─ Always single message (no conv ID)
```

---

## Authentication Flow

```
User clicks "Login"
       │
       ▼
┌──────────────┐
│ Open login   │  chrome.tabs.create(provider.loginUrl)
│ tab          │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Poll cookies │  Every 2s, check provider.sessionIndicators
│ (5 min max)  │  via chrome.cookies.getAll(provider.cookieDomain)
└──────┬───────┘
       │ session cookie detected
       ▼
┌──────────────┐
│ Capture all  │  Session cookies + XSRF tokens + auth cookies
│ cookies      │
└──────┬───────┘
       │
       ▼ (optional, GLM only)
┌──────────────┐
│ refreshAuth  │  Exchange refresh_token for access_token
│              │  via provider-specific endpoint
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Store in     │  webCredentialsStorage (IndexedDB)
│ IndexedDB    │  { providerId, cookies, capturedAt, token? }
└──────────────┘
```

---

## Content Injection Model

The web provider system uses Chrome's content script injection to run fetch requests
with the user's authenticated session, while maintaining security isolation.

```
┌─────────────────────────────────────────────────┐
│              Provider Website Tab                │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │ MAIN World (page context)                │   │
│  │                                          │   │
│  │  content-fetch-main.ts                   │   │
│  │  • Access to page JS globals             │   │
│  │    (WIZ_global_data for Gemini)          │   │
│  │  • fetch() inherits user cookies         │   │
│  │  • Binary protocol handling              │   │
│  │    - connect-json (Kimi)                 │   │
│  │    - gemini-chunks (Gemini)              │   │
│  │  • URL template substitution             │   │
│  │  • Setup request execution               │   │
│  │                                          │   │
│  │  Output: window.postMessage({            │   │
│  │    type: 'WEB_LLM_CHUNK' | '_DONE'      │   │
│  │         | '_ERROR',                      │   │
│  │    requestId, chunk                      │   │
│  │  })                                      │   │
│  └─────────────┬────────────────────────────┘   │
│                │ window.postMessage              │
│  ┌─────────────▼────────────────────────────┐   │
│  │ ISOLATED World (extension context)       │   │
│  │                                          │   │
│  │  content-fetch-relay.ts                  │   │
│  │  • Origin validation                     │   │
│  │  • chrome.runtime.sendMessage()          │   │
│  │  • Auto-cleanup on timeout               │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

**Why two worlds?**
- MAIN world can access page globals and send credentialed requests
- ISOLATED world has access to `chrome.runtime` APIs
- Neither can directly call the other's privileged APIs
- `window.postMessage` bridges the gap safely

Why `chrome.scripting.executeScript` in MAIN world over alternatives:
- **`chrome.cookies.getAll` + fetch from background**: Fails for anti-bot providers (wrong TLS fingerprint)
- **CDP `Runtime.evaluate`**: Shows "controlled by debugging software" banner
- **MAIN world injection**: Inherits all cookies/session, zero fingerprint issues, no user-visible warnings

---

## Tool Calling Flow

All web providers use XML-based tool calling since native tool APIs are not available
through browser session capture.

```
System Prompt
  + Tool Definitions (markdown format)
  + "Use <tool_call id=... name=...>JSON</tool_call>"
       │
       ▼
  LLM generates XML tool call in response text
       │
       ▼
  Stream Adapter
    ├─ Native tool call? (Claude tool_use, Qwen function_call)
    │   └─ Convert to XML <tool_call> format
    └─ Pass through to XML parser
       │
       ▼
  XML Tag Parser
    ├─ <tool_call id="x" name="web_search">{"query":"..."}</tool_call>
    │   └─ Emit: { type: 'tool_call', id, name, arguments }
    ├─ <think>reasoning</think>
    │   └─ Emit: thinking_start/delta/end events
    └─ Plain text
        └─ Emit: { type: 'text', text }
       │
       ▼
  Agent Loop
    ├─ Execute tool (web_search, etc.)
    ├─ Append result to conversation
    └─ Send next turn to provider
```

### Skills Support

Skills work through the same tool calling pipeline — no special integration needed. Skills are just a usage pattern of tool calling: the LLM reads a skill file via the `read` tool, then follows the skill's instructions (which may call more tools).

Tool/skill reliability varies by provider based on how well each web LLM follows XML format instructions. The XML parser has a fallback path — malformed `<tool_call>` JSON is emitted as plain text rather than crashing.

---

## File Map

```
web-providers/
├── types.ts                    # WebProviderDefinition, WebRequestOpts
├── registry.ts                 # Provider registration & lookup
├── auth.ts                     # Cookie-based session capture
├── web-llm-bridge.ts           # Main orchestrator (request → stream events)
├── content-fetch-main.ts       # MAIN world: credentialed fetch + binary protocols
├── content-fetch-relay.ts      # ISOLATED world: message forwarding
├── sse-parser.ts               # Line-based SSE extraction
├── sse-stream-adapter.ts       # Adapter interface + factory dispatch
├── xml-tag-parser.ts           # <think>/<tool_call> extraction
├── tool-strategy.ts            # Per-provider prompt building
├── tool-prompt.ts              # Shared tool prompt templates
└── providers/
    ├── claude-web.ts                   # Claude provider definition
    ├── claude-web-stream-adapter.ts    # Claude SSE processing
    ├── qwen-web.ts                     # Qwen provider definition
    ├── qwen-cn-web.ts                  # Qwen CN provider definition
    ├── qwen-stream-adapter.ts          # Qwen/DeepSeek SSE processing
    ├── kimi-web.ts                     # Kimi provider definition
    ├── kimi-web-stream-adapter.ts      # Kimi Connect Protocol processing
    ├── glm-web.ts                      # GLM domestic provider
    ├── glm-intl-web.ts                 # GLM international provider
    ├── glm-shared.ts                   # Shared GLM request builder
    ├── glm-signing.ts                  # MD5 signing + token refresh
    ├── glm-stream-adapter.ts           # GLM cumulative text + tag normalization
    ├── glm-intl-stream-adapter.ts      # GLM Intl phase tracking + tag normalization
    ├── gemini-web.ts                   # Gemini provider definition
    └── gemini-web-stream-adapter.ts    # Gemini chunk parsing + think prefix
```

---

## Adding a New Web Provider — Debug & Discovery Guide

Step-by-step walkthrough for reverse-engineering a new provider and mapping findings
to a `WebProviderDefinition`.

### Step 1: Identify the Target

Pick the provider website (e.g. `https://chat.deepseek.com`). You need:
- The chat URL where the user logs in
- The cookie domain (e.g. `.deepseek.com`)

### Step 2: Capture Network Traffic

#### Option A: Chrome DevTools Network Tab
1. Open the provider's chat page, log in
2. Open DevTools → Network tab → check "Preserve log"
3. Filter by "Fetch/XHR" (or "All" if the provider uses non-fetch like Gemini's XHR)
4. Send a message like "hi" in the chat
5. Look for the streaming request — usually the largest/longest one

#### Option B: CDP Network Domain (more reliable)
Use ChromeClaw's own debugger tool or a CDP script:
```js
// Attach to the provider tab
debugger({ action: "attach", tabId: <tabId> })

// Enable network capture
debugger({ action: "send", method: "Network.enable", params: {} })

// Send a message in the chat, then check captured traffic
// Look for: responseReceived, dataReceived events
```

**Why CDP?** Some providers (Gemini) use XHR instead of fetch — DevTools captures both, but fetch monkey-patching in content scripts won't intercept XHR.

#### What to Look For

| Item | Where to find it | Example |
|---|---|---|
| **Endpoint URL** | Request URL in Network tab | `/api/chat/completions` |
| **HTTP method** | Request headers | `POST` |
| **Content-Type** | Request headers | `application/json` or `application/x-www-form-urlencoded` |
| **Auth mechanism** | Request headers / cookies | `Authorization: Bearer ...` or session cookies |
| **Request body** | Request payload tab | JSON with messages array, or form-encoded |
| **Response format** | Response tab + headers | `text/event-stream` (SSE), binary frames, length-prefixed chunks |
| **Session cookies** | Application → Cookies | Which cookies appear after login |

### Step 3: Analyze the Request

#### 3a: Authentication
Check which cookies/headers are required:
```
Application → Cookies → filter by domain
```
- Note cookie names that appear only after login (these are `sessionIndicators`)
- Check if any `Authorization` header is derived from cookies
- Check if there's a CSRF/XSRF token (often in cookies or meta tags)

#### 3b: Request Body Structure
Compare the request body to known patterns:

**Standard OpenAI-like:**
```json
{
  "model": "deepseek-chat",
  "messages": [{"role": "user", "content": "hi"}],
  "stream": true
}
```

**Session-based (needs setup request):**
Some providers create a conversation first, then stream from it:
```
POST /api/chats/new → returns { id: "conv_123" }
POST /api/chat/completions?chat_id=conv_123 → SSE stream
```

**Form-encoded (Gemini-style):**
```
f.req=<url-encoded nested JSON>&at=<csrf token>
```

#### 3c: Response Format

Send a test message and examine the response stream:

**SSE (most common):**
```
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"content":" there"}}]}
data: [DONE]
```

**Binary frames (Kimi/Connect Protocol):**
- First byte is flags, next 4 bytes are length
- Payload is JSON

**Length-prefixed chunks (Gemini):**
- Numeric length line, then JSON chunk
- Anti-XSS prefix `)]}'\n` to strip

#### 3d: Text Delta vs Cumulative
Critical distinction:
- **Delta**: Each chunk has only new text (most providers)
- **Cumulative**: Each chunk has full text so far (GLM, Gemini) — need to compute delta

Test: send "tell me a story" and check if chunk 2 contains only new words or the full text from chunk 1 + new words.

### Step 4: Map Findings to Provider Definition

Once you have the raw data, map it to `WebProviderDefinition`:

```typescript
const myProvider: WebProviderDefinition = {
  id: 'my-web',                        // unique ID
  name: 'MyProvider (Web)',             // display name
  loginUrl: 'https://chat.example.com', // where user logs in
  cookieDomain: '.example.com',         // cookie domain to watch
  sessionIndicators: ['session_token'], // cookies that prove login
  defaultModelId: 'my-model',           // model ID string
  defaultModelName: 'My Model',         // display name
  supportsTools: true,                  // does it follow tool_call XML?
  supportsReasoning: false,             // does it output <think> blocks?
  contextWindow: 128_000,               // context window size

  // Optional: token refresh after login
  refreshAuth: opts => { ... },

  // Build the HTTP request
  buildRequest: opts => ({
    url: 'https://chat.example.com/api/completions',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: opts.messages[0]?.content }),
      credentials: 'include',
    },
  }),

  // Extract text delta from each SSE event
  parseSseDelta: data => {
    const obj = data as Record<string, unknown>;
    // Adapt to the provider's actual response shape
    const choices = obj.choices as Array<{ delta?: { content?: string } }>;
    return choices?.[0]?.delta?.content ?? null;
  },
};
```

### Step 5: Determine If You Need a Stream Adapter

You need a custom stream adapter if:
- Text is **cumulative** (not delta) — need dedup logic
- Provider has **native think/reasoning** output — need `<think>` wrapping
- Provider has **native tool calling** — need XML conversion
- Provider has **non-standard closing tags** — need normalization
- Provider has **binary frames** or unusual SSE format

If none of these apply, the default adapter works (just passes `delta` through).

### Step 6: Choose a Tool Strategy

| Strategy | When to use |
|---|---|
| **Default** | Standard system prompt + messages |
| **Stateless aggregation** (like Kimi, Gemini) | Provider doesn't support multi-turn; aggregate full history into one message |
| **Stateful with conv ID** (like Qwen, GLM) | Provider supports conversation continuation; track conv ID |

### Step 7: Files to Create/Modify

For a new provider `foo-web`:

1. **Create** `providers/foo-web.ts` — provider definition
2. **Create** `providers/foo-stream-adapter.ts` — if custom adapter needed
3. **Modify** `registry.ts` — register the provider
4. **Modify** `sse-stream-adapter.ts` — add adapter case in `getSseStreamAdapter()`
5. **Modify** `tool-strategy.ts` — add strategy case in `getToolStrategy()`
6. **Modify** `types.ts` — add `'foo-web'` to `WebProviderId` union
7. **Modify** `packages/shared/lib/chat-types.ts` — add to `WEB_PROVIDER_OPTIONS`
8. **Create** tests for adapter and provider

### Step 8: Debug Tips

#### "Empty response" (responseTextLength: 0)
- Check `parseSseDelta` — is it extracting from the right field?
- Check stream adapter — is it suppressing all output? (think prefix bug)
- Check if text is cumulative but adapter treats as delta

#### "Malformed tool_call"
- Check closing tag — non-standard `>` character? Missing `>`?
- Check if provider wraps tool calls differently

#### "HTTP 4xx from provider"
- Check request body format — JSON vs form-encoded?
- Check required headers — missing CSRF token? wrong Content-Type?
- Check cookie freshness — expired session?

#### "Stream never completes"
- Check if provider uses a `[DONE]` marker or binary done flag
- Check if content-fetch-main handles the protocol correctly

#### Useful log filters
```
[web-llm] SSE raw event    — see raw provider responses
[web-llm] SSE delta        — see what the adapter produces
[web-llm] Malformed        — tool call parsing failures
[web-llm] Web generation   — request sent / complete
[stream] Stream complete   — final result summary
```

### Verification Checklist

- [ ] Simple "hi" message → text response appears
- [ ] Thinking/reasoning shows in UI (if supported)
- [ ] Tool call works (e.g. "search for weather in SF")
- [ ] Multi-turn conversation works
- [ ] `pnpm test` passes
- [ ] `pnpm build` succeeds
