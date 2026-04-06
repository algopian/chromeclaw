---
summary: "Overview of ChromeClaw — an AI agent Chrome extension with multi-provider LLM support, channels, voice, memory, and browser automation."
read_when:
  - First visiting the ChromeClaw documentation
  - Looking for a high-level overview of what ChromeClaw does
title: "ChromeClaw"
---

# ChromeClaw

A lightweight AI agent running entirely in the Chrome browser sandbox — with multi-provider LLM support, messaging channels (WhatsApp, Telegram), voice (TTS/STT), memory, agents, and browser automation.

Inspired by the [OpenClaw](https://github.com/openclaw/openclaw) project, ChromeClaw delivers a self-contained alternative that runs entirely in the browser's side panel. No server, no Docker, no CLI — just install the extension, add an API key, and start chatting.

## Key capabilities

- **Multi-provider LLM support** — OpenAI, Anthropic, Google, OpenRouter, custom endpoints, and local on-device models
- **Streaming responses** — Real-time text and reasoning deltas with markdown rendering
- **Messaging channels** — WhatsApp (Baileys WebSocket) and Telegram (Bot API long-polling)
- **Voice** — TTS (Kokoro local ONNX + OpenAI cloud), STT (Whisper local + OpenAI cloud)
- **Memory system** — BM25 full-text search + optional vector embeddings with MMR re-ranking and temporal decay
- **Multi-agent system** — Named agents with per-agent models, tools, workspace files, and custom JS tools
- **31 built-in tools** — Web search, documents, browser automation (CDP), Google services, deep research, and more
- **Browser automation** — Chrome DevTools Protocol with DOM snapshots, click/type, screenshots, JS evaluation
- **Context compaction** — Sliding-window + LLM summarization when approaching token limits
- **Cron/scheduler** — Alarm-based one-shot, interval, and cron-expression tasks
- **Custom tools** — Register workspace JS files as callable LLM tools with `@tool` metadata
- **Skills system** — Configurable prompt templates with variable substitution
- **Artifacts** — Create and view text, code, spreadsheets, and images
- **Session journaling** — Auto-converts chat transcripts to durable memory entries

## Quick start

<Steps>
  <Step title="Install the extension">
    Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/chromeclaw-your-own-perso/lnahopfgnfhcfchffbckmbbkopcmojme) or [Firefox Add-ons](https://addons.mozilla.org/addon/chromeclaw/).
  </Step>
  <Step title="Add an API key">
    Open the Options page, add your API key for any supported provider, and select a model.
  </Step>
  <Step title="Start chatting">
    Open any page and click the ChromeClaw icon to open the side panel. No login required.
  </Step>
</Steps>

## How it works

ChromeClaw runs as a Manifest V3 Chrome extension. The background service worker handles all LLM communication, tool execution, memory management, and channel message routing. The side panel provides the primary chat interface.

```
Side Panel / Full-Page Chat
  → useLLMStream hook (chrome.runtime.Port)
  → Background Service Worker
  → Model Adapter → pi-mono streamSimple()
  → LLM Provider (OpenAI / Anthropic / Google / OpenRouter / Custom / Local)
  → SSE stream back through Port → UI updates
```

All data is stored locally in IndexedDB and Chrome Storage — no external servers, no telemetry, no accounts.

## Explore the docs

<CardGroup cols={2}>
  <Card title="Getting Started" href="/start/getting-started" icon="rocket">
    Set up your first model and start chatting
  </Card>
  <Card title="Tools" href="/tools/index" icon="wrench">
    Explore the 31 built-in tools
  </Card>
  <Card title="Channels" href="/channels/index" icon="message-circle">
    Connect WhatsApp and Telegram
  </Card>
  <Card title="Memory" href="/concepts/memory" icon="brain">
    How long-term memory works
  </Card>
  <Card title="Agents" href="/agents/index" icon="users">
    Multi-agent system with custom tools
  </Card>
  <Card title="Providers" href="/providers/index" icon="cloud">
    Configure LLM providers
  </Card>
</CardGroup>
