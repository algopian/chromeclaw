---
summary: "Workspace files provide persistent LLM context — AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md, MEMORY.md, and custom files."
read_when:
  - Configuring workspace files
  - Understanding how persistent context works
  - Customizing agent behavior via workspace files
title: "Workspace Files"
---

# Workspace Files

Workspace files provide persistent context that is injected into every LLM conversation as part of the system prompt. They let you shape agent behavior, provide background information, and maintain long-term state.

## Predefined files

ChromeClaw includes six predefined workspace files:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent behavior instructions and rules |
| `SOUL.md` | Personality, tone, and communication style |
| `USER.md` | User-specific context (your name, preferences, background) |
| `IDENTITY.md` | Agent identity (name, role, description) |
| `TOOLS.md` | Tool usage guidance and preferences |
| `MEMORY.md` | Auto-curated memory summary (managed by the memory system) |

Each file can be enabled or disabled independently. Enabled files are included in the system prompt for every message.

## Custom files

You can create additional workspace files to provide any context you need:

- Project documentation
- Code style guides
- Domain-specific knowledge
- Reference data
- Custom instructions

Create custom files using the workspace tools (`write`, `read`, `edit`, `list`, `delete`, `rename`) or through the Options page.

## Per-agent scoping

Workspace files are scoped per agent. Each agent has its own set of workspace files, allowing different agents to have different context. When you switch agents, the workspace files change accordingly.

The `MEMORY.md` file is particularly useful here — each agent maintains its own memory summary, building up distinct knowledge over time.

## How files are injected

When a conversation starts or continues:

1. The service worker loads all enabled workspace files for the active agent
2. File contents are assembled into the system prompt
3. The system prompt is sent to the LLM along with the conversation history

This means workspace files affect every turn of the conversation, not just the first message.

## MEMORY.md

The `MEMORY.md` file is special — it's automatically curated by the memory system:

- When you switch chats, the [session journaling](/concepts/memory#session-journaling) system extracts durable memories from the conversation
- New memories are appended to dated files (`memory/YYYY-MM-DD.md`)
- The `MEMORY.md` summary is updated to reflect the most important long-term facts
- The file is kept under 4000 characters to fit within context limits

You can also edit `MEMORY.md` manually to add or remove information.

## Managing workspace files

### From the chat

Use the workspace tools to manage files directly in conversation:

```
Write a USER.md with my preferences:
- Name: Alex
- Role: Senior engineer
- Preferred language: TypeScript
```

### From the Options page

Navigate to the **Agent** tab group → **Tools** to view and manage workspace files.

## Best practices

- Keep files concise — every token in a workspace file uses context window space
- Use `SOUL.md` for personality traits and communication style
- Use `AGENTS.md` for behavioral rules and constraints
- Use `USER.md` for personal context that helps the agent tailor responses
- Use `TOOLS.md` to guide when and how tools should be used
- Let `MEMORY.md` be managed automatically — edit manually only for corrections
- Use custom files for domain-specific reference data
