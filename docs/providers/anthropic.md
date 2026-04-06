---
summary: "Anthropic provider — Claude models with tool calling and reasoning support."
read_when:
  - Setting up Anthropic Claude models
  - Configuring Claude API access
title: "Anthropic"
---

# Anthropic

ChromeClaw supports Anthropic's Claude models via the Messages API.

## Setup

1. Open the **Options** page → **Models**
2. Click **Add Model**
3. Select provider: **Anthropic**
4. Enter your Anthropic API key
5. Choose a model (e.g., `claude-sonnet-4-5-20250514`)

The base URL defaults to `https://api.anthropic.com`.

## Supported models

ChromeClaw works with all Claude models:

- **Claude 4 Opus / Sonnet** — Latest generation
- **Claude 3.5 Sonnet / Haiku** — Fast and capable
- **Claude 3 Opus / Sonnet / Haiku** — Previous generation

## Features

### Tool calling

Claude models support tool calling. ChromeClaw's 31 built-in tools are available when `supportsTools` is enabled.

### Reasoning

Claude models that support extended thinking display reasoning output as collapsible thinking blocks in the chat UI.

### Streaming

All responses are streamed in real time via the Anthropic Messages API with SSE.

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| API Key | — | Your Anthropic API key |
| Base URL | `https://api.anthropic.com` | API endpoint |
| Supports Tools | `true` | Enable tool calling |
| Supports Reasoning | Model-dependent | Show thinking output |
| Context Window | Model-dependent | Auto-detected from model name |
