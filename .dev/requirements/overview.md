# Overview — ChromeClaw Extension Architecture

## Scope
Master architecture document for ChromeClaw, a Manifest V3 Chrome extension providing AI chat in the browser's side panel with multi-provider LLM support. Built with React 19, TypeScript, Vite, and Tailwind CSS.

## Monorepo Layout
Flat monorepo orchestrated with **Turborepo** (`turbo.json`), managed by **pnpm 10.11.0**.

| Package/Page | Role |
|---|---|
| `chrome-extension/` | Background service worker, manifest, agents, tools, memory, channels, cron, TTS |
| `pages/side-panel/` | Primary chat UI (overlay sidebar mode) |
| `pages/full-page-chat/` | Full-page chat (push sidebar mode) |
| `pages/offscreen-channels/` | Offscreen page for channel workers, TTS, STT, local LLM |
| `pages/options/` | Settings page (tabbed: Control, Agent, Settings groups) |
| `packages/shared/` | Types, hooks (`useLLMStream`), prompts, env config |
| `packages/storage/` | Chrome storage + IndexedDB (Dexie.js) — all persistence |
| `packages/ui/` | React components (shadcn/ui + custom chat components) |
| `packages/config-panels/` | Options page tab panels and tab group definitions |
| `packages/skills/` | Skill template loading and parsing |
| `packages/baileys/` | WhatsApp (Baileys) integration |
| `packages/i18n/` | Internationalization |
| `packages/env/` | Build-time `CEB_*` environment variables |

## Data Flow
```
Side Panel / Full-Page Chat
  → useLLMStream hook (chrome.runtime.Port)
  → Background Service Worker (stream-handler.ts)
  → Model Adapter (chatModelToPiModel) → pi-mono streamSimple()
  → LLM Provider (OpenAI / Anthropic / Google / OpenRouter / Custom / Local)
  → SSE stream back through Port → UI updates
```

## Storage

### Chrome Storage (local/session)
Settings, tool configurations, channel credentials, small key-value data.

### IndexedDB via Dexie.js (`chromeclaw` database, v13)
| Table | Contents |
|---|---|
| `chats` | Conversation metadata, token usage, compaction info, channel metadata |
| `messages` | Chat messages with parts (text, reasoning, tool calls, files) |
| `models` | Saved model configurations (`DbChatModel`) |
| `artifacts` | Generated documents (text, code, spreadsheets, images) |
| `workspaceFiles` | Context files — predefined and custom, scoped per agent |
| `memoryChunks` | Indexed text chunks with optional embeddings |
| `scheduledTasks` | Persistent cron/scheduler tasks |
| `taskRunLogs` | Scheduled task execution history |
| `embeddingCache` | Cached vector embeddings |

## Code Conventions
- **TypeScript strict mode** everywhere
- **Arrow function expressions** preferred (`func-style: 'expression'`)
- **Type imports**: `import type { ... }` for type-only imports
- **Import order**: Local → parent → internal (`@extension/*`) → external → builtin → type
- **Functional components** with hooks, no class components, no PropTypes
- **Naming**: PascalCase components, camelCase utils/hooks, kebab-case filenames
- **No `any`**: Warning-level enforcement; use proper types
- **Unused vars**: Prefix with `_` to ignore

## Environment Variables
Set in `.env` (copied from `.example.env` on install):
- `CEB_GOOGLE_CLIENT_ID` — Google OAuth2 client ID
- `CEB_ENABLE_WEBGPU_MODELS` — Enable WebGPU local models (default `false`)
- `CEB_DEV_LOCALE` — Force locale for dev
- `CEB_CI` — CI mode flag

Build flags: `CLI_CEB_DEV=true` (dev mode), `CLI_CEB_FIREFOX=true` (Firefox build).

## Requirements
- Node.js >= 22.15.1
- pnpm 10.11.0 (`packageManager` field enforced)

## Testing
- **Unit tests** (Vitest): `packages/*/tests/`, `pages/*/tests/`, `chrome-extension/tests/`. Uses `fake-indexeddb` for storage mocks.
- **E2E tests** (Playwright): `tests/playwright/e2e/`. Launches Chrome with extension loaded from `dist/`.

## Gate
`pnpm build && pnpm quality` — exit 0. (`quality` = lint + format:check + type-check + test)

## Requirement Specs
| Spec | Topic |
|---|---|
| [R1](r1-multi-provider-llm.md) | Multi-provider LLM abstraction |
| [R2](r2-streaming-architecture.md) | Streaming architecture |
| [R3](r3-agent-system.md) | Agent system |
| [R4](r4-tool-system.md) | Tool system |
| [R5](r5-memory-system.md) | Memory system |
| [R6](r6-context-compaction.md) | Context compaction |
| [R7](r7-channels.md) | Messaging channels |
| [R8](r8-workspace-files.md) | Workspace files |
