---
summary: "ChromeClaw's Manifest V3 architecture — service worker, offscreen documents, storage, and data flow."
read_when:
  - Understanding how ChromeClaw is built
  - Learning about the extension architecture
  - Debugging or extending ChromeClaw
title: "Architecture"
---

# Architecture

ChromeClaw is a Manifest V3 Chrome extension built with React, TypeScript, Vite, and Tailwind CSS. All AI processing runs locally in the browser — no external server required.

## High-level data flow

```
Side Panel / Full-Page Chat
  → useLLMStream hook (chrome.runtime.Port)
  → Background Service Worker (stream-handler.ts)
  → Model Adapter (chatModelToPiModel) → pi-mono streamSimple()
  → LLM Provider (OpenAI / Anthropic / Google / OpenRouter / Custom / Local)
  → SSE stream back through Port → UI updates
```

## Core components

### Background Service Worker

The service worker (`chrome-extension/src/background/`) is the heart of ChromeClaw. It handles:

- **LLM streaming** — Manages Port connections, streams responses, handles tool calls
- **Agent system** — Multi-agent loop with steering/follow-up message queues
- **Tool execution** — 31 built-in tools with schema validation and timeout management
- **Memory** — BM25 + vector hybrid search, session journaling, transcript indexing
- **Context compaction** — Sliding-window and LLM-powered summarization
- **Channel routing** — WhatsApp and Telegram message bridge
- **Cron scheduler** — Alarm-based task execution
- **TTS** — Text-to-speech routing (Kokoro local, OpenAI cloud)

<Warning>
MV3 service workers may be terminated after 30 seconds of inactivity. ChromeClaw uses keep-alive mechanisms during long-running LLM streams to prevent this.
</Warning>

### Extension pages

| Page | Purpose |
|------|---------|
| **Side Panel** | Primary chat interface — streaming, artifacts, chat history, voice input/output |
| **Full-Page Chat** | Full-page chat mode (push sidebar) with embedded settings |
| **Options** | Settings page with tabbed configuration panels |
| **Offscreen Channels** | Persistent offscreen document for channel workers, TTS, STT, and local LLM |

### Offscreen document

The offscreen document (`pages/offscreen-channels/`) runs in a separate context and handles:

- **WhatsApp Worker** — Baileys WebSocket client maintaining persistent connection
- **Telegram Worker** — Bot API long-polling (25s timeout)
- **Kokoro TTS Worker** — On-device speech synthesis via ONNX Runtime
- **Whisper STT Worker** — On-device speech-to-text via Transformers.js
- **Local LLM Worker** — On-device inference via Transformers.js (WebGPU/WASM)

Communication between the service worker and offscreen document uses `chrome.runtime.sendMessage`.

## Storage

ChromeClaw uses two storage mechanisms:

### Chrome Storage (local/session)

Settings, tool configurations, channel credentials, and small key-value data.

### IndexedDB via Dexie.js

The `chromeclaw` database (schema version 13) stores:

| Table | Contents |
|-------|----------|
| `chats` | Conversation metadata, token usage, compaction info, channel metadata |
| `messages` | Chat messages with parts (text, reasoning, tool calls, files) |
| `models` | Saved model configurations |
| `artifacts` | Generated documents (text, code, spreadsheets, images) |
| `workspaceFiles` | Context files — predefined and custom, scoped per agent |
| `memoryChunks` | Indexed text chunks with optional embeddings |
| `scheduledTasks` | Persistent cron/scheduler tasks |
| `taskRunLogs` | Scheduled task execution history |
| `embeddingCache` | Cached vector embeddings |

## Model adapter

The model adapter (`agents/model-adapter.ts`) converts ChromeClaw's `ChatModel` type to pi-mono's `Model<Api>` type for provider routing:

- **Direct API providers** — OpenAI, Anthropic, Google, OpenRouter, Azure, custom endpoints
- **Local models** — On-device inference via Transformers.js
- **Web providers** — 11 browser-based services (ChatGPT, Claude, Gemini, etc.) using session cookies

Azure OpenAI endpoints are auto-detected and receive `api-version` query parameter injection.

## Streaming architecture

All LLM communication uses `chrome.runtime.Port` for streaming:

1. **Client** (`useLLMStream` hook) opens a Port connection
2. **Service worker** receives the connection, builds context, and starts the LLM stream
3. **pi-mono** `streamSimple()` handles provider-specific SSE parsing
4. **Events** flow back through the Port: text deltas, reasoning, tool calls, tool results, turn end

The agent loop processes steering messages (user corrections) and follow-up messages (auto-continuations) between turns.

## Tool loop detection

A 5-level detection system prevents infinite tool-calling loops:

1. **Global no-progress** — No new information produced across multiple turns
2. **Known poll tools** — Repeated polling tools (browser, debugger) with stricter thresholds
3. **Repeat detection** — Same tool + arguments called multiple times
4. **Ping-pong detection** — Two tools alternating without progress
5. **Warnings** — Soft alerts before circuit breaker triggers

Severity levels: `none` → `warning` → `critical` → `circuit_breaker`

## Error handling and retry

ChromeClaw implements automatic retry on context overflow:

1. **Attempt 1** — Run normally
2. **Attempt 2** — Truncate oversized tool results
3. **Attempt 3** — Apply full context compaction

Error classification categorizes failures (context overflow, rate limit, auth, network) to choose the appropriate recovery strategy.
