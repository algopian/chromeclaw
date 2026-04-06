---
summary: "Install ChromeClaw from browser stores or build from source."
read_when:
  - Installing ChromeClaw
  - Building the extension from source
  - Loading the extension in developer mode
title: "Installation"
---

# Installation

## Browser stores

The easiest way to install ChromeClaw:

- **Chrome**: [Chrome Web Store](https://chromewebstore.google.com/detail/chromeclaw-your-own-perso/lnahopfgnfhcfchffbckmbbkopcmojme)
- **Firefox**: [Firefox Add-ons](https://addons.mozilla.org/addon/chromeclaw/)

No build step required — install and start using immediately.

## Build from source

### Prerequisites

- **Node.js** >= 22.15.1
- **pnpm** 10.x

### Install dependencies and build

```bash
pnpm install
pnpm build
```

This produces a production build in the `dist/` directory.

### Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` directory
5. Open any page and click the ChromeClaw icon to open the side panel

### Load in Firefox

Build the Firefox variant:

```bash
pnpm build:firefox
```

Then load as a temporary extension:

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select any file in the `dist/` directory

See [Firefox Build](/development/firefox) for more details.

## Development mode

For active development with hot module reload:

```bash
pnpm dev
```

This cleans the `dist/` folder, builds all packages, then starts Vite in watch mode via Turborepo. After loading the extension once, changes are picked up automatically — reload the extension page to apply.

For Firefox development:

```bash
pnpm dev:firefox
```

## Environment variables

Set in `.env` (auto-copied from `.example.env` on install):

| Variable | Description | Default |
|----------|-------------|---------|
| `CEB_GOOGLE_CLIENT_ID` | Google OAuth2 client ID (for Gmail/Calendar/Drive tools) | — |
| `CEB_ENABLE_WEBGPU_MODELS` | Enable WebGPU local models | `false` |
| `CEB_DEV_LOCALE` | Force locale for development | — |
| `CEB_CI` | CI mode flag | — |

CLI flags set automatically by build scripts:

| Variable | Description |
|----------|-------------|
| `CLI_CEB_DEV` | Development mode (set by `pnpm dev`) |
| `CLI_CEB_FIREFOX` | Firefox build (set by `pnpm build:firefox`) |
