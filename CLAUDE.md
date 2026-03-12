# CLAUDE.md — ChromeClaw Extension

## What is this project?

ChromeClaw is a Chrome extension that provides AI chat in the browser's side panel with multi-provider LLM support. Built with React 19, TypeScript, and pi-mono (`@mariozechner/pi-ai` + `@mariozechner/pi-agent-core`). Users add their own API keys — no login or proxy required.

## Monorepo layout

Flat monorepo orchestrated with **Turborepo** (`turbo.json`).

```
chromeclaw/
├── chrome-extension/              # Background service worker, manifest
│   └── src/background/
│       ├── agents/                # Agent personas, model adapter, stream handler
│       ├── channels/              # Telegram + WhatsApp messaging bridges
│       ├── context/               # System prompt assembly, context compaction
│       ├── cron/                  # Scheduled task runner
│       ├── errors/                # Error handling
│       ├── logging/               # Logging utilities
│       ├── media-understanding/   # Speech-to-text, media transcription
│       ├── memory/                # BM25 + embedding hybrid search, memory journal
│       ├── tools/                 # All tool implementations
│       └── tts/                   # Text-to-speech (OpenAI, Kokoro)
├── pages/
│   ├── side-panel/                # Primary chat UI (overlay sidebar mode)
│   ├── full-page-chat/            # Full-page chat (push sidebar mode)
│   ├── offscreen-channels/        # Offscreen page for channel message handling
│   └── options/                   # Settings page (tabbed, see below)
├── packages/
│   ├── baileys/                   # WhatsApp (Baileys) integration
│   ├── config-panels/             # Options page tab panels and tab group definitions
│   ├── dev-utils/                 # Dev utilities
│   ├── env/                       # Build-time CEB_* environment variables
│   ├── hmr/                       # Hot module reload for extension dev
│   ├── i18n/                      # Internationalization
│   ├── module-manager/            # Module dependency management CLI
│   ├── shared/                    # Types, hooks (useLLMStream), prompts, env config
│   ├── skills/                    # Skill template loading and parsing
│   ├── storage/                   # Chrome storage + IndexedDB (Dexie.js) — all persistence
│   ├── tailwindcss-config/        # Tailwind configuration
│   ├── tsconfig/                  # Base TypeScript configs
│   ├── ui/                        # React components (shadcn/ui + custom chat components)
│   ├── vite-config/               # Shared Vite configuration
│   └── zipper/                    # Extension ZIP packaging
├── tests/playwright/              # E2E tests
├── bash-scripts/                  # Shell scripts (copy-env, set-global-env, update-version)
├── docs/                          # Documentation
├── turbo.json                     # Turborepo config
├── vitest.config.ts               # Shared Vitest config
└── playwright.config.ts           # Playwright config
```

## Commands

All commands run from the **repo root**:

```bash
pnpm install          # Install deps (postinstall copies .env from .example.env)
pnpm dev              # Watch mode with HMR
pnpm dev:firefox      # Watch mode targeting Firefox
pnpm build            # Production build → dist/
pnpm build:firefox    # Production build for Firefox
pnpm test             # Vitest unit tests
pnpm test:watch       # Vitest watch mode
pnpm test:coverage    # Vitest with coverage
pnpm test:e2e         # Playwright E2E tests (requires prior build)
pnpm lint             # ESLint (flat config)
pnpm lint:fix         # ESLint with auto-fix
pnpm format           # Prettier write
pnpm format:check     # Prettier check
pnpm type-check       # TypeScript strict check
pnpm quality          # lint + format:check + type-check + test
pnpm zip              # Build + package as ZIP
pnpm zip:firefox      # Build Firefox + package as ZIP
pnpm clean            # Clean bundles, turbo cache, and node_modules
pnpm clean:install    # Clean node_modules + fresh install
pnpm update-version   # Update version in manifest + package.json
pnpm module-manager   # Module dependency management CLI
pnpm prepare          # Husky git hooks setup
```

## Architecture

### Data flow
```
Side Panel / Full-Page Chat
  → useLLMStream hook (chrome.runtime.Port)
  → Background Service Worker (llm-stream.ts)
  → Model Adapter (chatModelToPiModel) → pi-mono streamSimple()
  → LLM Provider (OpenAI/Anthropic/Google/OpenRouter/Custom/Local)
  → SSE stream back through Port → UI updates
```

### Storage
- **Chrome storage (local/session)**: Settings, tool configs
- **IndexedDB via Dexie.js** (`chromeclaw` database, v13): agents, chats, messages, artifacts, workspaceFiles, memoryChunks, scheduledTasks, taskRunLogs, embeddingCache
- Models are also stored in IndexedDB (`DbChatModel` type)

### Key components
- **Background SW** (`chrome-extension/src/background/`): LLM streaming with tool calling, context compaction, memory search, auto-titling, channels, cron, TTS, media understanding
- **Agents** (`background/agents/`): Multiple agent personas with per-agent workspace files, memory, model config. Model adapter (`model-adapter.ts`) converts ChatModel to pi-mono `Model<Api>`, routing to providers based on model config
- **Channels** (`background/channels/`): Telegram + WhatsApp messaging bridges. Flow: poller → message-bridge → agent-handler → LLM → reply. Offscreen page (`offscreen-channels`) handles message I/O
- **Cron/Scheduler** (`background/cron/`): Persistent scheduled tasks with run logs stored in IndexedDB
- **TTS** (`background/tts/`): Text-to-speech with multiple providers (OpenAI, Kokoro)
- **Media understanding** (`background/media-understanding/`): Speech-to-text / media transcription via offscreen
- **Memory** (`background/memory/`): Hybrid search (BM25 + cosine similarity via embeddings), memory journal, transcript indexing, temporal decay
- **Tools** (`background/tools/`): Browser, CDP/Debugger, Deep Research, Execute JS, Web Search, Web Fetch, Documents, Memory, Workspace, Scheduler, Subagent, Agents List, Google (Gmail/Calendar/Drive), Image Sanitization
- **Workspace files**: Predefined (AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md, MEMORY.md) + user custom files, included in system prompt. Scoped per agent
- **Skills**: Markdown prompt templates with frontmatter metadata, loaded from IndexedDB

### Settings tabs (Options page)

Three groups defined in `packages/config-panels/lib/tab-groups.ts`:
- **Control**: Channels, Cron Jobs, Sessions, Usage
- **Agent**: Agents, Tools, Skills
- **Settings**: General, Models, Actions, Logs

## Code conventions

- **TypeScript strict mode** everywhere
- **Arrow function expressions** preferred (`func-style: 'expression'`)
- **Type imports**: Use `import type { ... }` for type-only imports
- **Import order**: Local → parent → internal (@extension/*) → external → builtin → type
- **Components**: Functional with hooks, no class components, no PropTypes
- **Naming**: PascalCase for components, camelCase for utils/hooks, kebab-case for filenames
- **No `any`**: Warning-level enforcement; use proper types
- **Unused vars**: Prefix with `_` to ignore

## Environment variables

Set in `.env` (copied from `.example.env` on install):

```bash
CEB_EXAMPLE=example_env
CEB_DEV_LOCALE=                  # Force locale for dev
CEB_CI=                          # CI mode flag
CEB_GOOGLE_CLIENT_ID=            # Google OAuth2 client ID (for Gmail/Calendar/Drive)
CEB_ENABLE_WEBGPU_MODELS=false   # Enable WebGPU local models
```

Build flags: `CLI_CEB_DEV=true` (dev mode), `CLI_CEB_FIREFOX=true` (Firefox build).

## Requirements

- Node.js >= 22.15.1
- pnpm 10.11.0 (`packageManager` field enforced)

## Testing

- **Unit tests** (Vitest): `packages/*/tests/`, `pages/*/tests/`, `chrome-extension/tests/`. Uses `fake-indexeddb` for storage mocks.
- **E2E tests** (Playwright): `tests/playwright/e2e/`. Launches Chrome with extension loaded from `dist/`. Shared helpers in `tests/playwright/helpers/setup.ts` handle FirstRunSetup bypass. Page objects in `tests/playwright/pages/`.

## Key types

```typescript
// packages/shared/lib/chat-types.ts
type ToolPartState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error';

type ChatMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown>; result?: unknown; state?: ToolPartState }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; state?: ToolPartState }
  | { type: 'file'; url: string; filename?: string; mediaType?: string; data?: string };

interface ChatModel {
  id: string; name: string;
  provider: 'openai' | 'anthropic' | 'google' | 'openrouter' | 'custom' | 'local';
  description?: string;
  routingMode?: 'direct';
  api?: 'openai-completions' | 'openai-responses' | 'openai-codex-responses';
  apiKey?: string; baseUrl?: string;
  supportsTools?: boolean; supportsReasoning?: boolean;
  toolTimeoutSeconds?: number;
  contextWindow?: number;
}

interface ChannelMeta { channelId: string; chatId: string; senderId: string; senderName?: string; senderUsername?: string; extra?: Record<string, unknown> }
interface Attachment { name: string; url: string; contentType: string }
interface SessionUsage { promptTokens: number; completionTokens: number; totalTokens: number; wasCompacted?: boolean; contextUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }; persistedByBackground?: boolean }
interface LLMStreamRetry { type: 'LLM_STREAM_RETRY'; chatId: string; attempt: number; maxAttempts: number; reason: string; strategy: 'compaction' | 'truncate-tool-results' }
interface LLMTtsAudio { type: 'LLM_TTS_AUDIO'; chatId: string; audioBase64: string; contentType: string; provider: string; chunkIndex?: number; isLastChunk?: boolean }
interface SubagentProgressInfo { runId: string; chatId: string; task: string; startedAt: number; stepCount: number; steps: SubagentProgressStep[] }
```

## Important patterns

1. **Streaming**: All LLM calls use `chrome.runtime.Port` for streaming. The `useLLMStream` hook in `packages/shared` manages the client side. The background SW uses pi-mono `streamSimple()`.
2. **First-run setup**: When `models.length === 0`, both SidePanel and FullPageChat show `<FirstRunSetup>` instead of Chat UI. Tests must handle this (see `helpers/setup.ts`).
3. **Context compaction**: Adaptive compaction when token count approaches model limits — supports summary-based and sliding-window strategies. Retry mechanism with `LLMStreamRetry` for context overflow recovery.
4. **Workspace context**: Enabled workspace files are injected into the system prompt as context for the LLM. Files are scoped per agent.
5. **Agents**: Multiple agent personas, each with separate workspace files, memory, model config. Agents are stored in IndexedDB and managed via the Agents settings tab.
6. **Channels**: Telegram/WhatsApp messaging bridges — poller fetches new messages → message-bridge normalizes → agent-handler routes to LLM → reply sent back through channel. Uses offscreen page for I/O.
7. **Cron/Scheduler**: Persistent scheduled tasks with configurable schedules. Run logs tracked in IndexedDB. Tasks can trigger LLM prompts.
8. **Subagent tool**: Spawns a nested LLM call with its own tool set for complex sub-tasks. Progress streamed to UI via `SubagentProgressInfo`.
9. **Tool loop detection**: Prevents infinite tool-calling loops in the background service worker.
10. **Memory**: Hybrid retrieval combining BM25 keyword search with cosine-similarity vector search (embeddings). Memory journal auto-curates MEMORY.md. Transcript indexing links memory chunks to chat sessions.
