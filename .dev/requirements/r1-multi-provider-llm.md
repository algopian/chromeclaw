# R1: Multi-Provider LLM — `chrome-extension/src/background/agents/model-adapter.ts`

## Scope
Provider abstraction layer supporting 6 API providers and 11 web providers. Converts ChromeClaw's `ChatModel` type to pi-mono's `Model<Api>` for provider-specific routing.

## Key Files
| File/Package | Role |
|---|---|
| `chrome-extension/src/background/agents/model-adapter.ts` | `chatModelToPiModel()` — converts ChatModel to pi-mono Model |
| `packages/shared/lib/chat-types.ts` | `ChatModel` interface definition |
| `packages/storage/` | `DbChatModel` — persisted model config in IndexedDB |
| `pages/options/` | Model configuration UI (Models settings tab) |

## Architecture
The model adapter is the single translation point between ChromeClaw's internal model representation and pi-mono's provider-specific API clients.

**Provider routing**:
1. Read `ChatModel.provider` field to determine target
2. Resolve API type (`openai-completions`, `openai-responses`, `openai-codex-responses`)
3. Build pi-mono `Model<Api>` with correct base URL, API key, and options
4. Azure OpenAI endpoints auto-detected from URL — receive `api-version` query parameter injection

**Web providers** (11 browser-based):
- ChatGPT, Claude, Gemini, DeepSeek, Kimi, Qwen, Qwen CN, GLM, GLM Intl, Doubao, Rakuten
- Use `chrome.scripting.executeScript` in MAIN world to make requests through browser session cookies
- No API key required — inherits user's web session authentication

**Context window resolution order**:
1. Explicit override in model config
2. Built-in lookup table for known models
3. Provider default fallback

## Key Types/Interfaces
```typescript
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
```

## Behavior
- **6 API providers**: OpenAI (tools+reasoning), Anthropic (tools+reasoning), Google (tools+reasoning), OpenRouter (tools, reasoning varies), Custom (OpenAI-compatible, varies), Local (Transformers.js via WebGPU/WASM, no tools)
- **API types**: `openai-completions` (default), `openai-responses` (auto-detected for GPT-5/o3/o4), `openai-codex-responses`
- **Azure auto-detection**: URLs matching Azure patterns get `api-version` parameter injected
- **Local models**: Run in offscreen document via Transformers.js worker — no API key, no tool support
- Models stored in IndexedDB `models` table; first-run setup shown when `models.length === 0`

## Dependencies
- `@mariozechner/pi-ai` + `@mariozechner/pi-agent-core` (pi-mono) — provider API clients and streaming
- `packages/storage/` — model persistence
- `chrome.scripting` API — web provider execution

## Gate
`pnpm build && pnpm quality` — exit 0.
