# R16: Deep Research & Subagent — `chrome-extension/src/background/tools/`

## Scope
Subagent system for spawning nested LLM calls with independent tool sets. Includes `deep_research` (autonomous multi-step research), `spawn_subagent`, `list_subagents`, and `kill_subagent` tools. Max 3 concurrent, 30-minute expiry, progress streaming to UI.

## Key Files
| File/Package | Role |
|---|---|
| `chrome-extension/src/background/tools/` | Deep research + subagent tool implementations |
| `chrome-extension/src/background/agents/` | Agent loop, subagent execution context |
| `packages/shared/lib/chat-types.ts` | `SubagentProgressInfo`, `SubagentProgressStep` |

## Architecture
The subagent system spawns nested LLM calls that run independently in the background service worker.

**Deep research flow:**
```
User asks research question
  → deep_research tool returns immediately (non-blocking)
  → Subagent decomposes topic into sub-questions
  → Multi-iteration: web search + fetch per sub-question (parallel)
  → Synthesis into structured markdown report
  → Report delivered as system message in chat
  → Optionally saved to workspace file (saveToWorkspace: true default)
```

**Subagent tools:**
| Tool | Purpose |
|---|---|
| `spawn_subagent` | Spawn a nested LLM call with task description and optional tool whitelist |
| `list_subagents` | List active and recent subagent runs with status, task, duration |
| `kill_subagent` | Cancel a running subagent by run ID |

**Concurrency model:**
- Maximum 3 concurrent subagents
- Results expire after 30 minutes
- Each subagent has its own tool set (configurable via `tools` parameter)
- Results delivered as system messages when complete

**Progress streaming:**
```
Subagent executes steps
  → SubagentProgressInfo events streamed via chrome.runtime.Port
  → UI displays: run ID, task, step count, step summaries, duration
```

## Key Types/Interfaces
```typescript
// Deep research parameters
interface DeepResearchParams {
  topic: string;              // required
  focusAreas?: string[];      // specific sub-questions
  saveToWorkspace?: boolean;  // default: true
}

// Subagent spawn parameters
interface SpawnSubagentParams {
  task: string;               // required, self-contained task description
  tools?: string[];           // allowed tool names (optional, defaults to all)
}

// Progress tracking
interface SubagentProgressInfo {
  runId: string;
  chatId: string;
  task: string;
  startedAt: number;
  stepCount: number;
  steps: SubagentProgressStep[];
}

interface SubagentProgressStep {
  // step summary and metadata
}
```

## Behavior
- **Non-blocking**: `deep_research` and `spawn_subagent` return immediately. The parent agent can continue the conversation while subagents run.
- **Headless exclusion**: Deep research is excluded from headless mode (cron jobs, channel messages) to prevent uncontrolled background research.
- **Tool access**: Subagents can use web search, web fetch, workspace, and other tools. Tool set is configurable per spawn.
- **Result delivery**: Completed research/subagent results appear as system messages in the chat.
- **Workspace saving**: Deep research reports optionally saved to workspace files for future reference.
- **Kill**: Running subagents can be cancelled by run ID via `kill_subagent`.
- **Expiry**: Results older than 30 minutes are cleaned up.

## Dependencies
- Background service worker (agent loop, tool execution)
- Web search + web fetch tools (research iterations)
- Workspace tool (report saving)
- `chrome.runtime.Port` (progress streaming to UI)
- `packages/shared` (progress types)

## Gate
`pnpm build && pnpm quality` — exit 0.
