# R8: Workspace Files — `packages/storage/`

## Scope
6 predefined workspace files plus custom files, scoped per agent, injected into every LLM system prompt. Includes MEMORY.md auto-curation by the memory system.

## Key Files
| File/Package | Role |
|---|---|
| `packages/storage/` | `workspaceFiles` table in IndexedDB (Dexie.js) |
| `chrome-extension/src/background/context/` | System prompt assembly — loads and injects workspace files |
| `chrome-extension/src/background/tools/` | Workspace CRUD tools (read, write, edit, list, delete, rename) |
| `chrome-extension/src/background/memory/` | MEMORY.md auto-curation via session journaling |

## Architecture
Workspace files provide persistent context injected into **every** LLM conversation turn as part of the system prompt.

**Injection flow**:
1. Service worker loads all enabled workspace files for the active agent
2. File contents assembled into system prompt
3. System prompt sent to LLM along with conversation history

**Per-agent scoping**: Each agent has its own set of workspace files. Switching agents changes the workspace context entirely. Each agent builds up distinct knowledge in its own MEMORY.md over time.

## Predefined Files
| File | Purpose |
|---|---|
| `AGENTS.md` | Agent behavior instructions and rules |
| `SOUL.md` | Personality, tone, and communication style |
| `USER.md` | User-specific context (name, preferences, background) |
| `IDENTITY.md` | Agent identity (name, role, description) |
| `TOOLS.md` | Tool usage guidance and preferences |
| `MEMORY.md` | Auto-curated memory summary (managed by memory system) |

Each can be enabled/disabled independently.

## Custom Files
Users can create additional workspace files for:
- Project documentation, code style guides, domain knowledge, reference data, custom instructions

Managed via workspace tools (`write`, `read`, `edit`, `list`, `delete`, `rename`) or through the Options page.

## Key Types/Interfaces
```typescript
// Stored in IndexedDB workspaceFiles table
interface WorkspaceFile {
  id: string;
  agentId: string;     // per-agent scoping
  name: string;        // e.g. "SOUL.md", "custom-guide.md"
  content: string;
  enabled: boolean;
  predefined: boolean; // true for the 6 built-in files
}
```

## Behavior
- **MEMORY.md auto-curation**: On chat switch, session journaling extracts memories → appends to `memory/YYYY-MM-DD.md` → LLM integrates into MEMORY.md summary (kept ≤4000 chars). Can also be edited manually.
- **Token budget impact**: Every enabled workspace file consumes context window tokens. Users should keep files concise.
- **Workspace tools**: 6 CRUD tools (read, write, edit, list, delete, rename) allow LLM to manage files during conversation
- **Custom tools registration**: Workspace JS files with `@tool` metadata can be registered as per-agent callable tools

## Dependencies
- Memory system (R5) — MEMORY.md auto-curation and daily journal files
- Agent system (R3) — per-agent scoping
- Context compaction (R6) — workspace files included in token budget
- Tool system (R4) — workspace CRUD tools
- `packages/storage/` — IndexedDB persistence

## Gate
`pnpm build && pnpm quality` — exit 0.
