/**
 * Tests for tool-prompt.ts — XML tool definition builder for system prompt injection.
 */
import { describe, it, expect } from 'vitest';
import { buildToolPrompt } from './tool-prompt';

describe('buildToolPrompt', () => {
  it('returns empty string for empty tools array', () => {
    expect(buildToolPrompt([])).toBe('');
  });

  it('generates correct XML format with tool definitions', () => {
    const result = buildToolPrompt([
      {
        name: 'web_search',
        description: 'Search the web',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
        },
      },
      {
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
          },
        },
      },
    ]);

    expect(result).toContain('## Tool Use Instructions');
    expect(result).toContain('<tool_call id="unique_id" name="tool_name">{"arg": "value"}</tool_call>');
    expect(result).toContain('<tool_response id="call_id" name="tool_name">');
    expect(result).toContain('<tool name="web_search">');
    expect(result).toContain('<description>Search the web</description>');
    expect(result).toContain('- query (string): Search query');
    expect(result).toContain('<tool name="read">');
    expect(result).toContain('- path (string): File path');
  });

  it('handles tools with no properties', () => {
    const result = buildToolPrompt([
      {
        name: 'noop',
        description: 'Does nothing',
        parameters: { type: 'object' },
      },
    ]);

    expect(result).toContain('<tool name="noop">');
    expect(result).toContain('(no parameters)');
  });
});
