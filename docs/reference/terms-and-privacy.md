---
summary: "ChromeClaw terms of use and privacy policy."
read_when:
  - Checking privacy policy
  - Understanding data handling
  - Reviewing terms of use
title: "Terms & Privacy"
---

# Terms & Privacy

ChromeClaw is an open-source Chrome extension that runs entirely in your browser. Your data stays local.

## Data handling

- **API keys** are stored in `chrome.storage.local` on your device only
- **Chat history** is stored in IndexedDB in your browser
- **No telemetry** — ChromeClaw does not send usage data anywhere
- **No accounts** — No login or registration required
- **No proxy** — API calls go directly from your browser to the LLM provider

## Third-party services

ChromeClaw connects to external services only when you configure them:

- **LLM providers** (OpenAI, Anthropic, Google, OpenRouter, custom) — Your API key is sent directly to the provider
- **Messaging channels** (WhatsApp, Telegram) — Messages are exchanged with these platforms
- **Google services** (Gmail, Calendar, Drive) — OAuth tokens are managed by `chrome.identity`
- **Web search** (Tavily) — Search queries are sent to the configured search provider

## Open source

ChromeClaw is licensed under the MIT License. The full source code is available at [github.com/algopian/chromeclaw](https://github.com/algopian/chromeclaw).

For the complete terms and privacy policy, see the [full document](/docs/terms-and-privacy.md).
