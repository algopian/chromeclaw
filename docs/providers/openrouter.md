---
summary: "OpenRouter provider — access 100+ models from multiple providers via a single API key."
read_when:
  - Setting up OpenRouter
  - Accessing multiple model providers through one key
title: "OpenRouter"
---

# OpenRouter

[OpenRouter](https://openrouter.ai) provides access to 100+ models from multiple providers (OpenAI, Anthropic, Google, Meta, Mistral, and more) through a single API key and unified endpoint.

## Setup

1. Open the **Options** page → **Models**
2. Click **Add Model**
3. Select provider: **OpenRouter**
4. Enter your OpenRouter API key
5. Enter the model ID (e.g., `anthropic/claude-sonnet-4-5-20250514`, `openai/gpt-4o`)

The base URL defaults to `https://openrouter.ai/api/v1`.

## Why use OpenRouter

- **Single API key** for all providers
- **Automatic fallbacks** between providers
- **Usage tracking** across all models
- **Access to models** you might not have direct API access to

## Model IDs

OpenRouter uses the format `provider/model-name`:

```
openai/gpt-4o
anthropic/claude-sonnet-4-5-20250514
google/gemini-2.0-flash
meta-llama/llama-3.3-70b-instruct
mistralai/mistral-large
```

Find the full model list at [openrouter.ai/models](https://openrouter.ai/models).

## Features

Tool calling and reasoning support depend on the underlying model. Configure `supportsTools` and `supportsReasoning` in the model settings based on the specific model you're using.

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| API Key | — | Your OpenRouter API key |
| Base URL | `https://openrouter.ai/api/v1` | API endpoint |
| Supports Tools | Model-dependent | Enable tool calling |
| Supports Reasoning | Model-dependent | Show thinking output |
| Context Window | — | Set manually or auto-detected |
