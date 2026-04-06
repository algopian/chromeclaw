---
summary: "Execute JavaScript tool — run JS in a sandboxed tab, bundle workspace files, and register custom tools."
read_when:
  - Running JavaScript from the agent
  - Understanding the JS sandbox
  - Bundling and registering custom tools
title: "Execute JavaScript"
---

# Execute JavaScript

The `execute_javascript` tool runs JavaScript code in a sandboxed browser tab or a specific tab. It also supports bundling workspace files and registering custom tools.

## Actions

| Action | Description |
|--------|-------------|
| `execute` | Run JS code in the sandbox or a specific tab |
| `bundle` | Bundle workspace files for module loading |
| `register` | Register a workspace file as a custom tool |
| `unregister` | Remove a registered custom tool |

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `action` | string | (required) | One of the actions above |
| `code` | string | — | JavaScript code to execute |
| `path` | string | — | Workspace file path |
| `args` | object | — | Arguments available as `args.*` in the code |
| `files` | string[] | — | Workspace files to bundle |
| `exportAs` | string | — | Store result as `window.__modules[name]` |
| `timeout` | number | 30,000 | Execution timeout in ms (max: 300,000) |
| `tabId` | number | — | Run in specific tab instead of sandbox |

## Sandbox

By default, code runs in a dedicated sandbox tab that persists across service worker restarts:

- Isolated from the rest of the browser
- State persists between executions within the same session
- Console output is captured and returned
- Supports module imports via `window.__modules`

When `tabId` is specified, code runs directly in that page's context — useful for interacting with specific web applications.

## Examples

### Run code

```json
{
  "action": "execute",
  "code": "return 2 + 2"
}
```

### Run with arguments

```json
{
  "action": "execute",
  "code": "return `Hello, ${args.name}!`",
  "args": { "name": "Alice" }
}
```

### Bundle workspace files

```json
{
  "action": "bundle",
  "files": ["helpers.js", "utils.js"],
  "exportAs": "myModule"
}
```

After bundling, the module is available as `window.__modules.myModule` in subsequent executions.

### Register a custom tool

```json
{
  "action": "register",
  "path": "my-tool.js"
}
```

The workspace file must contain `@tool` metadata comments. See [Custom Tools](/tools/custom-tools) for details.

## Timeout

- Default: 30 seconds
- Range: 1 second to 5 minutes (300,000 ms)
- Execution is terminated if the timeout is exceeded

## Auto-return

For IIFE (Immediately Invoked Function Expression) patterns, the result is automatically returned without needing an explicit `return` statement.
