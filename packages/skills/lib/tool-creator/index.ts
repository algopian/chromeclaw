const TOOL_CREATOR_SKILL = `---
name: Tool Creator
description: Create, register, and manage custom tools using execute_javascript. Use when
  the user wants to add a new tool, build a custom command, extend the assistant's
  capabilities with JavaScript, or register/unregister a workspace file as a tool.
---

# Custom Tool Creator

Guide for creating custom tools via the \`execute_javascript\` tool.

## Prerequisites

\`execute_javascript\` must be enabled in **Settings > Tools**. If it is not enabled,
tell the user to enable it first.

## How Custom Tools Work

A custom tool is a JavaScript workspace file with metadata comments. Once registered,
it appears as a callable tool alongside built-in tools.

### Step 1: Write the Tool File

Create a workspace file (e.g. \`tools/my-tool.js\`) using the \`write\` tool:

\`\`\`javascript
// @tool search_notes
// @description Search through saved notes by keyword
// @param query string "The search term"
// @param limit number "Max results to return"

// Tool body — runs inside an async wrapper. Args are available via the \`args\` object.
const results = [];
const query = args.query;
// ... implementation ...
return JSON.stringify(results);
\`\`\`

### Metadata Comments

| Tag | Required | Format |
|-----|----------|--------|
| \`@tool\` | Yes | \`// @tool <name>\` — snake_case identifier |
| \`@description\` | Yes | \`// @description <text>\` — what the tool does |
| \`@param\` | No | \`// @param <name> <type> "<description>"\` |
| \`@prompt\` | No | \`// @prompt <text>\` — hint shown to the assistant for when/how to use the tool |

Supported param types: \`string\`, \`number\`, \`boolean\`, \`unknown\`.

### Step 2: Register

\`\`\`
execute_javascript({ action: "register", path: "tools/my-tool.js" })
\`\`\`

This parses the metadata, adds the tool to the agent, and enables it. The tool is now
callable by name. Re-registering the same path updates the definition.

### Step 3: Use

Once registered, the tool appears in the tool list and can be called like any built-in tool.

### Unregister

\`\`\`
execute_javascript({ action: "unregister", path: "tools/my-tool.js" })
\`\`\`

## Execution Environment

- **Sandbox (default)**: Runs in an isolated tab — no access to page DOM or cookies. Safer.
- **Browser tab**: Pass \`tabId\` to run in a specific tab's context (DOM access, cookies, etc.).
  Get tab IDs with \`browser({ action: 'tabs' })\`.
- **Args**: Available as \`args.paramName\` (e.g. \`args.query\`, \`args.limit\`). Always an object,
  even if no params are passed.
- **Auto-return**: When executing a workspace file (via \`path\` or as a registered custom tool),
  code starting with \`(\` (e.g. an IIFE) automatically gets \`return\` prepended so the value
  is captured. Inline \`code\` does not get auto-return — use explicit \`return\`.
- **Shared state**: \`window.__modules\` persists across calls in the same tab. Use \`exportAs\`
  to store a return value for later use.
- **Console capture**: \`console.log/warn/error\` output is captured and returned with results.
- **Timeout**: Default 30s, max 5 min. Set via \`timeout\` parameter.

## Bundle Action

Combine multiple workspace files as modules, then run epilogue code:

\`\`\`
execute_javascript({
  action: "bundle",
  files: ["tools/utils.js", "tools/api-client.js"],
  code: "return window.__modules.api_client.fetch('/data')"
})
\`\`\`

Each file's return value is stored in \`window.__modules[moduleName]\` where \`moduleName\`
is derived from the filename (e.g. \`api-client.js\` becomes \`api_client\`).

## Complete Example

\`\`\`javascript
// @tool word_count
// @description Count words in the given text
// @param text string "The text to count words in"

const words = args.text.trim().split(/\\s+/).filter(Boolean);
return JSON.stringify({ count: words.length });
\`\`\`

1. Write this to \`tools/word-count.js\` using the write tool
2. Register: \`execute_javascript({ action: "register", path: "tools/word-count.js" })\`
3. Call: \`word_count({ text: "Hello world" })\` → \`{ "count": 2 }\`
`;

export { TOOL_CREATOR_SKILL };
