# R7: Channels — `chrome-extension/src/background/channels/`

## Scope
Telegram and WhatsApp messaging bridges. Inbound messages routed through the agent system; replies sent back via the same channel. Workers run in the offscreen document.

## Key Files
| File/Package | Role |
|---|---|
| `chrome-extension/src/background/channels/` | Message bridge, agent handler, channel adapters |
| `pages/offscreen-channels/` | Offscreen document — Telegram/WhatsApp workers, TTS, STT, local LLM |
| `packages/baileys/` | WhatsApp (Baileys) WebSocket integration |
| `packages/config-panels/` | Channel configuration UI (Channels settings tab) |

## Architecture
```
Inbound message (WhatsApp / Telegram)
  → Offscreen Worker (push or poll)
  → Message Bridge (normalize, deduplicate, filter)
  → Agent Handler (build context, run LLM, stream response)
  → Channel Adapter (format reply, send back)
```

**Message bridge pipeline**:
1. Normalization — platform-specific updates → `ChannelInboundMessage`
2. Deduplication — track recent 200 message IDs (prevents reprocessing on SW restart)
3. Direction filtering — `acceptFromMe` / `acceptFromOthers` flags (WhatsApp)
4. DM-only filter — reject group messages
5. Allowlist check — verify sender against `allowedSenderIds`
6. Bot command dispatch — `/start`, `/help`, `/reset`, `/status`, `/tts`
7. Agent handler — route to LLM

**Polling modes** (adaptive):
- **Passive** — Alarm every 30s, short-poll timeout=0 (lower CPU, higher latency)
- **Active** — Offscreen long-poll timeout=25s (lower latency)
- Upgrade to active on first valid message; downgrade after 10 min inactivity
- Watchdog alarm (every 1 min) ensures offscreen document alive, recreates if needed

## Key Types/Interfaces
```typescript
interface ChannelMeta {
  channelId: string;   // 'telegram' | 'whatsapp'
  chatId: string;
  senderId: string;
  senderName?: string;
  senderUsername?: string;
  extra?: Record<string, unknown>;
}

interface Attachment { name: string; url: string; contentType: string }
```

## Behavior

| Channel | Connection | Polling | Max Message |
|---|---|---|---|
| WhatsApp | QR code pairing via Baileys WebSocket | Push-based (WebSocket) | 4,096 chars |
| Telegram | Bot token with HTTP long-polling | Long-poll 25s or alarm-based | 4,096 chars |

- **Agent handler**: Per-chat locking (no concurrent processing) → resolve model (channel override or default) → find/create linked chat in IndexedDB → typing indicator → transcribe voice (if applicable) → build system prompt → run agent loop → send response → apply TTS if enabled
- **Voice messages**: Inbound transcribed via Whisper (local) or OpenAI cloud STT. Outbound sent as voice/audio messages when TTS enabled.
- **Built-in commands**: `/start`, `/help`, `/reset` (new conversation), `/status` (model + usage), `/tts` (Telegram only)
- Communication between SW and offscreen via `chrome.runtime.sendMessage`

## Dependencies
- Agent system (R3) — agent loop for response generation
- Workspace files (R8) — system prompt context
- Tool system (R4) — tools available in channel responses
- Memory system (R5) — memory access during channel conversations
- `packages/baileys/` — WhatsApp WebSocket client
- `chrome.offscreen` API — persistent offscreen document
- `chrome.alarms` API — polling and watchdog

## Gate
`pnpm build && pnpm quality` — exit 0.
