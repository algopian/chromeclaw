---
summary: "Custom JS tools — register workspace JavaScript files as callable LLM tools with @tool metadata comments."
read_when:
  - Creating custom tools for the agent
  - Understanding @tool metadata format
  - Registering JS files as tools
title: "Custom Tools"
---

# Custom Tools

ChromeClaw lets you register workspace JavaScript files as callable LLM tools. Custom tools use `@tool` metadata comments to define their name, description, and parameters.

## @tool metadata format

Add metadata comments at the top of your workspace JavaScript file:

```javascript
// @tool my_tool_name
// @description What this tool does — shown to the LLM
// @param argName type "description"
// @param anotherArg type "description"
```

### Directives

| Directive | Required | Description |
|-----------|:---:|-------------|
| `@tool` | Yes | Tool name (used as the function name in LLM tool calls) |
| `@description` | Yes | Tool description shown to the LLM |
| `@param` | No | Parameter definition: `<name> <type> "<description>"` |
| `@prompt` | No | Optional prompt hint for the LLM |

### Parameter types

| Type | Description |
|------|-------------|
| `string` | Text input |
| `number` | Numeric input |
| `boolean` | True/false |
| `any` | Any JSON value |

## Example

### Weather lookup tool

```javascript
// @tool get_weather
// @description Get the current weather for a city
// @param city string "The city name to look up"
// @param units string "Temperature units: celsius or fahrenheit"

const response = await fetch(
  `https://api.weather.example/v1/current?city=${args.city}&units=${args.units}`
);
const data = await response.json();
return `${data.temperature}° ${args.units === 'celsius' ? 'C' : 'F'} in ${args.city}`;
```

### Key points

- Arguments are available via the `args` object (e.g., `args.city`)
- Use `return` to send the result back to the LLM
- `async`/`await` is supported
- Console output is captured
- The code runs in the JS sandbox (same as `execute_javascript`)

## Registering a custom tool

### From the chat

Ask the agent to register a workspace file:

```
Register my-weather-tool.js as a custom tool
```

The agent will use `execute_javascript` with `action: "register"` and `path: "my-weather-tool.js"`.

### How registration works

1. The workspace file is read and `@tool` metadata is parsed
2. A TypeBox schema is built from `@param` definitions
3. The tool is added to the active agent's tool set
4. On subsequent LLM calls, the custom tool appears alongside built-in tools

### Unregistering

```
Unregister the get_weather tool
```

Uses `execute_javascript` with `action: "unregister"`.

## Per-agent scoping

Custom tools are registered per agent. Each agent maintains its own `customTools` array, so different agents can have different custom tool sets.

## Execution

When the LLM calls a custom tool:

1. The workspace file is read from storage
2. Arguments are validated against the parameter schema
3. The code is executed in the JS sandbox via `execute_javascript`
4. The result is formatted and returned to the LLM

## Limitations

- Custom tools run in the same sandbox as `execute_javascript`
- No direct access to Chrome APIs (must use the sandbox environment)
- Execution timeout applies (default 30 seconds, max 5 minutes)
- Module imports are supported via `window.__modules` (bundle first with `execute_javascript` bundle action)
