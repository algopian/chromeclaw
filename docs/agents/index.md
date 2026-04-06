---
summary: "Multi-agent system — named agents with per-agent models, tools, workspace files, memory, and custom JS tools."
read_when:
  - Creating and managing agents
  - Understanding multi-agent capabilities
  - Configuring per-agent settings
title: "Agents"
---

# Agents

ChromeClaw supports multiple named agents, each with their own model, tools, workspace files, memory, and personality. Switch between agents to get different behaviors for different tasks.

## What is an agent?

An agent is a named AI persona with its own configuration:

- **Identity** — Name, description, avatar/emoji
- **Model** — Which LLM to use (can differ per agent)
- **Tools** — Which tools are enabled (can override global settings)
- **Workspace files** — Per-agent SOUL.md, AGENTS.md, USER.md, etc.
- **Custom tools** — Agent-specific JS tools registered via `@tool` metadata
- **Memory** — Separate memory scope per agent

## Creating agents

1. Open the **Options** page → **Agent** tab group → **Agents**
2. Click **Add Agent**
3. Configure the agent's name, emoji, and description
4. Optionally set a per-agent model
5. Optionally override tool availability
6. Customize workspace files for this agent

## Switching agents

Switch between agents from the chat interface. Each agent maintains its own:

- Workspace file contents (SOUL.md, AGENTS.md, etc.)
- Custom tool registrations
- Memory scope

Chat history is shared across agents, but the agent context (system prompt, tools, workspace) changes.

## Agent loop

The agent loop processes each conversation turn:

1. **Build system prompt** from workspace files, tool descriptions, and agent config
2. **Stream LLM response** with text, reasoning, and tool calls
3. **Execute tool calls** with schema validation and timeout management
4. **Process follow-ups** — Handle multi-turn tool interactions
5. **Handle steering** — Process user corrections mid-turn

### Steering messages

If you send a message while the agent is still processing, it's queued as a "steering message" and applied at the next opportunity. This lets you correct the agent's direction mid-task.

### Follow-up mode

After tool execution, the agent may need additional turns to complete a task. Follow-up messages are auto-generated to keep the agent loop running until the task is done.

## Agent management tool

The `agents_list` tool lets the LLM query available agents:

```json
{
  "agentCount": 3,
  "activeAgentId": "default",
  "agents": [
    { "id": "default", "name": "Assistant", "emoji": "🤖", "isDefault": true, "isActive": true },
    { "id": "researcher", "name": "Researcher", "emoji": "🔬", "isDefault": false, "isActive": false }
  ]
}
```

## Per-agent models

Each agent can specify a default model that overrides the global default. This lets you create:

- A fast agent using GPT-4o mini for quick tasks
- A deep reasoning agent using o3 or Claude for complex analysis
- A local agent using Transformers.js for offline use

## Example agents

### Research assistant
- **Model**: Claude Sonnet (for quality)
- **Tools**: Web search, fetch, deep research, documents enabled
- **SOUL.md**: "You are a meticulous research assistant. Always cite sources."

### Code helper
- **Model**: GPT-4o (for speed and tools)
- **Tools**: Execute JS, browser, workspace enabled
- **SOUL.md**: "You are a concise coding assistant. Show code, not explanations."

### Personal assistant
- **Model**: Gemini Flash (for speed)
- **Tools**: Gmail, Calendar, Drive, scheduler enabled
- **SOUL.md**: "You are a friendly personal assistant managing my schedule."
