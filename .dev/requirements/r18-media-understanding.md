# R18: Media Understanding — `chrome-extension/src/background/media-understanding/`

## Scope
Speech-to-text and media transcription via offscreen document Web Workers. Supports Whisper local (Transformers.js ONNX) and OpenAI cloud Whisper. Handles voice input from side panel microphone and voice messages from Telegram/WhatsApp channels.

## Key Files
| File/Package | Role |
|---|---|
| `chrome-extension/src/background/media-understanding/` | STT routing and transcription orchestration |
| `pages/offscreen-channels/` | Offscreen document hosting Whisper STT Web Worker |
| `packages/storage/` | STT engine configuration persistence |

## Architecture
Media understanding runs transcription in the offscreen document to avoid blocking the MV3 service worker (which has no audio/ML API access).

**Processing pipeline:**
```
Audio input (mic recording or channel voice message)
  → Background SW receives audio
  → Route to STT engine based on config
  → Local: chrome.runtime.sendMessage → offscreen → Whisper Worker
  → Cloud: HTTP POST to OpenAI /audio/transcriptions
  → Transcript text returned to background SW
  → Injected as text message into chat
```

**Offscreen document workers:**
The offscreen document (`pages/offscreen-channels/`) hosts multiple workers:
- **Whisper STT Worker** — Transformers.js ONNX inference
- **Kokoro TTS Worker** — Speech synthesis (see R10)
- **WhatsApp Worker** — Baileys WebSocket
- **Telegram Worker** — Bot API polling
- **Local LLM Worker** — Transformers.js inference

Communication: `chrome.runtime.sendMessage` between service worker and offscreen document.

**Local Whisper details:**
- Models: Whisper tiny, base, small (ONNX format)
- Audio preprocessing: Resampled to 16kHz mono PCM
- First use downloads and caches model weights in browser
- Multi-language support
- Fully offline after initial download

**Cloud Whisper details:**
- Endpoint: `/audio/transcriptions`
- Auto-detects audio format: OGG → MP3 → WebM (based on MIME type)
- Language specification for better accuracy
- Compatible with any OpenAI-compatible transcription API

**Engine selection:**
| Mode | Behavior |
|---|---|
| `auto` | OpenAI if API key present, else local Whisper |
| `openai` | Always cloud |
| `transformers` | Always local |
| `off` | STT disabled |

## Key Types/Interfaces
```typescript
// STT engine configuration
type SttEngine = 'auto' | 'openai' | 'transformers' | 'off';

// Whisper model options
type WhisperModel = 'whisper-tiny' | 'whisper-base' | 'whisper-small';
```

## Behavior
- **Side panel**: Microphone button → record → transcribe → insert as text message.
- **Telegram voice**: Audio downloaded via Bot API (`getFile` + `downloadFile`) → transcribed → transcript replaces audio in message sent to agent.
- **WhatsApp voice**: Audio decrypted from WhatsApp message → transcribed → transcript replaces audio content.
- **Model caching**: Local Whisper model weights downloaded once, cached in browser for subsequent uses.
- **Audio resampling**: All audio normalized to 16kHz mono PCM before local inference.
- **Fallback**: `auto` mode gracefully falls back to local if cloud API key is not configured.

## Dependencies
- Offscreen document (`pages/offscreen-channels/`)
- Transformers.js (local ONNX inference)
- OpenAI Whisper API (cloud transcription)
- `chrome.runtime.sendMessage` (SW ↔ offscreen communication)
- Channel infrastructure (Telegram Bot API, WhatsApp Baileys) for voice message sources

## Gate
`pnpm build && pnpm quality` — exit 0.
