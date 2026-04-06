---
summary: "Overview of ChromeClaw's 31 built-in tools — web search, browser automation, Google services, memory, workspace, and more."
read_when:
  - Looking for a list of all available tools
  - Understanding what tools ChromeClaw supports
  - Enabling or disabling tools
title: "Tools Overview"
---

# Tools

ChromeClaw includes 31 built-in tools that extend the agent's capabilities beyond conversation. Tools are registered in a central registry with schema validation, timeout management, and custom result formatting.

## Built-in tools

| Tool | Description |
|------|-------------|
| **[Web Search](/tools/web-search)** | Search the web using Tavily API or browser-based search |
| **[Fetch URL](/tools/web-search#fetch-url)** | Retrieve and extract content from web pages |
| **[Browser](/tools/browser)** | Chrome DevTools Protocol — DOM snapshots, click/type, screenshots, JS eval |
| **[Debugger](/tools/browser#debugger)** | Send raw CDP commands to browser tabs (Chrome only) |
| **[Google Services](/tools/google)** | Gmail, Calendar, Drive via OAuth |
| **[Create Document](/tools/documents)** | Create text, code, spreadsheet, and image artifacts |
| **[Deep Research](/tools/deep-research)** | Multi-step autonomous research with parallel search and synthesis |
| **[Execute JavaScript](/tools/execute-js)** | Run JS in a sandboxed tab or specific browser tab |
| **[Memory Search](/tools/memory)** | BM25 + vector search over memory chunks |
| **[Memory Get](/tools/memory#memory-get)** | Retrieve specific memory file content |
| **[Workspace tools](/tools/workspace)** | Read, write, edit, list, delete, rename workspace files |
| **[Scheduler](/tools/workspace#scheduler)** | Create one-shot, interval, and cron-expression tasks |
| **[Subagent](/tools/deep-research#subagent)** | Spawn nested LLM calls for complex sub-tasks |
| **[Agents List](/tools/workspace#agents-list)** | List available agents |
| **[Custom tools](/tools/custom-tools)** | User-defined JS tools with `@tool` metadata |

**Total: 31 tools** (6 workspace + 4 Gmail + 4 Calendar + 3 Drive + 3 subagent + 11 others)

## Enabling tools

Tools are managed on the Options page under the **Tools** tab:

- Enable or disable each tool globally
- Override tool availability per agent
- Chrome-only tools (like Debugger) are automatically hidden on Firefox

## How tools work

1. The LLM decides to call a tool based on the conversation and tool descriptions
2. Arguments are validated against the tool's TypeBox schema
3. The tool executes with a 5-minute timeout
4. Results are formatted and returned to the LLM as content blocks
5. The LLM continues the conversation with the tool results

### Result formatting

Different tools format their results differently:

- **Text tools** — Results stringified as plain text
- **Browser** — Screenshots returned as image content blocks
- **Web fetch** — Images returned as base64 image blocks; text as metadata
- **JSON tools** — Structured data preserved with JSON formatting

### Caching

Web search and fetch results are cached for 5 minutes to avoid redundant API calls. POST requests skip the cache. Only non-empty results are cached to prevent poisoning from extraction failures.

### Tool context

Tools marked with `needsContext: true` receive a `{ chatId }` context object, allowing them to link results back to the current chat (used by subagents and the scheduler).

## Filtering

Tools are filtered based on:

- **User config** — `enabledTools[toolName]` from settings
- **Platform** — Chrome-only tools hidden on Firefox
- **Mode** — Some tools excluded in headless mode (subagent, scheduler, deep research, agents list)
- **Agent** — Per-agent tool overrides and custom tools
