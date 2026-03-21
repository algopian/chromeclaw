/**
 * Builds XML tool definitions for system prompt injection.
 * Used by both web-llm-bridge and local-llm-bridge to tell non-native-tool-calling
 * models what tools are available and how to invoke them.
 */

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Escape XML special characters in attribute values and text content. */
const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Build a tool prompt section to inject into the system prompt.
 * Returns empty string if no tools are provided.
 */
const buildToolPrompt = (tools: ToolDef[]): string => {
  if (tools.length === 0) return '';

  const toolDefs = tools
    .map(t => {
      const params = t.parameters.properties
        ? Object.entries(
            t.parameters.properties as Record<string, { type?: string; description?: string }>,
          )
            .map(
              ([name, schema]) =>
                `    - ${name} (${schema.type ?? 'unknown'}): ${schema.description ?? ''}`,
            )
            .join('\n')
        : '    (no parameters)';
      return `  <tool name="${escapeXml(t.name)}">\n    <description>${escapeXml(t.description)}</description>\n    <parameters>\n${params}\n    </parameters>\n  </tool>`;
    })
    .join('\n');

  return `## Tool Use Instructions

You have access to tools. To call a tool, output XML in this exact format:
<tool_call id="unique_id" name="tool_name">{"arg": "value"}</tool_call>

Rules:
1. The 'id' attribute must be a unique 8-character string for each call.
2. The 'name' attribute must exactly match one of the available tool names.
3. The body must be a valid JSON object containing ONLY the tool arguments (do NOT include "name" or "arguments" wrapper keys).
4. Wait for the tool result before proceeding.

After a tool executes, the result will be provided as:
<tool_response id="call_id" name="tool_name">
result text
</tool_response>

<available_tools>
${toolDefs}
</available_tools>`;
};

export { buildToolPrompt, escapeXml };
export type { ToolDef };
