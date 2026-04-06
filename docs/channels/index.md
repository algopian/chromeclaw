---
summary: "Messaging channels overview — connect WhatsApp and Telegram to ChromeClaw for AI-powered chat from any device."
read_when:
  - Setting up messaging channels
  - Understanding how channels route messages to the agent
title: "Channels"
---

# Channels

ChromeClaw can send and receive messages on WhatsApp and Telegram. Channel workers run in a persistent offscreen document; inbound messages are routed through the agent system and replies are sent back via the same channel.

## Supported channels

| Channel | Connection | Polling | Max Message |
|---------|-----------|---------|-------------|
| [WhatsApp](/channels/whatsapp) | QR code pairing via Baileys WebSocket | Push-based (WebSocket) | 4,096 chars |
| [Telegram](/channels/telegram) | Bot token with HTTP long-polling | Long-poll (25s) or alarm-based | 4,096 chars |

## How channels work

```
Inbound message (WhatsApp/Telegram)
  → Offscreen Worker (polls or receives push)
  → Message Bridge (normalize, deduplicate, filter)
  → Agent Handler (build context, run LLM, stream response)
  → Channel Adapter (format reply, send back)
```

### Message bridge

The message bridge normalizes raw platform messages into a common format:

1. **Normalization** — Convert platform-specific updates to `ChannelInboundMessage`
2. **Deduplication** — Track recently processed message IDs (up to 200) to prevent reprocessing on service worker restart
3. **Direction filtering** — Apply `acceptFromMe` / `acceptFromOthers` flags (WhatsApp)
4. **DM-only filter** — Reject group messages (only direct messages are processed)
5. **Allowlist check** — Verify sender against `allowedSenderIds`
6. **Bot command dispatch** — Handle built-in commands (`/start`, `/help`, `/reset`, `/status`)
7. **Agent handler** — Route to LLM for response generation

### Agent handler

The agent handler processes each inbound message:

1. Apply per-chat locking (prevents concurrent processing of the same conversation)
2. Resolve model (channel override or default)
3. Find or create a linked chat session in IndexedDB
4. Start typing indicator
5. Transcribe voice messages (if applicable)
6. Build system prompt with workspace files and tools
7. Run agent loop with streaming callbacks
8. Send response back through the channel
9. Apply TTS if enabled (voice reply as audio message)

### Polling modes

Channels operate in two modes to balance latency and resource usage:

- **Passive mode** — Alarm fires every 30 seconds, short-polls with timeout=0 (lower CPU, higher latency)
- **Active mode** — Offscreen document long-polls with timeout=25s (lower latency, uses offscreen document)

Channels start in passive mode and upgrade to active on first valid message. After 10 minutes of inactivity, they downgrade back to passive.

A watchdog alarm (every 1 minute) ensures the offscreen document is alive and recreates it if needed.

## Configuration

Both channels are configured on the Options page under the **Channels** section:

- **Enable/disable** each channel independently
- **Credentials** — Bot token (Telegram) or QR code session (WhatsApp)
- **Allowed senders** — Allowlist of sender IDs that can interact with the agent
- **Model override** — Use a specific model for channel messages (optional)

## Built-in commands

Both channels support slash commands:

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | Show available commands |
| `/reset` | Start a new conversation |
| `/status` | Show current model and usage info |
| `/tts` | Voice reply settings (Telegram only) |

## Voice messages

Both channels support voice messages:

- **Inbound**: Voice messages are transcribed using the configured STT engine (Whisper local or OpenAI cloud)
- **Outbound**: When TTS is enabled, responses are sent as voice/audio messages
  - Telegram sends voice bubbles or audio files
  - WhatsApp sends PTT (Push-to-Talk) voice messages
