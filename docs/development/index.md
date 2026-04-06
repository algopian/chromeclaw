---
summary: "Development guide — setting up the dev environment, running tests, and contributing to ChromeClaw."
read_when:
  - Setting up a development environment
  - Running tests
  - Understanding the build system
title: "Development"
---

# Development

ChromeClaw is built with React 19, TypeScript, Vite 6, and Turborepo. This guide covers setting up the development environment, building, testing, and code quality.

## Prerequisites

- **Node.js** >= 22.15.1
- **pnpm** 10.x (enforced via `packageManager` field)

## Setup

```bash
git clone https://github.com/algopian/chromeclaw.git
cd chromeclaw
pnpm install
```

The `postinstall` script copies `.example.env` to `.env` if it doesn't exist.

## Development mode

```bash
pnpm dev
```

This:
1. Cleans the `dist/` folder
2. Builds all packages
3. Starts Vite in watch mode via Turborepo

Load the extension from `dist/` once, then changes are picked up automatically. Reload the extension page to apply.

## Building

```bash
pnpm build           # Production build → dist/
pnpm build:firefox   # Firefox production build → dist/
pnpm zip             # Build + package as ZIP
pnpm zip:firefox     # Firefox build + ZIP
```

## Testing

### Unit tests (Vitest)

```bash
pnpm test            # Run all tests
pnpm test:watch      # Watch mode
pnpm test:coverage   # With coverage report
```

Tests are located in:
- `packages/*/tests/`
- `pages/*/tests/`
- `chrome-extension/tests/`

Uses `fake-indexeddb` for storage mocks.

### E2E tests (Playwright)

```bash
pnpm build && pnpm test:e2e
```

E2E tests:
- Located in `tests/playwright/e2e/`
- Launch Chrome with the extension loaded from `dist/`
- Handle FirstRunSetup bypass via `helpers/setup.ts`
- Use page objects from `tests/playwright/pages/`

## Code quality

```bash
pnpm lint            # ESLint (flat config)
pnpm lint:fix        # ESLint with auto-fix
pnpm format          # Prettier write
pnpm format:check    # Prettier check
pnpm type-check      # TypeScript strict check
pnpm quality         # All of the above + tests
```

## Monorepo structure

Turborepo orchestrates builds across packages:

| Package | Purpose |
|---------|---------|
| `chrome-extension` | Background service worker |
| `pages/side-panel` | Primary chat UI |
| `pages/full-page-chat` | Full-page chat mode |
| `pages/options` | Settings page |
| `pages/offscreen-channels` | Offscreen document |
| `packages/shared` | Types, hooks, prompts, env config |
| `packages/storage` | Chrome storage + IndexedDB |
| `packages/ui` | React components (shadcn/ui) |
| `packages/config-panels` | Options page tab panels |
| `packages/skills` | Skill template system |
| `packages/baileys` | WhatsApp client library |
| `packages/i18n` | Internationalization |
| `packages/env` | Build-time environment variables |
| `packages/dev-utils` | Development utilities |
| `packages/hmr` | Hot module reload for extension dev |
| `packages/module-manager` | Module dependency management CLI |
| `packages/tailwindcss-config` | Tailwind configuration |
| `packages/tsconfig` | Base TypeScript configs |
| `packages/vite-config` | Shared Vite configuration |
| `packages/zipper` | Extension ZIP packaging |

## Code conventions

- **TypeScript strict mode** everywhere
- **Arrow function expressions** preferred (`func-style: 'expression'`)
- **Type imports**: Use `import type { ... }` for type-only imports
- **Import order**: Local → parent → internal (@extension/*) → external → builtin → type
- **Naming**: PascalCase for components, camelCase for utils/hooks, kebab-case for filenames
- **No `any`**: Warning-level enforcement
- **Unused vars**: Prefix with `_`

## Useful commands

```bash
pnpm clean           # Clean bundles, turbo cache, node_modules
pnpm clean:install   # Clean + fresh install
pnpm update-version  # Update version in manifest + package.json
pnpm module-manager  # Module dependency management CLI
```
