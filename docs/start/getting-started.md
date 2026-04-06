---
summary: "Quick start guide for ChromeClaw — install, configure a model, and start chatting."
read_when:
  - Setting up ChromeClaw for the first time
  - Looking for a quick start guide
title: "Getting Started"
---

# Getting Started

ChromeClaw is ready to use in minutes. Install the extension, add an API key, and start chatting — no server or login required.

## Prerequisites

- Chrome 120+ or Firefox 128+
- An API key from any supported provider (OpenAI, Anthropic, Google, OpenRouter, or any OpenAI-compatible endpoint)

## Step 1: Install the extension

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/chromeclaw-your-own-perso/lnahopfgnfhcfchffbckmbbkopcmojme) or [Firefox Add-ons](https://addons.mozilla.org/addon/chromeclaw/).

For development builds, see [Installation](/start/installation).

## Step 2: Configure a model

1. Click the ChromeClaw icon in your browser toolbar
2. On first run, you'll see the **First Run Setup** screen
3. Select a provider (e.g., OpenAI)
4. Enter your API key
5. Choose a model (e.g., `gpt-4o`)
6. Click **Save**

You can add multiple models from different providers. Switch between them at any time from the chat interface or the Options page.

## Step 3: Start chatting

Open any web page and click the ChromeClaw icon to open the side panel. Type a message and press Enter.

ChromeClaw streams responses in real time with markdown rendering. Models that support reasoning (like OpenAI o-series or Anthropic Claude) show collapsible thinking output.

## What's next

<CardGroup cols={2}>
  <Card title="Workspace Files" href="/concepts/workspace-files" icon="file-text">
    Add persistent context to every conversation
  </Card>
  <Card title="Tools" href="/tools/index" icon="wrench">
    Enable web search, browser automation, and more
  </Card>
  <Card title="Channels" href="/channels/index" icon="message-circle">
    Connect WhatsApp or Telegram
  </Card>
  <Card title="Agents" href="/agents/index" icon="users">
    Create named agents with custom personalities
  </Card>
</CardGroup>

## Managing models

Open the **Options** page (right-click the extension icon → Options, or use the gear icon in the side panel) to:

- Add, edit, or remove models
- Set default models per agent
- Configure API keys and base URLs
- Enable local on-device models (WebGPU/WASM)

### Supported providers

| Provider | API Key Required | Notes |
|----------|:---:|-------|
| OpenAI | Yes | GPT-4o, o-series, and more |
| Anthropic | Yes | Claude models |
| Google | Yes | Gemini models |
| OpenRouter | Yes | Access 100+ models via single key |
| Custom endpoint | Yes | Any OpenAI-compatible API |
| Local (Transformers.js) | No | On-device inference via WebGPU/WASM |

## Settings overview

The Options page is organized into three tab groups:

- **Control** — Channels, Cron Jobs, Sessions, Usage
- **Agent** — Agents, Tools, Skills
- **Settings** — General, Models, Actions, Logs
