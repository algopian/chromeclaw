---
summary: "Speech-to-text engines — Whisper local (Transformers.js) and OpenAI cloud transcription."
read_when:
  - Configuring speech-to-text
  - Understanding voice input options
  - Choosing between local and cloud STT
title: "Speech-to-Text (STT)"
---

# Speech-to-Text (STT)

ChromeClaw supports two STT engines for transcribing voice input and voice messages from channels.

## Whisper (local)

On-device transcription using Whisper ONNX models via Transformers.js. No API key required.

### Features

- **Models**: Whisper tiny, base, and small
- **Runs in**: Offscreen document Web Worker
- **Audio processing**: Resampled to 16kHz mono PCM
- **Language selection**: Supports multiple languages
- **No API calls**: Fully offline transcription

### First use

The first time you use local STT, the Whisper model weights are downloaded and cached in the browser. Subsequent uses load from cache.

---

## OpenAI Whisper (cloud)

Cloud-based transcription via the OpenAI Whisper API.

### Features

- **Endpoint**: `/audio/transcriptions`
- **Format detection**: Auto-detects audio format (OGG → MP3 → WebM based on MIME type)
- **Language support**: Supports language specification for better accuracy
- **Compatible**: Works with any OpenAI-compatible transcription API

---

## Engine selection

ChromeClaw auto-detects the best engine based on configuration:

| Mode | Behavior |
|------|----------|
| `auto` | Use OpenAI if API key is configured, otherwise fall back to local Whisper |
| `openai` | Always use OpenAI cloud |
| `transformers` | Always use local Whisper |
| `off` | Disable STT |

## Usage

### Side panel

Click the microphone button in the chat input to record audio. The recording is transcribed and inserted as a text message.

### Channel voice messages

Voice messages received via WhatsApp or Telegram are automatically transcribed:

- **Telegram**: Voice audio downloaded via Bot API (`getFile` + `downloadFile`)
- **WhatsApp**: Voice audio decrypted from the WhatsApp message
- The transcript replaces the audio content in the message sent to the agent
