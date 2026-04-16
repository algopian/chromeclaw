# R12: Options & Settings — `pages/options/` + `packages/config-panels/`

## Scope
Options page with 3 tab groups containing 12 tabs for managing all extension configuration: models, agents, tools, skills, channels, cron jobs, sessions, usage, logs, general settings, and actions.

## Key Files
| File/Package | Role |
|---|---|
| `pages/options/` | Options page entry point and layout |
| `packages/config-panels/lib/tab-groups.ts` | Tab group and tab definitions |
| `packages/config-panels/` | Individual tab panel components |
| `packages/storage/` | Chrome storage + IndexedDB persistence |
| `packages/ui/` | Shared UI components |

## Architecture
The Options page uses a tabbed layout organized into 3 tab groups:

**Control group:**
| Tab | Purpose |
|---|---|
| Channels | Telegram + WhatsApp bridge configuration |
| Cron Jobs | View and manage scheduled tasks |
| Sessions | Chat session management and history |
| Usage | Token usage statistics and tracking |

**Agent group:**
| Tab | Purpose |
|---|---|
| Agents | Agent persona management (workspace files, memory, model config) |
| Tools | Tool enable/disable and configuration |
| Skills | Skill template creation and management |

**Settings group:**
| Tab | Purpose |
|---|---|
| General | Voice, locale, UI preferences, auto-mode |
| Models | Add/edit/remove model configurations (provider, API key, base URL) |
| Actions | Suggested actions configuration |
| Logs | Extension log viewer |

**Data flow:**
```
Options page tab panels
  → Read/write Chrome storage (settings, tool configs)
  → Read/write IndexedDB (models, agents, skills, tasks, sessions)
  → Changes take effect immediately in background SW
```

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
- **Models tab**: Add models with provider selection, API key, base URL, context window, tool/reasoning support flags. Models stored in IndexedDB (`models` table).
- **Agents tab**: Create/edit agent personas with per-agent workspace files, memory config, and model selection.
- **Tools tab**: Enable/disable individual tools, configure tool-specific settings (e.g., browser tool tab access).
- **Skills tab**: Create/edit markdown skill templates with YAML frontmatter and `{{variable}}` placeholders.
- **Channels tab**: Configure Telegram bot token, WhatsApp connection, channel-agent mappings.
- **Cron Jobs tab**: View scheduled tasks, enable/disable, see execution history.
- **Sessions tab**: Browse and manage chat sessions.
- **Usage tab**: View per-session and aggregate token usage statistics.
- **Logs tab**: View extension runtime logs for debugging.
- **Actions tab**: Configure suggested action buttons for the chat input.
- **General tab**: Voice settings (TTS/STT engine, auto-mode), locale, UI preferences.

## Dependencies
- `packages/config-panels` (tab panel components and group definitions)
- `packages/storage` (Chrome storage + IndexedDB)
- `packages/ui` (shadcn/ui components)
- `packages/i18n` (internationalization)

## Gate
`pnpm build && pnpm quality` — exit 0.
