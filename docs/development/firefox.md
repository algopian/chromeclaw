---
summary: "Firefox build — cross-browser builds via a single flag, differences from Chrome, and loading in Firefox."
read_when:
  - Building ChromeClaw for Firefox
  - Understanding Firefox-specific differences
  - Loading the extension in Firefox
title: "Firefox Build"
---

# Firefox Build

ChromeClaw supports Firefox through cross-browser builds with a single flag. Most features work identically, with a few platform-specific differences.

## Building for Firefox

```bash
pnpm build:firefox      # Production build
pnpm dev:firefox        # Development mode with watch
pnpm zip:firefox        # Build + package as ZIP
```

These commands set `CLI_CEB_FIREFOX=true` which adjusts the Vite build for Firefox compatibility.

## Installing in Firefox

### From Firefox Add-ons

Install directly from [Mozilla Add-ons](https://addons.mozilla.org/addon/chromeclaw/) — no build step required.

### From source (temporary)

1. Run `pnpm build:firefox`
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Select any file in the `dist/` directory

<Warning>
Temporary extensions are removed when Firefox restarts. For persistent installation, use the Firefox Add-ons store.
</Warning>

## Platform differences

### Offscreen document

- **Chrome**: Uses `chrome.offscreen` API (MV3)
- **Firefox**: Uses a hidden popup window (Firefox doesn't support `chrome.offscreen`)

The offscreen functionality (channels, TTS, STT, local LLM) works the same way regardless.

### Debugger tool

The `debugger` tool (raw CDP commands) is Chrome-only. It's automatically hidden on Firefox.

The `browser` tool uses the scripting API as a fallback for basic browser actions on Firefox.

### Chrome-only tools

Tools marked with `chromeOnly: true` are automatically filtered out on Firefox:

- **Debugger** — Raw CDP command access

All other tools work on both platforms.

## Environment

The `IS_FIREFOX` flag is available at runtime to check the current platform. Chrome-only features use this to conditionally hide themselves.
