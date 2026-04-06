---
summary: "Local LLM — on-device inference via Transformers.js with WebGPU or WASM, no API key required."
read_when:
  - Running models locally in the browser
  - Setting up on-device inference
  - Understanding WebGPU and WASM model support
title: "Local LLM"
---

# Local LLM

ChromeClaw supports on-device inference via Transformers.js, running models entirely in the browser using WebGPU or WASM. No API key or internet connection required for inference.

## Setup

1. Enable WebGPU models by setting `CEB_ENABLE_WEBGPU_MODELS=true` in your `.env` file (or the build must include this flag)
2. Open the **Options** page → **Models**
3. Click **Add Model**
4. Select provider: **Local**
5. Choose a Transformers.js-compatible model

## How it works

Local models run in a dedicated Web Worker inside the offscreen document:

1. The model is downloaded and cached in the browser
2. Inference runs on WebGPU (GPU-accelerated) or WASM (CPU fallback)
3. Responses are streamed back to the service worker via message passing

The offscreen document maintains the model worker, so the model stays loaded between conversations.

## Limitations

- **Performance** — Inference speed depends on your hardware (GPU, RAM)
- **Model size** — Limited by available browser memory
- **No tool calling** — Local models don't support function calling
- **No reasoning** — Thinking/reasoning output not supported
- **Download required** — First use requires downloading the model weights

<Warning>
Local LLM performance varies significantly by hardware. Models may be slow on devices without a compatible GPU.
</Warning>

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| Provider | `local` | Local inference |
| Model | — | Transformers.js model identifier |
| Supports Tools | `false` | Not supported |
| Supports Reasoning | `false` | Not supported |
| Context Window | Model-dependent | Set based on model capabilities |

## Requirements

- WebGPU-capable browser (Chrome 113+, or WASM fallback)
- Sufficient RAM for the model weights
- `CEB_ENABLE_WEBGPU_MODELS=true` build flag
