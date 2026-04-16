# R13: Browser & CDP Tools — `chrome-extension/src/background/tools/`

## Scope
Browser automation tool (12 actions for DOM snapshots, navigation, clicking, typing, screenshots, JS evaluation, console/network logs) and CDP/Debugger tool for direct Chrome DevTools Protocol access.

## Key Files
| File/Package | Role |
|---|---|
| `chrome-extension/src/background/tools/` | Browser tool + debugger tool implementations |
| `chrome-extension/src/background/agents/` | Tool registration and schema definitions |

## Architecture
The browser tool wraps Chrome extension APIs (tabs, scripting, debugger) into 12 high-level actions. The debugger tool provides raw CDP access for advanced use cases.

**Browser tool actions:**
| Action | Description |
|---|---|
| `tabs` | List all open browser tabs |
| `open` | Open a new tab with optional URL |
| `close` | Close a tab by ID |
| `focus` | Focus/activate a tab |
| `navigate` | Navigate a tab to a URL |
| `content` | Extract text content (optional CSS selector) |
| `snapshot` | DOM snapshot with numbered element refs |
| `screenshot` | Capture screenshot (viewport or full page) |
| `click` | Click an element by ref number |
| `type` | Type text into an element by ref number |
| `evaluate` | Execute JavaScript expression in page context |
| `console` | View console log entries |
| `network` | View network request/response log |

**Debugger tool actions:**
| Action | Description |
|---|---|
| `send` | Send a CDP command (e.g., `Runtime.evaluate`, `DOM.getDocument`) |
| `attach` | Attach debugger to a tab |
| `detach` | Detach debugger from a tab |
| `list_targets` | List available debug targets |

**DOM snapshot model:**
```
[1] <button> Submit
[2] <input type="text" placeholder="Enter name">
[3] <a href="/about"> About Us
```
Each element gets a unique ref number for use with `click`/`type` actions. Includes clickable elements, text content, and form field values.

## Key Types/Interfaces
```typescript
// Browser tool parameters
interface BrowserToolParams {
  action: 'tabs' | 'open' | 'close' | 'focus' | 'navigate' | 'content' | 'snapshot' | 'screenshot' | 'click' | 'type' | 'evaluate' | 'console' | 'network';
  tabId?: number;
  url?: string;
  active?: boolean;
  ref?: number;
  text?: string;
  selector?: string;
  expression?: string;
  fullPage?: boolean;
  limit?: number; // default: 50 for console/network
}

// Debugger tool parameters
interface DebuggerToolParams {
  action: 'send' | 'attach' | 'detach' | 'list_targets';
  tabId?: number;
  method?: string;  // CDP method name
  params?: object;  // CDP command parameters
}
```

## Behavior
- **Screenshots**: Returned as base64-encoded images. `fullPage: true` for entire page, default is viewport only.
- **JS evaluation**: Runs arbitrary JavaScript in page context via `evaluate`. Returns expression result as string.
- **Console/network logs**: `limit` parameter (default 50) controls max entries returned.
- **Timeouts**: Tab load 15s, network requests 30s, tool execution 5 minutes (global).
- **Firefox limitation**: Debugger tool is Chrome-only. Firefox uses scripting API as fallback for basic browser actions.
- **Tool loop detection**: Browser and debugger are classified as "known poll tools" with stricter repeat thresholds in the 5-level loop detection system.

## Dependencies
- Chrome Tabs API (`chrome.tabs`)
- Chrome Scripting API (`chrome.scripting`)
- Chrome Debugger API (`chrome.debugger`) — Chrome only
- Background service worker (tool execution framework)

## Gate
`pnpm build && pnpm quality` — exit 0.
