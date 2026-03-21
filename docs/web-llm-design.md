# Web LLM Providers — Design Document

## Problem

ChromeClaw supports cloud LLM providers (via pi-mono SDK) and local models (via offscreen/transformers.js), both requiring API keys or local model downloads. Many users already have active sessions on provider websites (claude.ai, chatgpt.com, etc.). We want to let them use those sessions directly — zero API keys, zero cost.

This document covers the design for adding web-based LLM providers to ChromeClaw, informed by studying how openclaw and openclaw-zero-token handle the same problem.

---

## Comparison: How Each Project Handles Web LLM

### OpenClaw (main repo)

- **Architecture**: CLI/gateway using pi-mono SDK (`@mariozechner/pi-ai`)
- **Web LLM support**: None. All providers use structured API calls via pi-mono
- **Tool calling**: Native — SDK handles tool schemas, provider routing, structured responses
- **Relevant code**: `src/agents/pi-embedded-runner/`, `src/agents/pi-tool-definition-adapter.ts`

| Aspect | Detail |
|---|---|
| Provider count | 8+ cloud providers |
| Web providers | None |
| Tool calling | Native SDK (structured API) |
| XML parsing | None needed |
| Shared abstractions | pi-mono handles everything |

### OpenClaw-Zero-Token

- **Architecture**: CLI fork focused on zero-cost usage via browser session capture
- **Web LLM support**: 11 web providers, each with 3 files (auth, client, stream)
- **Tool calling**: XML prompt injection + regex parsing, duplicated across 11 files
- **Relevant code**: `src/providers/*-web-auth.ts`, `src/providers/*-web-client-browser.ts`, `src/agents/*-web-stream.ts`

| Aspect | Detail |
|---|---|
| Provider count | 11 web providers |
| Auth mechanism | Playwright/CDP → launch Chrome → navigate to login URL → poll cookies/intercept requests |
| Runtime API calls | `page.evaluate()` runs fetch inside browser context (Playwright) |
| DOM simulation | Gemini (always), ChatGPT/Grok (fallback on 403) — types into input box, polls DOM for response |
| Tool calling | XML `<tool_call>` tags injected into system prompt; regex parser extracts from text response |
| Tool prompt | Full injection in 9 providers; **stub** in Gemini/ChatGPT (broken — doesn't list actual tools) |
| Shared abstractions | None — 11 copies of XML parser (~3,680 LOC duplicated, 61% of total) |
| Skills support | N/A (no skills system) |

**Provider credentials summary:**

| Provider | Login URL | Session Indicator | Runtime Approach |
|---|---|---|---|
| claude-web | claude.ai | `sessionKey` cookie (sk-ant-sid*) | API fetch |
| chatgpt-web | chatgpt.com | `__Secure-next-auth.session-token` cookie | API fetch + Sentinel bypass; DOM fallback |
| deepseek-web | chat.deepseek.com | Bearer token from /api/v0/ requests | API fetch with Authorization header |
| gemini-web | gemini.google.com | `SID` or `__Secure-1PSID` cookie | DOM simulation only (Bard RPC too complex) |
| grok-web | grok.com | `sso` or `_ga` cookies | API fetch; DOM fallback |
| kimi-web | kimi.com | `access_token` in cookie/localStorage | API fetch |
| doubao-web | doubao.com | `sessionid` cookie | API fetch |
| qwen-web | chat.qwen.ai | Session token | API fetch |
| qwen-cn-web | qianwen.com | `tongyi_sso_ticket` cookie | API fetch with XSRF token |
| glm-web | chatglm.cn | `chatglm_refresh_token` cookie | API fetch |
| glm-intl-web | chat.z.ai | `refresh_token` or `auth_token` | API fetch |

**Key learnings from zero-token:**
1. Most providers work with API fetch + cookies; only Gemini needs DOM simulation
2. ChatGPT requires Sentinel/Turnstile token bypass (oaistatic.com script)
3. Tool calling via XML is fragile — depends on LLM choosing to output correct tags
4. Massive code duplication is the biggest maintenance problem
5. Gemini/ChatGPT tool calling stubs are effectively broken (don't list tool definitions)

### ChromeClaw (this project)

- **Architecture**: Chrome extension with background service worker, side panel UI
- **Web LLM support**: Not yet implemented (this design)
- **Tool calling**: Native for cloud (pi-mono); XML parsing for local models (`local-llm-bridge.ts`)
- **Relevant code**: `chrome-extension/src/background/agents/stream-bridge.ts`, `chrome-extension/src/background/local-llm-bridge.ts`

| Aspect | Detail |
|---|---|
| Provider count | 8 cloud + 1 local |
| Existing XML parser | `local-llm-bridge.ts` lines 92-214 — handles `<think>` and `<tool_call>` tags |
| Chrome extension advantage | IS the browser — `chrome.cookies` API, `chrome.scripting.executeScript()`, `chrome.tabs` |
| Skills system | SKILL.md files with frontmatter; lazy-loaded via `read` tool; injected as XML metadata in system prompt |

### Three-Way Comparison

| Aspect | OpenClaw | Zero-Token | ChromeClaw (planned) |
|---|---|---|---|
| Platform | CLI/gateway | CLI | Chrome extension |
| Web provider support | None | 11 providers | 11 providers |
| Auth mechanism | N/A | Playwright + CDP (launch browser) | `chrome.cookies` + `chrome.tabs` (native) |
| Runtime API calls | pi-mono SDK | `page.evaluate()` in Playwright | `chrome.scripting.executeScript()` in tab |
| Tool calling (cloud) | Native SDK | N/A | Native SDK (pi-mono) |
| Tool calling (web) | N/A | XML prompt injection (duplicated 11x) | XML prompt injection (shared 1x) |
| XML parser | None | 11 copies (~3,680 LOC) | 1 shared module (~130 LOC) |
| Tool prompt injection | None | Inconsistent (9 full, 2 stubs) | Consistent for all providers |
| Skills | N/A | N/A | Works via tool calling chain |
| Estimated new code | N/A | ~5,000+ LOC | ~1,200 LOC |

---

## ChromeClaw Design

### Architecture Overview

Web providers integrate as a third stream path alongside cloud and local:

```
stream-bridge.ts createStreamFn()
  |
  ├── provider === cloud  →  streamSimple()            (pi-mono native)
  ├── provider === local  →  requestLocalGeneration()   (offscreen + transformers.js)
  └── provider === web    →  requestWebGeneration()     (NEW: tab-context fetch + XML parser)
```

All three return `AssistantMessageEventStream`. The agent loop, stream-handler, and UI need zero changes.

### Auth Capture

ChromeClaw's advantage: it IS the browser. No Playwright, no CDP browser launch.

```
1. User clicks "Login" for a web provider in Settings
2. chrome.tabs.create({ url: provider.loginUrl })
3. User logs in normally
4. Background polls: chrome.cookies.getAll({ domain: provider.cookieDomain })
5. When session cookie detected → extract credentials → store in chrome.storage
6. Close login tab, show green status
```

Replaces zero-token's 11 separate `*-web-auth.ts` files (each ~100 LOC with Playwright boilerplate) with one shared module (~150 LOC).

### Runtime API Calls

Primary approach: `chrome.scripting.executeScript({ world: 'MAIN' })` in a provider tab.

```
1. Find or create a background tab at the provider's domain
2. Inject provider-specific fetch script into the tab's MAIN world
3. Script runs fetch() with credentials:'include' (cookies automatic)
4. Script reads SSE stream, posts chunks via window.postMessage()
5. Content script relays chunks to chrome.runtime.sendMessage()
6. web-llm-bridge receives chunks, runs XML tag parser, emits events
```

Why this approach over alternatives:
- **`chrome.cookies.getAll` + fetch from background**: Fails for anti-bot providers (wrong TLS fingerprint)
- **CDP `Runtime.evaluate`**: Shows "controlled by debugging software" banner
- **`chrome.scripting.executeScript` in MAIN world**: Inherits all cookies/session, zero fingerprint issues, no user-visible warnings

For Gemini (DOM simulation): inject a different script that types into the input box and polls for response text — same approach as zero-token but via Chrome extension APIs instead of Playwright.

### Tool Calling

Web providers don't have native tool calling APIs. We use the same XML approach as `local-llm-bridge.ts`:

**Step 1 — Tool definitions injected into system prompt:**
```
## Tool Use Instructions
You have access to tools. To call a tool, output XML:
<tool_call>{"name":"tool_name","arguments":{...}}</tool_call>

Available tools:
- web_search: Search the web. Parameters: {"query": "string"}
- read: Read a file. Parameters: {"path": "string"}
...
```

**Step 2 — LLM outputs XML in its text response:**
```
Let me search for that.
<tool_call>{"name":"web_search","arguments":{"query":"weather today"}}</tool_call>
```

**Step 3 — Shared XML parser extracts tool calls:**
Extracted from `local-llm-bridge.ts` into `xml-tag-parser.ts`. Handles `<think>`, `<tool_call>`, and special token stripping. Used by both local and web bridges.

**Step 4 — Agent loop executes tool, sends result back:**
```
<tool_response>{"results":[...]}</tool_response>
```

### Skills Support

Skills work through the same tool calling pipeline:

```
System prompt includes skill metadata (name, description, path)
     ↓
Web LLM matches user request to a skill description
     ↓
Web LLM outputs: <tool_call>{"name":"read","arguments":{"path":"skills/daily-journal/SKILL.md"}}</tool_call>
     ↓
XML parser extracts it → agent loop executes `read` tool → returns SKILL.md content
     ↓
Content sent back as tool result text
     ↓
Web LLM follows the skill's instructions (may call more tools via <tool_call>)
```

No special skills integration needed — skills are just a usage pattern of tool calling. However, **skill reliability varies by provider** based on how well each web LLM follows XML tool call format instructions:

| Tier | Providers | Tool/Skill Reliability |
|---|---|---|
| High | DeepSeek, Qwen, Kimi | Good instruction following; XML output reliable |
| Medium | Claude Web, ChatGPT, GLM, Grok | Generally works; occasional format deviations |
| Low | Gemini Web | DOM simulation + text scraping can mangle XML tags |

Mitigation: the XML parser already has a fallback path — malformed `<tool_call>` JSON is emitted as plain text rather than crashing.

### New Files

```
chrome-extension/src/background/web-providers/
  ├── types.ts              (~80 LOC)   Shared interfaces
  ├── registry.ts           (~400 LOC)  All 11 provider definitions
  ├── auth.ts               (~150 LOC)  chrome.cookies-based auth
  ├── web-llm-bridge.ts     (~300 LOC)  Runtime bridge (tab fetch + streaming)
  ├── content-fetch.ts      (~80 LOC)   Content script for tab-context fetch relay
  └── xml-tag-parser.ts     (~130 LOC)  Extracted from local-llm-bridge.ts (shared)

packages/storage/lib/impl/
  └── web-credentials-storage.ts  (~30 LOC)  Credential storage

packages/config-panels/lib/
  └── web-provider-config.tsx     (~200 LOC)  Settings UI for login/status
```

### Modified Files

| File | Change |
|---|---|
| `chrome-extension/manifest.ts` | Add `'cookies'` to permissions |
| `packages/shared/lib/chat-types.ts` | Add `'web'` to `ModelProvider`; add `webProviderId?: string` to `ChatModel` |
| `packages/storage/lib/impl/chat-db.ts` | Add `webProviderId?: string` to `DbChatModel` |
| `chrome-extension/src/background/agents/stream-bridge.ts` | Add web provider branch to `createStreamFn()` |
| `chrome-extension/src/background/agents/model-adapter.ts` | Add web provider case |
| `chrome-extension/src/background/local-llm-bridge.ts` | Extract XML parser to shared module (refactor, no behavior change) |
| `packages/config-panels/lib/model-config.tsx` | Add web provider to dropdown |

### Implementation Phases

**Phase 1 — Foundation:** Add cookies permission, create types, extract shared XML parser, extend model types.

**Phase 2 — Auth:** Implement chrome.cookies-based auth, credential storage, settings UI.

**Phase 3 — Runtime bridge:** Content-fetch script, web-llm-bridge, wire into stream-bridge.

**Phase 4 — First provider (Claude Web):** End-to-end: auth → streaming → tool calling → skills.

**Phase 5 — Remaining providers:** Add all 11 provider definitions with provider-specific SSE parsing.

**Phase 6 — Polish:** Session expiry detection, error handling, re-auth prompts, tests.
