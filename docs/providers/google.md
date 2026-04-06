---
summary: "Google provider — Gemini models with tool calling and reasoning support."
read_when:
  - Setting up Google Gemini models
  - Configuring Google AI API access
title: "Google"
---

# Google

ChromeClaw supports Google's Gemini models via the Google AI API.

## Setup

1. Open the **Options** page → **Models**
2. Click **Add Model**
3. Select provider: **Google**
4. Enter your Google AI API key
5. Choose a model (e.g., `gemini-2.5-pro`, `gemini-2.0-flash`)

## Supported models

- **Gemini 3.1 Pro** — Latest generation with 1M context
- **Gemini 3 Pro / Flash** — Current generation
- **Gemini 2.5 Pro / Flash** — With thinking support
- **Gemini 2.0 Flash / Flash Lite** — Fast multimodal models
- **Gemini 1.5 Pro / Flash** — Previous generation with large context windows

## Features

### Tool calling

Gemini models support tool calling via the Google AI function calling API. ChromeClaw's tools are available when `supportsTools` is enabled.

### Reasoning

Gemini 2.5 models support thinking output, displayed as collapsible blocks in the chat UI.

### Large context

Gemini 1.5 and 2.0 models support up to 1M+ tokens of context, which ChromeClaw uses for longer conversations before compaction is needed.

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| API Key | — | Your Google AI API key |
| Supports Tools | `true` | Enable tool calling |
| Supports Reasoning | Model-dependent | Show thinking output |
| Context Window | Model-dependent | Auto-detected from model name |
