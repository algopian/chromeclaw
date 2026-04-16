# R3: Agent System — `chrome-extension/src/background/agents/`

## Scope
Multi-agent persona system with per-agent workspace files, memory, model config, tool config, and custom JS tools. Covers the agent loop (prompt → stream → tools → follow-ups → steering).

## Key Files
| File/Package | Role |
|---|---|
| `chrome-extension/src/background/agents/` | Agent loop, model adapter, stream handler |
| `chrome-extension/src/background/context/` | System prompt assembly from workspace + tools + agent config |
| `packages/storage/` | Agent persistence in IndexedDB |
| `packages/config-panels/` | Agent management UI (Agents settings tab) |

## Architecture
Each agent is a named AI persona with isolated configuration:

- **Identity** — Name, description, avatar/emoji
- **Model** — Per-agent LLM override (or global default)
- **Tools** — Per-agent tool availability overrides + custom JS tools
- **Workspace files** — Scoped SOUL.md, AGENTS.md, USER.md, IDENTITY.md, TOOLS.md, MEMORY.md + custom files
- **Memory** — Separate memory scope per agent

**Agent loop per turn**:
1. Build system prompt from workspace files, tool descriptions, and agent config
2. Stream LLM response with text, reasoning, and tool calls
3. Execute tool calls with schema validation and timeout management
4. Process follow-ups — handle multi-turn tool interactions (auto-continue until task complete)
5. Handle steering — user corrections mid-turn queued and applied at next opportunity

**Chat history is shared** across agents; only the agent context (system prompt, tools, workspace) changes on switch.

## Key Types/Interfaces
```typescript
// Agent stored in IndexedDB
interface Agent {
  id: string;
  name: string;
  emoji?: string;
  description?: string;
  modelId?: string;          // per-agent model override
  enabledTools?: Record<string, boolean>;  // per-agent tool overrides
  customTools?: CustomTool[];
}

// agents_list tool output
interface AgentsListResult {
  agentCount: number;
  activeAgentId: string;
  agents: Array<{ id: string; name: string; emoji: string; isDefault: boolean; isActive: boolean }>;
}
```

## Behavior
- **Steering messages**: If user sends a message while agent is processing, it's queued as a steering message and injected at the next turn boundary
- **Follow-up mode**: After tool execution, agent may auto-generate follow-up turns to complete multi-step tasks
- **Custom tools**: Per-agent JS tools registered via `@tool` metadata in workspace files, executed in JS sandbox with 30s default timeout
- **`agents_list` tool**: LLM can query available agents programmatically
- **First-run setup**: When `models.length === 0`, `<FirstRunSetup>` shown instead of chat UI

## Dependencies
- Workspace files (R8) — system prompt context
- Tool system (R4) — tool execution within agent loop
- Memory system (R5) — per-agent memory scoping
- Streaming architecture (R2) — Port-based LLM communication
- `packages/storage/` — agent and chat persistence

## Gate
`pnpm build && pnpm quality` — exit 0.
