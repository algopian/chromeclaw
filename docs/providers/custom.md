---
summary: "Custom endpoint provider — connect any OpenAI-compatible API (vLLM, Ollama, LM Studio, text-generation-webui, etc.)."
read_when:
  - Connecting a custom or self-hosted LLM endpoint
  - Using OpenAI-compatible APIs
  - Setting up Ollama, vLLM, or LM Studio
title: "Custom Endpoint"
---

# Custom Endpoint

ChromeClaw can connect to any OpenAI-compatible API endpoint — including self-hosted models via vLLM, Ollama, LM Studio, text-generation-webui, and other OpenAI-compatible servers.

## Setup

1. Open the **Options** page → **Models**
2. Click **Add Model**
3. Select provider: **Custom**
4. Enter the base URL of your endpoint
5. Enter the API key (if required)
6. Enter the model name

## Common endpoints

### Ollama

```
Base URL: http://localhost:11434/v1
Model: llama3.3
API Key: (leave empty or any string)
```

### vLLM

```
Base URL: http://localhost:8000/v1
Model: your-model-name
API Key: (your vLLM API key if configured)
```

### LM Studio

```
Base URL: http://localhost:1234/v1
Model: your-model-name
API Key: (leave empty)
```

### text-generation-webui

```
Base URL: http://localhost:5000/v1
Model: your-model-name
API Key: (leave empty)
```

## Compatibility notes

ChromeClaw uses the OpenAI Chat Completions API format (`/chat/completions`). Your endpoint must support:

- POST to `/chat/completions`
- SSE streaming (`stream: true`)
- Standard message format (`role`, `content`)

### Developer role

Some non-OpenAI endpoints (GLM, vLLM, certain proxies) don't support the `developer` role. ChromeClaw auto-detects this from the URL and injects `supportsDeveloperRole: false` when needed.

### Tool calling

If your endpoint supports OpenAI-compatible function calling, enable `supportsTools` in the model configuration. Otherwise, disable it to prevent errors.

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| API Key | — | API key (if required by your endpoint) |
| Base URL | — | Your endpoint URL |
| Model | — | Model name/ID |
| API Type | `openai-completions` | Use completions format |
| Supports Tools | `false` | Enable if your endpoint supports function calling |
| Supports Reasoning | `false` | Enable if your model outputs thinking tokens |
| Context Window | — | Set manually based on your model |
