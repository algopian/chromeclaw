---
summary: "Telegram channel — Bot API with long-polling, draft streaming, typing indicators, reactions, and voice messages."
read_when:
  - Setting up Telegram bot integration
  - Understanding Telegram message handling
  - Configuring Telegram bot commands
title: "Telegram"
---

# Telegram

ChromeClaw connects to Telegram via the Bot API with HTTP long-polling. It supports real-time draft streaming (editing messages as the LLM generates), typing indicators, message reactions, and voice messages.

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/botfather) and copy the bot token
2. Open the **Options** page → **Channels** → **Telegram**
3. Enable the Telegram channel
4. Paste your bot token — ChromeClaw validates it by calling the `getMe` API
5. Add allowed sender IDs to the allowlist

### Getting sender IDs

Send a message to your bot, then check the Telegram logs on the Options page. The sender ID will appear in the update payload as `message.from.id`.

## Draft streaming

Telegram has a unique feature: **draft streaming**. As the LLM generates its response, ChromeClaw sends and edits a Telegram message in real time:

1. Wait for initial threshold (20 characters) before sending the first message
2. Edit the message every 500ms as new text arrives
3. If the response exceeds 4,096 characters, send a new message and continue editing that one
4. Final flush sends the complete text on turn end

This creates a "typing in real time" experience for the Telegram user.

## Typing indicators

While processing a message, ChromeClaw sends `sendChatAction("typing")` periodically so the user sees the "typing..." indicator in their Telegram app.

## Message reactions

ChromeClaw uses emoji reactions for receipt acknowledgment:

- When a message arrives, a 👀 emoji is added to indicate it's being processed
- When the response is complete, the reaction is removed

## Voice messages

### Inbound
- Voice messages are detected via the `voice` field in Telegram updates
- ChromeClaw downloads the audio using `getFile` + `downloadFile` from the Bot API
- The audio is transcribed using the configured STT engine
- The transcript is used as the message body for the agent

### Outbound
When TTS is enabled:
- Responses are synthesized using the configured TTS engine
- Audio is sent as a Telegram voice bubble (`sendVoice`) or audio file (`sendAudio`)

## Message formatting

ChromeClaw converts LLM markdown output to Telegram HTML:

| Markdown | Telegram HTML |
|----------|--------------|
| `**bold**` | `<b>bold</b>` |
| `*italic*` | `<i>italic</i>` |
| `~~strike~~` | `<s>strike</s>` |
| `` `code` `` | `<code>code</code>` |
| Code blocks | `<pre>` blocks |
| `> quote` | `<blockquote>` |
| `[text](url)` | `<a href="url">text</a>` |

## Polling modes

Telegram operates in two modes:

| Mode | Polling | Timeout | Latency |
|------|---------|---------|---------|
| **Passive** | Chrome alarm (every 30s) | 0 (short-poll) | Up to 30s |
| **Active** | Offscreen document | 25s (long-poll) | Near-instant |

The channel starts in passive mode and upgrades to active on first valid message. After 10 minutes of inactivity, it downgrades back to passive.

## Bot commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | Show available commands |
| `/reset` | Start a new conversation |
| `/status` | Show current model and usage info |
| `/tts` | Configure voice reply mode: `on`, `off`, `always`, `inbound` |

The `/tts` command is Telegram-only and controls when responses are spoken:
- `off` — TTS disabled
- `always` — Every response is spoken
- `inbound` — Only speak responses triggered by voice input

## Configuration

| Setting | Description |
|---------|-------------|
| `enabled` | Enable/disable the channel |
| `credentials.botToken` | Telegram Bot API token |
| `allowedSenderIds` | Telegram user IDs allowed to interact |
| `modelId` | Override default model for this channel |
