# R15: Skills System — `packages/skills/` + `packages/config-panels/`

## Scope
Markdown prompt templates with YAML frontmatter metadata and `{{variable}}` substitution. Skills appear as quick actions in the chat input, stored in IndexedDB as workspace files, scoped globally or per-agent.

## Key Files
| File/Package | Role |
|---|---|
| `packages/skills/` | Skill template loading and parsing |
| `packages/config-panels/` | Options → Agent → Skills tab panel |
| `packages/storage/` | IndexedDB persistence (workspace files) |
| `packages/ui/` | Quick action buttons in chat input |

## Architecture
Skills are markdown documents with YAML frontmatter that define reusable prompt templates.

**Skill format:**
```markdown
---
name: Code Review
description: Review code for bugs, security issues, and improvements
icon: magnifying-glass
---

Review the following code for:
1. Bugs and logical errors
2. Security vulnerabilities

{{code}}
```

**Variable substitution flow:**
```
User clicks skill quick action
  → If skill has {{variables}}, prompt user to fill them in
  → Substitute values into template
  → Send expanded prompt as chat message
  → Agent processes like any other message
```

**Storage model:**
- Skills stored as workspace files in IndexedDB (`workspaceFiles` table)
- **Global** — Available to all agents
- **Agent-specific** — Scoped to a particular agent

**Frontmatter fields:**
| Field | Required | Description |
|---|---|---|
| `name` | Yes | Display name in quick actions |
| `description` | No | Tooltip/description text |
| `icon` | No | Icon identifier for the button |

## Key Types/Interfaces
```typescript
// Skill parsed from markdown with frontmatter
interface Skill {
  name: string;
  description?: string;
  icon?: string;
  template: string;       // markdown body with {{variable}} placeholders
  variables: string[];    // extracted variable names
}
```

## Behavior
- **Quick actions**: Skills appear as buttons in the chat input area. Click to activate.
- **Variable prompting**: When a skill contains `{{variableName}}` placeholders, the user is prompted to provide values before the template is expanded and sent.
- **No special tool integration**: Skills work through the normal agent message flow. The LLM may use tools (web search, workspace, etc.) as instructed by the skill template.
- **Suggested actions**: Simpler than skills — no variable substitution. Configured under Options → Settings → Actions. Quick-action buttons shown below chat input.
- **Creation**: Options → Agent → Skills → Add Skill. Define name, description, and prompt template.
- **Agent scoping**: Skills can be global (all agents) or agent-specific, following the same scoping model as workspace files.

## Dependencies
- `packages/storage` (IndexedDB workspace files)
- `packages/ui` (quick action button components)
- YAML frontmatter parsing
- Chat input UI (side panel + full-page chat)

## Gate
`pnpm build && pnpm quality` — exit 0.
