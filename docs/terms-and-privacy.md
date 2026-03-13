# ChromeClaw — Terms of Use & Privacy

**Last updated:** March 13, 2026

ChromeClaw is an open-source Chrome extension that provides AI chat in the browser's side panel with multi-provider LLM support. Source code: [github.com/algopian/chromeclaw](https://github.com/algopian/chromeclaw)

---

## 1. Open Source Software Privacy

The software is a client-side only tool with a "Bring Your Own Key" (BYOK) architecture. The software itself does not include any backend service. The software does not collect or transmit any user data on its own, and we do not have access to your browsing activity, page content, or task instructions through the software.

All data transmission occurs only between your browser and the LLM provider you configure. You are in full control of which provider receives your data.

The project is open source under the MIT License and can be audited at: [github.com/algopian/chromeclaw](https://github.com/algopian/chromeclaw)

## 2. Browser Extension

### 2.1 Data Processing

All data processing happens locally in your browser. Data is only sent to external servers when **you** initiate an action that requires it:

- **LLM chat:** When you send a message, your conversation context (messages, system prompt, workspace files) is sent to the LLM provider you have configured (e.g., OpenAI, Anthropic, Google). The provider's own privacy policy and terms of service apply.
- **Tool use:** When the LLM invokes tools (web search, web fetch, document reading, etc.), data may be sent to external services as part of tool execution. This only occurs during active conversations where tool use is enabled.
- **Page content:** If you use tools that read page content (e.g., browser tools, CDP/debugger tools, execute JS), the content of the active page may be included in the context sent to your LLM provider.

**You are responsible for reviewing the privacy policies of any third-party LLM providers you choose to use.**

### 2.2 Permissions Explained

ChromeClaw requests the following browser permissions:

| Permission | Why it's needed |
|---|---|
| `storage` | Store your settings, API keys, and tool configurations locally in `chrome.storage.local` |
| `scripting` | Execute scripts on web pages for browser tools and page interaction |
| `tabs` | Access tab information for browser tools and context-aware features |
| `debugger` | Chrome DevTools Protocol (CDP) access for advanced browser automation tools |
| `offscreen` | Create offscreen documents for channel message handling (Telegram/WhatsApp) and media processing |
| `identity` | Google OAuth2 authentication for optional Google integrations (Gmail, Calendar, Drive) |
| `declarativeNetRequest` | Modify specific response headers to enable extension functionality (e.g., allowing image display, WhatsApp channel connectivity) |
| `sidePanel` | Display the chat interface in Chrome's side panel |
| `alarms` | Schedule recurring tasks for the cron/scheduler feature and channel polling |
| `notifications` | Display browser notifications for scheduled task results and channel messages |
| `<all_urls>` (host permission) | Required for browser tools to interact with web pages, web fetch/search tools, and channel integrations |

### 2.3 Data Storage

All data is stored locally on your device:

- **`chrome.storage.local`:** Settings, tool configurations, and extension preferences.
- **IndexedDB (Dexie.js):** Conversations, messages, agents, artifacts, workspace files, memory chunks, scheduled tasks, task run logs, embedding cache, and model configurations.

No data is synced to any cloud service. No data leaves your browser unless you explicitly initiate an action that requires it (see Section 2.1).

### 2.4 Optional Integrations

The following features are entirely optional and only activated by your explicit configuration:

- **Google OAuth (Gmail, Calendar, Drive):** If you configure a Google Cloud client ID and authorize access, ChromeClaw communicates directly with Google APIs using OAuth2 tokens obtained via `chrome.identity`. ChromeClaw does not proxy or store Google data beyond what is needed for the current operation. Google's [Privacy Policy](https://policies.google.com/privacy) and [Terms of Service](https://policies.google.com/terms) apply.
- **Telegram channel:** If configured, ChromeClaw polls the Telegram Bot API for messages using your bot token and routes them through your configured LLM provider. Telegram's [Privacy Policy](https://telegram.org/privacy) applies.
- **WhatsApp channel:** If configured, ChromeClaw connects to WhatsApp Web to receive and send messages, routing them through your configured LLM provider. WhatsApp's [Privacy Policy](https://www.whatsapp.com/legal/privacy-policy) applies.
- **Text-to-Speech (TTS):** Audio can be generated locally via Kokoro (runs in-browser) or sent to OpenAI's TTS API based on your configuration. When using OpenAI TTS, text is sent to OpenAI's servers. OpenAI's [Privacy Policy](https://openai.com/privacy) applies.

### 2.5 Your Control

- **Open source:** All code is publicly auditable on [GitHub](https://github.com/algopian/chromeclaw).
- **Choose your provider:** You decide which LLM providers to use and configure your own API keys.
- **Local data:** All conversation history, memory, and settings are stored locally on your device.
- **Clear all data:** Removing the extension from Chrome deletes all associated data. You can also clear data from the extension's settings page.
- **Permissions:** You can review and manage the extension's permissions at any time via `chrome://extensions`.

## 3. Age Requirement

ChromeClaw does not have its own age requirement. However, you must comply with the age requirements and terms of service of any third-party LLM providers and services you use through this extension.

## 4. Changes

We may update these terms from time to time. Changes will be reflected in this document with an updated date. Continued use of the extension after changes constitutes acceptance.

## 5. Contact

For questions, concerns, or feedback, please open an issue on [GitHub](https://github.com/algopian/chromeclaw/issues).
