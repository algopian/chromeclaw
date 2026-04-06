---
summary: "LLM provider overview — OpenAI, Anthropic, Google, OpenRouter, custom endpoints, local models, and web providers."
read_when:
  - Choosing an LLM provider
  - Understanding supported providers
  - Comparing provider capabilities
title: "Providers Overview"
---

# Providers

ChromeClaw supports multiple LLM providers. Add your API key on the Options page, select a model, and start chatting. You can configure multiple models from different providers and switch between them freely.

## Supported providers

| Provider | API Key | Tools | Reasoning | Notes |
|----------|:---:|:---:|:---:|-------|
| [OpenAI](/providers/openai) | Yes | Yes | Yes (o-series) | GPT-4o, o-series, GPT-4, GPT-3.5 |
| [Anthropic](/providers/anthropic) | Yes | Yes | Yes | Claude 4, Claude 3.5, Claude 3 |
| [Google](/providers/google) | Yes | Yes | Yes | Gemini 3.1, Gemini 3, Gemini 2.5, Gemini 2.0, Gemini 1.5 |
| [OpenRouter](/providers/openrouter) | Yes | Yes | Varies | Access 100+ models via single API key |
| [Custom endpoint](/providers/custom) | Yes | Varies | Varies | Any OpenAI-compatible API |
| [Local (Transformers.js)](/providers/local-llm) | No | No | No | On-device inference via WebGPU/WASM |

## Web providers (experimental)

ChromeClaw also supports 11 browser-based providers that use your existing web session cookies — no API key required:

- ChatGPT Web, Claude Web, Gemini Web
- DeepSeek Web, Kimi Web, Qwen Web, Qwen CN Web
- GLM Web, GLM Intl Web, Doubao Web, Rakuten Web

Web providers use `chrome.scripting.executeScript` in MAIN world to make requests through the browser, inheriting your session authentication.

## Model configuration

Each model has these settings:

| Field | Description |
|-------|-------------|
| **Name** | Display name for the model |
| **Provider** | Which provider to use |
| **API Key** | Provider API key |
| **Base URL** | API endpoint (auto-filled for standard providers) |
| **API Type** | Completions, Responses, or Codex Responses |
| **Context Window** | Token limit (auto-detected or manual override) |
| **Supports Tools** | Whether to enable tool calling |
| **Supports Reasoning** | Whether the model outputs thinking/reasoning |
| **Tool Timeout** | Per-tool execution timeout in seconds |
| **Routing Mode** | Direct routing (skip proxy) |

## API types

ChromeClaw supports multiple OpenAI API formats:

- **openai-completions** — Standard `/chat/completions` endpoint (default for most models)
- **openai-responses** — OpenAI Responses API (auto-detected for GPT-5, o3, o4 series)
- **openai-codex-responses** — Codex-specific responses format
- **azure-openai-responses** — Azure OpenAI with `api-version` parameter

## Context window

The context window is resolved in this order:

1. **Explicit override** — Manual value set in model config
2. **Local default** — Built-in lookup table for known models
3. **Provider default** — Fallback from the provider

Azure endpoints are auto-detected from the URL and receive special handling for the `api-version` query parameter.
