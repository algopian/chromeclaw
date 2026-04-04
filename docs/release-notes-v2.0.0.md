# ChromeClaw v2.0.0 Release Notes

## New Web Providers

- **ChatGPT (chatgpt.com)**: Full web provider with Sentinel challenge support, model metadata extraction, thinking level control, and automatic 403 "unusual activity" recovery — detects stale sessions after inactivity, refreshes the tab, and retries seamlessly.
- **DeepSeek (chat.deepseek.com)**: Web provider with Proof-of-Work challenge solving for session authentication.
- **Doubao (www.doubao.com)**: Web provider for ByteDance's Doubao assistant.
- **Rakuten AI (rakuten.ai)**: Web provider with WebSocket streaming, HMAC request signing, and token caching.

## Web Provider Architecture

- **Plugin system**: Web providers are now registered via a plugin/factory pattern (`plugin-registry.ts`). Each provider is a self-contained plugin file, replacing the previous monolithic switch-case routing in the bridge. Adding a new provider is now a single file + registry entry.
- **Content script extraction**: Provider-specific content-fetch handlers have been split out of the 3,300-line `content-fetch-main.ts` into dedicated files (`content-fetch-chatgpt.ts`, `content-fetch-deepseek.ts`, `content-fetch-doubao.ts`, `content-fetch-gemini.ts`, `content-fetch-glm-intl.ts`, `content-fetch-rakuten.ts`). The main file now contains only shared infrastructure.
- **Bridge improvements**: `web-llm-bridge.ts` now supports `providerMetadata` for per-provider context and `retryAttempt` for retry loop prevention.

## Existing Web Provider Improvements

- **GLM-CN**: Added thinking mode toggle and more robust stream handling.
- **GLM International**: Added thinking level support and model rename handling.
- **GLM adapters**: Added error handling for stream adapter failures with timeout notices in the UI.
- **Qwen**: Fixed `thinking_summary` phase transition bug.

## Agent Backup & Restore

- **ZIP-based backup**: Agents can now be exported as ZIP archives containing their full configuration (model, tools, custom tools, compaction config, identity) and all workspace files.
- **Restore in first-run setup**: New "Restore" button in the onboarding wizard lets users bootstrap a fresh install from a previous agent backup.
- **Restore in settings**: Backup and restore buttons added to the Agents settings panel.

## Slash Commands

- **`/new`**: Start a new chat session.
- **`/copy`** and **`/export`** now support arguments (e.g., `/copy 3` to copy the 3rd-latest assistant message).

## UI Improvements

- **Tab indicator**: An indigo outline appears on browser tabs while ChromeClaw tools are actively interacting with them, with a brief linger after completion. Reference-counted for overlapping tool calls.
- **Tool call copy button**: Copy tool call results directly from the chat UI.
- **Improved `/export` output**: Exports now include tool calls with parameters and results, reasoning blocks in collapsible details, and proper deduplication of tool results.
- **Markdown editor fix**: Code blocks are now readable in light mode preview.
- **Removed unused description field** from the model configuration form.

## Internationalization

- Localized all previously hardcoded English strings in the onboarding wizard and model configuration UI.
- Added 32 missing i18n keys across all 10 locales (de, en, es, fr, ja, nl, pt, ru, zh_CN, zh_TW).
- Translated all `firstRun_*` strings that were left untranslated.
