# ChromeClaw v2.2.0 Release Notes

## Agent Heartbeat

- **Autonomous agent wake-ups**: A new heartbeat subsystem lets agents run on their own schedule. An orchestrator with a Dexie TTL lock sweeps for due agents, a coalescing wake queue (RETRY < INTERVAL < DEFAULT < ACTION) prevents stampedes, and a 1-minute periodic tick plus one-shot kick drive execution.
- **On by default for the default agent**: A two-rule enablement resolver auto-enables the default agent in implicit mode and switches to opt-in once any agent has a stored heartbeat config.
- **Channel delivery**: Heartbeat output can be delivered to Telegram/WhatsApp, with in-chat toast notifications when a delivery lands.
- **Token-safe**: A missing or empty `HEARTBEAT.md` is treated as empty so idle heartbeats don't burn tokens. Rapid manual triggers are de-duplicated to suppress duplicate sessions.
- **New workspace file + storage**: Added the `HEARTBEAT.md` predefined workspace file and Dexie v14 heartbeat tables, plus a "Run now" button and status card on the agent overview.

## Browser Tool — Tab Grouping

- **Group management actions**: Added `group_tabs`, `ungroup_tabs`, `list_tab_groups`, and `update_tab_group`, built on `chrome.tabs.group` / `chrome.tabGroups`. Each listed tab is annotated with its group label.
- **Open into a group**: The `open` action now accepts a `groupId` to add new tabs directly to an existing group.
- **Window-scoped**: Group operations and the debugger banner are now constrained to the focused window, so they no longer leak across all open windows.
- **Firefox guard**: Returns a clear error on Firefox, where `chrome.tabGroups` is unavailable. Adds the `tabGroups` manifest permission.

## Telegram Voice & Speech-to-Text

- **Azure OpenAI STT support**: Auto-detects Azure hosts (`*.openai.azure.com` and `*.cognitiveservices.azure.com`) and adapts the request — an `api-key` header instead of `Authorization: Bearer`, and the required `api-version` query param (default `2024-06-01`, respecting one already present in your base URL).
- **Fixed 404 on transcription**: Base URLs that already include the operation path (e.g. `/audio/translations`) no longer get `/audio/transcriptions` appended a second time.
- **Fallback to local Whisper**: In Auto mode, a cloud transcription failure now falls back to local Whisper once before giving up; explicitly selecting OpenAI still surfaces errors loudly.
- **Broader media support**: Transcription now triggers for audio files, video notes, and audio document attachments, not just native voice messages.
- **Sanitized errors + diagnostics**: Failed transcriptions report a sanitized reason (download vs. transcribe, with HTTP status) without leaking keys. The STT path now emits buffered diagnostics to the Logs panel, and a new "API Version" field was added to Speech-to-Text settings.

## Network & Stream Reliability

- **Centralized network detection**: Online/offline status is now tracked in the background service worker as the single source of truth, collapsing burst events (e.g. waking from hibernate) into one broadcast. Toasts are gated on document visibility so they no longer duplicate across pages.
- **Hallucinated tool-response filtering**: Web-session providers (notably Gemini web) sometimes emit fabricated `<tool_response>` blocks; the XML parser now discards them so fake results never reach the agent loop or pollute the next turn's transcript.
- **Headless sanitization**: Transcript sanitization now also applies to headless run paths.

## UI Improvements

- **Input history navigation**: Recall previously submitted prompts with ArrowUp/ArrowDown, gated on caret position so multi-line editing and the slash menu aren't hijacked (in-memory, max 1000 entries).
- **Workspace upload restrictions removed**: Dropped the 20K-character limit and the `.md/.txt/.markdown` file-picker filter; downloads now serve as `text/plain` to match actual content.

## Web Providers

- **Gemini temp chat**: The Gemini web provider now defaults to ephemeral mode so conversations aren't saved to the user's Gemini history.

## Internationalization

- Added **Korean** as a supported locale with a full 427-key translation.
- Backfilled the missing `toast_heartbeatDelivered` key across all 9 non-English locales.

## Documentation

- **New docs site**: Added 37 pages of Mintlify documentation (Get Started, Concepts, Channels, Tools, Providers, Voice, Agents, Automation, Development, Reference), generated from the actual TypeScript source.
