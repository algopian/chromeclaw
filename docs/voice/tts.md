---
summary: "Text-to-speech engines — Kokoro local ONNX synthesis and OpenAI cloud TTS with streaming support."
read_when:
  - Configuring text-to-speech
  - Choosing between local and cloud TTS
  - Understanding streaming TTS
title: "Text-to-Speech (TTS)"
---

# Text-to-Speech (TTS)

ChromeClaw supports two TTS engines: Kokoro for on-device synthesis and OpenAI for cloud-based synthesis.

## Kokoro (local)

On-device speech synthesis using the Kokoro-82M ONNX model. No API key or internet connection required.

### Features

- **Model**: Kokoro-82M ONNX
- **Runs in**: Offscreen document Web Worker
- **Streaming**: Per-sentence chunking — each sentence is synthesized and played as it's ready
- **Batched streaming**: First chunk delivered immediately, remainder as a single blob
- **Output formats**: OGG Opus (preferred, voice-compatible) → WAV fallback
- **Configurable**: Voice selection and speed

### Default settings

| Setting | Default |
|---------|---------|
| Model | `kokoro-82m` |
| Voice | `af_bella` |
| Speed | 1.0 |

### Streaming modes

Kokoro supports adaptive chunking for streaming:

1. **Per-sentence** — Text is split at sentence boundaries; each sentence is synthesized independently
2. **Batched** — First sentence synthesized and returned immediately; remaining text synthesized as one batch
3. **Single** — Entire text synthesized at once

---

## OpenAI (cloud)

Cloud-based synthesis via the OpenAI TTS API. Requires an OpenAI API key.

### Features

- **Endpoint**: `/audio/speech`
- **Output**: Opus audio (24kHz sample rate)
- **No streaming**: Single synthesis call (entire text at once)
- **Compatible**: Works with any OpenAI-compatible TTS API

### Default settings

| Setting | Default |
|---------|---------|
| Model | `tts-1-hd` |
| Voice | `shimmer` |

### Custom endpoints

You can point the OpenAI TTS engine at any compatible endpoint by configuring the base URL and API key.

---

## Timeouts

TTS synthesis has adaptive timeouts:

- **Base**: 10 seconds
- **Scale**: +1 second per 1,000 characters of input
- Example: A 5,000-character response has a 15-second timeout

## Text preprocessing

Before synthesis, text is cleaned for better audio output:

- Code blocks are removed
- URLs are stripped
- Markdown formatting is removed

For long responses, ChromeClaw can optionally summarize the text via the LLM to fit within a configurable character limit (`maxChars`).

## Channel voice messages

When TTS is enabled for channel responses:

- **Telegram**: Audio sent as voice bubble (`sendVoice`) or audio file (`sendAudio`)
- **WhatsApp**: Audio sent as PTT (Push-to-Talk) voice message via the offscreen document
