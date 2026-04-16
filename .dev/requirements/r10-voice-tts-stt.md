# R10: Voice — TTS & STT — `chrome-extension/src/background/tts/` + `background/media-understanding/`

## Scope
Text-to-speech (Kokoro local ONNX + OpenAI cloud) and speech-to-text (Whisper local via Transformers.js + OpenAI cloud Whisper) with auto-mode, streaming chunked synthesis, and channel voice message support.

## Key Files
| File/Package | Role |
|---|---|
| `chrome-extension/src/background/tts/` | TTS routing — Kokoro and OpenAI engines |
| `chrome-extension/src/background/media-understanding/` | STT routing — Whisper local and OpenAI cloud |
| `pages/offscreen-channels/` | Offscreen document hosting Kokoro TTS Worker + Whisper STT Worker |
| `packages/config-panels/` | Options → Settings → General (voice config) |

## Architecture
Both TTS and STT run in the offscreen document's Web Workers to avoid blocking the service worker.

**TTS engines:**
- **Kokoro (local)**: Kokoro-82M ONNX model. Per-sentence streaming chunking. Output: OGG Opus (preferred) → WAV fallback. Configurable voice (`af_heart` default) and speed (1.0 default).
- **OpenAI (cloud)**: `/audio/speech` endpoint. Opus audio at 24kHz. Single synthesis call (no streaming). Model `tts-1`, voice `nova` default. Compatible with any OpenAI-compatible TTS API.

**STT engines:**
- **Whisper (local)**: Whisper tiny/base/small ONNX via Transformers.js. Audio resampled to 16kHz mono PCM. Model weights cached after first download. Fully offline.
- **OpenAI Whisper (cloud)**: `/audio/transcriptions` endpoint. Auto-detects audio format (OGG → MP3 → WebM). Language specification supported.

**Engine selection (STT):**
| Mode | Behavior |
|---|---|
| `auto` | OpenAI if API key configured, else local Whisper |
| `openai` | Always cloud |
| `transformers` | Always local |
| `off` | Disabled |

**Auto-mode (TTS):**
| Mode | Behavior |
|---|---|
| `off` | Text only |
| `always` | Every response spoken |
| `inbound` | Only speak responses triggered by voice input or channel messages |

**Data flow (side panel):**
```
Mic button → record audio → STT engine → transcript as text message
  → agent processes → response text → TTS engine → audio playback
```

**Data flow (channels):**
```
Voice message (Telegram/WhatsApp)
  → download/decrypt audio → STT transcription → agent processes
  → TTS synthesis → send as voice bubble (Telegram sendVoice) or PTT (WhatsApp)
```

## Key Types/Interfaces
```typescript
interface LLMTtsAudio {
  type: 'LLM_TTS_AUDIO';
  chatId: string;
  audioBase64: string;
  contentType: string;
  provider: string;
  chunkIndex?: number;
  isLastChunk?: boolean;
}
```

## Behavior
- **TTS timeouts**: Base 60s + 30s per 500 chars. Max 300s. Example: 2500 chars → 210s.
- **Text preprocessing**: Code blocks removed, URLs stripped, markdown formatting removed before synthesis.
- **Long response handling**: Optional LLM summarization to fit within configurable `maxChars` limit.
- **Kokoro streaming modes**: Per-sentence (each sentence independent), batched (first sentence immediate, rest as one blob), single (entire text at once).
- **Channel voice**: Telegram sends as voice bubble (`sendVoice`) or audio file (`sendAudio`). WhatsApp sends as PTT via offscreen document.

## Dependencies
- Offscreen document (Web Workers for Kokoro ONNX + Whisper Transformers.js)
- `chrome.runtime.sendMessage` (service worker ↔ offscreen communication)
- OpenAI API (cloud TTS/STT)
- Channel infrastructure (Telegram Bot API, WhatsApp Baileys)

## Gate
`pnpm build && pnpm quality` — exit 0.
