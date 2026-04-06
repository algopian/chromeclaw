---
summary: "OpenAI provider — GPT-4o, o-series, and Azure OpenAI configuration."
read_when:
  - Setting up OpenAI models
  - Configuring Azure OpenAI
  - Understanding API type auto-detection
title: "OpenAI"
---

# OpenAI

ChromeClaw supports OpenAI models via the standard API and Azure OpenAI endpoints.

## Setup

1. Open the **Options** page → **Models**
2. Click **Add Model**
3. Select provider: **OpenAI**
4. Enter your OpenAI API key
5. Choose a model (e.g., `gpt-4o`, `o3`, `o4-mini`)

The base URL defaults to `https://api.openai.com/v1`.

## Supported models

ChromeClaw works with any OpenAI model, including:

- **GPT-4o** — Multimodal, fast, tool-capable
- **GPT-4 Turbo** — High-quality with large context
- **o3, o4-mini** — Reasoning models with thinking output
- **GPT-3.5 Turbo** — Fast and cost-effective

## API type auto-detection

ChromeClaw auto-detects the appropriate API format:

- **GPT-5, o3, o4 series** → OpenAI Responses API (`openai-responses`)
- **All other models** → Chat Completions API (`openai-completions`)

You can override this in the model configuration if needed.

## Reasoning models

OpenAI's o-series models (o3, o4-mini) support reasoning output. ChromeClaw displays this as collapsible thinking blocks in the chat UI.

## Tool calling

All OpenAI models with function calling support can use ChromeClaw's 31 built-in tools. Enable `supportsTools` in the model configuration (enabled by default for supported models).

## Azure OpenAI

ChromeClaw auto-detects Azure OpenAI endpoints from the URL pattern and injects the required `api-version` query parameter.

### Setup

1. Add a model with provider: **OpenAI**
2. Set the Base URL to your Azure endpoint:
   ```
   https://your-resource.openai.azure.com/openai/deployments/your-deployment
   ```
3. Enter your Azure API key
4. ChromeClaw automatically adds `api-version=2025-04-01-preview` (or configured version)

### Azure-specific settings

| Setting | Description |
|---------|-------------|
| `azureApiVersion` | Azure API version string (auto-configured) |

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| API Key | — | Your OpenAI API key |
| Base URL | `https://api.openai.com/v1` | API endpoint |
| API Type | Auto-detected | `openai-completions` or `openai-responses` |
| Supports Tools | `true` | Enable tool calling |
| Supports Reasoning | Model-dependent | Show thinking output |
| Context Window | Model-dependent | Auto-detected from model name |
