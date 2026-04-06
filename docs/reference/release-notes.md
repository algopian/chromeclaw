---
summary: "ChromeClaw release notes and version history."
read_when:
  - Checking what's new in a release
  - Viewing version history
title: "Release Notes"
---

# Release Notes

## v2.0.0

Major release with significant new features and improvements.

### New features

- **Web providers** — Access LLMs via browser session (ChatGPT, Claude, Gemini, DeepSeek, and more) without API keys
- **Debugger tool** — Direct Chrome DevTools Protocol access for advanced browser automation
- **Enhanced model support** — Azure OpenAI, OpenAI Responses API, Codex Responses API
- **Adaptive context compaction** — Multi-part summarization for very long conversation histories
- **Improved memory system** — Better temporal decay, MMR re-ranking, and session journaling

### Improvements

- Refined tool loop detection with 5-level severity system
- Better error classification and automatic retry strategies
- Enhanced streaming architecture with steering messages
- Improved channel message handling with draft streaming (Telegram)

---

## v1.9.4

### Improvements

- Bug fixes and stability improvements
- Enhanced model adapter compatibility
- Improved context management

---

For the full changelog, see the [GitHub releases](https://github.com/algopian/chromeclaw/releases).
