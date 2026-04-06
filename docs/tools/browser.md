---
summary: "Browser automation tool — Chrome DevTools Protocol for DOM snapshots, clicking, typing, screenshots, JS evaluation, and console/network logs."
read_when:
  - Using browser automation features
  - Understanding CDP integration
  - Automating web interactions
title: "Browser Automation"
---

# Browser Automation

The `browser` tool provides full browser control via the Chrome DevTools Protocol (CDP). It can list tabs, navigate, take screenshots, interact with page elements, and capture console and network logs.

## Actions

| Action | Description |
|--------|-------------|
| `tabs` | List all open browser tabs |
| `open` | Open a new tab with optional URL |
| `close` | Close a tab by ID |
| `focus` | Focus/activate a tab |
| `navigate` | Navigate a tab to a URL |
| `content` | Extract text content (optional CSS selector) |
| `snapshot` | DOM snapshot with numbered element refs |
| `screenshot` | Capture a screenshot (viewport or full page) |
| `click` | Click an element by ref number |
| `type` | Type text into an element by ref number |
| `evaluate` | Execute a JavaScript expression in the page |
| `console` | View console log entries |
| `network` | View network request/response log |

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | string | (required) One of the actions above |
| `tabId` | number | Target tab ID |
| `url` | string | URL for `open` / `navigate` |
| `active` | boolean | Whether to activate the tab |
| `ref` | number | Element ref from snapshot for `click` / `type` |
| `text` | string | Text to type |
| `selector` | string | CSS selector for `content` extraction |
| `expression` | string | JS expression for `evaluate` |
| `fullPage` | boolean | Full-page screenshot |
| `limit` | number | Max entries for `console` / `network` (default: 50) |

## DOM snapshots

The `snapshot` action creates a structured representation of the page with numbered element refs:

```
[1] <button> Submit
[2] <input type="text" placeholder="Enter name">
[3] <a href="/about"> About Us
```

Each element gets a unique ref number that you can use with `click` or `type` actions. The snapshot includes:
- Clickable elements (buttons, links, inputs)
- Text content
- Form field values

## Screenshots

Screenshots are returned as base64-encoded images. Use `fullPage: true` for the entire page, or omit it for just the visible viewport.

## JavaScript evaluation

The `evaluate` action runs arbitrary JavaScript in the page context:

```json
{
  "action": "evaluate",
  "tabId": 123,
  "expression": "document.title"
}
```

Returns the expression result as a string.

## Console and network logs

- **console** — View recent console.log, console.error, etc. entries
- **network** — View recent HTTP requests/responses with URLs, status codes, and timing

Both support a `limit` parameter (default 50) to control how many entries are returned.

## Debugger tool

The `debugger` tool provides direct access to the Chrome DevTools Protocol for advanced use cases:

| Action | Description |
|--------|-------------|
| `send` | Send a CDP command (e.g., `Runtime.evaluate`, `DOM.getDocument`) |
| `attach` | Attach debugger to a tab |
| `detach` | Detach debugger from a tab |
| `list_targets` | List available debug targets |

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | string | (required) One of the actions above |
| `tabId` | number | Target tab ID |
| `method` | string | CDP method name |
| `params` | object | CDP command parameters |

<Note>
The debugger tool is Chrome-only and not available on Firefox. Firefox uses the scripting API as a fallback for basic browser actions.
</Note>

## Timeouts

- Tab load: 15 seconds
- Network requests: 30 seconds
- Tool execution: 5 minutes (global)
