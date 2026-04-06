---
summary: "Custom agent tools — register JavaScript workspace files as per-agent callable tools with @tool metadata."
read_when:
  - Creating custom tools for specific agents
  - Understanding per-agent tool registration
  - Extending agent capabilities with JavaScript
title: "Custom Agent Tools"
---

# Custom Agent Tools

Each agent can have custom JavaScript tools registered from workspace files. These tools are only available to the agent they're registered with, allowing different agents to have different capabilities.

## Overview

Custom tools extend an agent's built-in tool set with your own JavaScript functions. They use `@tool` metadata comments for definition and run in the JS sandbox.

For full documentation on the `@tool` format, see [Custom Tools](/tools/custom-tools).

## Per-agent registration

Custom tools are stored in each agent's `customTools` array. To register a tool for a specific agent:

1. Create a workspace file with `@tool` metadata
2. Register it using the `execute_javascript` tool with `action: "register"`
3. The tool is added to the active agent's tool set

When you switch agents, the available custom tools change to match the new agent's registrations.

## Example: API integration tool

Create a workspace file `jira-search.js`:

```javascript
// @tool jira_search
// @description Search Jira issues by JQL query
// @param jql string "JQL query string"
// @param maxResults number "Maximum results to return"

const response = await fetch('https://your-jira.atlassian.net/rest/api/3/search', {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${btoa('email@example.com:YOUR_API_TOKEN')}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    jql: args.jql,
    maxResults: args.maxResults || 10,
    fields: ['summary', 'status', 'assignee', 'priority']
  })
});

const data = await response.json();
return data.issues.map(i => ({
  key: i.key,
  summary: i.fields.summary,
  status: i.fields.status.name,
  assignee: i.fields.assignee?.displayName || 'Unassigned'
}));
```

Register it:
```
Register jira-search.js as a custom tool for this agent
```

Now the agent can search Jira:
```
Search Jira for open bugs assigned to me
```

## Managing custom tools

- **List**: Use the `list` workspace tool to see all files, including registered tools
- **Update**: Edit the workspace file — changes take effect on next use
- **Unregister**: Use `execute_javascript` with `action: "unregister"`
- **Per-agent**: Switch agents to manage tools for different agents

## Execution environment

Custom tools run in the same sandbox as `execute_javascript`:

- Access arguments via the `args` object
- Use `return` to send results back to the LLM
- `async`/`await` supported
- Console output captured
- Module imports via `window.__modules` (bundle first)
- 30-second default timeout (configurable up to 5 minutes)
