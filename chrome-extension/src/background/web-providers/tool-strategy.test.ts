/**
 * Tests for tool-strategy.ts — per-provider tool-calling strategies.
 */
import { describe, it, expect } from 'vitest';
import {
  getToolStrategy,
  getConversationId,
  setConversationId,
  qwenToolStrategy,
  defaultToolStrategy,
  claudeToolStrategy,
  kimiToolStrategy,
  glmToolStrategy,
  geminiToolStrategy,
} from './tool-strategy';

// ── Factory ──────────────────────────────────────

describe('getToolStrategy', () => {
  it('returns qwen strategy for qwen-web', () => {
    expect(getToolStrategy('qwen-web')).toBe(qwenToolStrategy);
  });

  it('returns qwen strategy for qwen-cn-web', () => {
    expect(getToolStrategy('qwen-cn-web')).toBe(qwenToolStrategy);
  });

  it('returns glm strategy for glm-web', () => {
    expect(getToolStrategy('glm-web')).toBe(glmToolStrategy);
  });

  it('returns glm strategy for glm-intl-web', () => {
    expect(getToolStrategy('glm-intl-web')).toBe(glmToolStrategy);
  });

  it('returns claude strategy for claude-web', () => {
    expect(getToolStrategy('claude-web')).toBe(claudeToolStrategy);
  });

  it('returns kimi strategy for kimi-web', () => {
    expect(getToolStrategy('kimi-web')).toBe(kimiToolStrategy);
  });

  it('returns gemini strategy for gemini-web', () => {
    expect(getToolStrategy('gemini-web')).toBe(geminiToolStrategy);
  });
});

// ── Default Strategy ─────────────────────────────

describe('defaultToolStrategy', () => {
  describe('buildToolPrompt', () => {
    it('delegates to XML format with <available_tools>', () => {
      const tools = [
        {
          name: 'web_search',
          description: 'Search the web',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Search query' } },
          },
        },
      ];
      const result = defaultToolStrategy.buildToolPrompt(tools);
      expect(result).toContain('<available_tools>');
      expect(result).toContain('web_search');
    });

    it('returns empty string for no tools', () => {
      expect(defaultToolStrategy.buildToolPrompt([])).toBe('');
    });
  });

  describe('buildPrompt', () => {
    it('combines systemPrompt + toolPrompt', () => {
      const result = defaultToolStrategy.buildPrompt({
        systemPrompt: 'You are helpful.',
        toolPrompt: '## Tools...',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      expect(result.systemPrompt).toBe('You are helpful.\n\n## Tools...');
      expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('passes messages through unchanged', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ];
      const result = defaultToolStrategy.buildPrompt({
        systemPrompt: 'System',
        toolPrompt: '',
        messages,
      });
      expect(result.messages).toBe(messages); // same reference
    });

    it('does not double-join when toolPrompt is empty', () => {
      const result = defaultToolStrategy.buildPrompt({
        systemPrompt: 'System',
        toolPrompt: '',
        messages: [],
      });
      expect(result.systemPrompt).toBe('System');
    });
  });
});

// ── Claude Strategy ──────────────────────────────

describe('claudeToolStrategy', () => {
  describe('buildToolPrompt', () => {
    it('prepends native-tool-override preamble to XML tool prompt', () => {
      const tools = [
        {
          name: 'web_search',
          description: 'Search the web',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Search query' } },
          },
        },
      ];
      const result = claudeToolStrategy.buildToolPrompt(tools);
      expect(result).toContain('Do NOT use native/built-in tool calls');
      expect(result).toContain('Ignore any built-in tools');
      expect(result).toContain('<available_tools>');
      expect(result).toContain('web_search');
    });

    it('returns empty string for no tools', () => {
      expect(claudeToolStrategy.buildToolPrompt([])).toBe('');
    });
  });

  describe('buildPrompt', () => {
    it('aggregates system prompt, tool prompt, and messages into a single user message', () => {
      const result = claudeToolStrategy.buildPrompt({
        systemPrompt: 'You are helpful.',
        toolPrompt: '## Tools...',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'Search for cats' },
        ],
      });

      expect(result.systemPrompt).toBe('');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toContain('System: You are helpful.');
      expect(result.messages[0].content).toContain('## Tools...');
      expect(result.messages[0].content).toContain('User: Hello');
      expect(result.messages[0].content).toContain('Assistant: Hi there');
      expect(result.messages[0].content).toContain('User: Search for cats');
    });

    it('aggregates even with conversationId (stateless — always full history)', () => {
      const result = claudeToolStrategy.buildPrompt({
        systemPrompt: 'Be helpful.',
        toolPrompt: '',
        messages: [{ role: 'user', content: 'Hello' }],
        conversationId: 'should-be-ignored',
      });

      expect(result.systemPrompt).toBe('');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toContain('System: Be helpful.');
      expect(result.messages[0].content).toContain('User: Hello');
    });
  });
});

// ── Qwen Strategy ────────────────────────────────

describe('qwenToolStrategy', () => {
  describe('buildToolPrompt', () => {
    it('returns empty string for no tools', () => {
      expect(qwenToolStrategy.buildToolPrompt([])).toBe('');
    });

    it('generates markdown tool listing (not XML)', () => {
      const tools = [
        {
          name: 'web_search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ];
      const result = qwenToolStrategy.buildToolPrompt(tools);
      expect(result).toContain('## Tool Use Instructions');
      expect(result).toContain('ALWAYS think before calling a tool');
      expect(result).toContain('#### web_search');
      expect(result).toContain('Search the web');
      expect(result).not.toContain('<available_tools>');
    });

    it('lists multiple tools with parameters', () => {
      const tools = [
        {
          name: 'web_search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
        {
          name: 'web_fetch',
          description: 'Fetch a URL',
          parameters: { type: 'object', properties: { url: { type: 'string' } } },
        },
      ];
      const result = qwenToolStrategy.buildToolPrompt(tools);
      expect(result).toContain('#### web_search');
      expect(result).toContain('#### web_fetch');
    });
  });

  describe('buildPrompt', () => {
    it('builds full prompt on first turn (no conversationId)', () => {
      const result = qwenToolStrategy.buildPrompt({
        systemPrompt: 'You are helpful.',
        toolPrompt: '## Tools...',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'Search for cats' },
        ],
      });

      expect(result.systemPrompt).toBe('');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toContain('System: You are helpful.');
      expect(result.messages[0].content).toContain('## Tools...');
      expect(result.messages[0].content).toContain('User: Hello');
      expect(result.messages[0].content).toContain('Assistant: Hi there');
      expect(result.messages[0].content).toContain('User: Search for cats');
    });

    it('sends only last user message on continuation', () => {
      const result = qwenToolStrategy.buildPrompt({
        systemPrompt: 'You are helpful.',
        toolPrompt: '## Tools...',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
          { role: 'user', content: 'Search for cats' },
        ],
        conversationId: 'conv-123',
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toContain('Search for cats');
      expect(result.messages[0].content).not.toContain('System:');
      expect(result.messages[0].content).not.toContain('Hello');
    });

    it('appends SYSTEM HINT on continuation when tools are present', () => {
      const result = qwenToolStrategy.buildPrompt({
        systemPrompt: 'You are helpful.',
        toolPrompt: '## Tools...',
        messages: [{ role: 'user', content: 'Search for cats' }],
        conversationId: 'conv-123',
      });

      expect(result.messages[0].content).toContain('[SYSTEM HINT]');
    });

    it('does not append SYSTEM HINT when no tools', () => {
      const result = qwenToolStrategy.buildPrompt({
        systemPrompt: 'You are helpful.',
        toolPrompt: '',
        messages: [{ role: 'user', content: 'Hello' }],
        conversationId: 'conv-123',
      });

      expect(result.messages[0].content).not.toContain('[SYSTEM HINT]');
    });

    it('sends tool response with proceed hint on continuation', () => {
      const result = qwenToolStrategy.buildPrompt({
        systemPrompt: 'You are helpful.',
        toolPrompt: '## Tools...',
        messages: [
          {
            role: 'user',
            content:
              '<tool_response id="abc" name="web_search">\nresults here\n</tool_response>',
          },
        ],
        conversationId: 'conv-123',
      });

      expect(result.messages[0].content).toContain('<tool_response');
      expect(result.messages[0].content).toContain(
        'Please proceed based on this tool result.',
      );
      expect(result.messages[0].content).toContain('[SYSTEM HINT]');
    });

    it('handles empty messages on continuation', () => {
      const result = qwenToolStrategy.buildPrompt({
        systemPrompt: 'System',
        toolPrompt: '',
        messages: [],
        conversationId: 'conv-123',
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('');
    });
  });

  describe('extractConversationId', () => {
    it('extracts sessionId', () => {
      expect(qwenToolStrategy.extractConversationId!({ sessionId: 'abc' })).toBe('abc');
    });

    it('extracts conversationId', () => {
      expect(qwenToolStrategy.extractConversationId!({ conversationId: 'def' })).toBe('def');
    });

    it('extracts chat_id', () => {
      expect(qwenToolStrategy.extractConversationId!({ chat_id: 'ghi' })).toBe('ghi');
    });

    it('returns undefined when no ID present', () => {
      expect(qwenToolStrategy.extractConversationId!({ text: 'hello' })).toBeUndefined();
    });

    it('prefers sessionId over conversationId', () => {
      expect(
        qwenToolStrategy.extractConversationId!({
          sessionId: 'first',
          conversationId: 'second',
        }),
      ).toBe('first');
    });
  });

  describe('serializeAssistantContent', () => {
    it('includes think blocks in serialization', () => {
      const result = qwenToolStrategy.serializeAssistantContent!([
        { type: 'thinking', thinking: 'Let me think...' },
        { type: 'text', text: 'Here is the answer.' },
      ]);
      expect(result).toContain('<think>\nLet me think...\n</think>');
      expect(result).toContain('Here is the answer.');
    });

    it('serializes tool calls as XML', () => {
      const result = qwenToolStrategy.serializeAssistantContent!([
        {
          type: 'toolCall',
          id: 'abc',
          name: 'web_search',
          arguments: { query: 'test' },
        },
      ]);
      expect(result).toContain('<tool_call id="abc" name="web_search">');
      expect(result).toContain('"query":"test"');
      expect(result).toContain('</tool_call>');
    });

    it('handles mixed content types', () => {
      const result = qwenToolStrategy.serializeAssistantContent!([
        { type: 'thinking', thinking: 'reasoning' },
        { type: 'text', text: 'I will search.' },
        {
          type: 'toolCall',
          id: 'x1',
          name: 'web_search',
          arguments: { query: 'cats' },
        },
      ]);
      expect(result).toContain('<think>');
      expect(result).toContain('I will search.');
      expect(result).toContain('<tool_call');
    });

    it('skips empty thinking blocks', () => {
      const result = qwenToolStrategy.serializeAssistantContent!([
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Hello' },
      ]);
      expect(result).not.toContain('<think>');
      expect(result).toBe('Hello');
    });
  });
});

// ── Kimi Strategy ───────────────────────────────

describe('kimiToolStrategy', () => {
  it('shares same buildToolPrompt format as qwen', () => {
    const tools = [
      {
        name: 'test',
        description: 'A test tool',
        parameters: { type: 'object', properties: {} },
      },
    ];
    expect(kimiToolStrategy.buildToolPrompt(tools)).toBe(
      qwenToolStrategy.buildToolPrompt(tools),
    );
  });

  it('always aggregates full history (no conversation ID support)', () => {
    const result = kimiToolStrategy.buildPrompt({
      systemPrompt: 'Be helpful.',
      toolPrompt: '## Tools...',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'Search cats' },
      ],
      conversationId: 'should-be-ignored',
    });

    // Kimi is stateless — always aggregates regardless of conversationId
    expect(result.systemPrompt).toBe('');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toContain('System: Be helpful.');
    expect(result.messages[0].content).toContain('## Tools...');
    expect(result.messages[0].content).toContain('User: Hello');
    expect(result.messages[0].content).toContain('Assistant: Hi there');
    expect(result.messages[0].content).toContain('User: Search cats');
  });

  it('does not have extractConversationId', () => {
    expect(kimiToolStrategy.extractConversationId).toBeUndefined();
  });

  it('serializes assistant content with think and tool_call tags', () => {
    const result = kimiToolStrategy.serializeAssistantContent!([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'I will search.' },
      { type: 'toolCall', id: 'x1', name: 'web_search', arguments: { query: 'cats' } },
    ]);
    expect(result).toContain('<think>');
    expect(result).toContain('I will search.');
    expect(result).toContain('<tool_call id="x1" name="web_search">');
  });
});

// ── GLM Strategy ───────────────────────────────

describe('glmToolStrategy', () => {
  it('shares same buildToolPrompt format as qwen', () => {
    const tools = [
      {
        name: 'test',
        description: 'A test tool',
        parameters: { type: 'object', properties: {} },
      },
    ];
    expect(glmToolStrategy.buildToolPrompt(tools)).toBe(qwenToolStrategy.buildToolPrompt(tools));
  });

  describe('buildPrompt', () => {
    it('aggregates full history on first turn (no conversationId)', () => {
      const result = glmToolStrategy.buildPrompt({
        systemPrompt: 'You are helpful.',
        toolPrompt: '## Tools...',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'Search for cats' },
        ],
      });

      expect(result.systemPrompt).toBe('');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toContain('System: You are helpful.');
      expect(result.messages[0].content).toContain('## Tools...');
      expect(result.messages[0].content).toContain('User: Hello');
      expect(result.messages[0].content).toContain('Assistant: Hi there');
      expect(result.messages[0].content).toContain('User: Search for cats');
    });

    it('sends only last user message on continuation', () => {
      const result = glmToolStrategy.buildPrompt({
        systemPrompt: 'You are helpful.',
        toolPrompt: '## Tools...',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
          { role: 'user', content: 'Search for cats' },
        ],
        conversationId: 'conv-glm-123',
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toContain('Search for cats');
      expect(result.messages[0].content).not.toContain('System:');
      expect(result.messages[0].content).not.toContain('Hello');
    });

    it('appends SYSTEM HINT on continuation when tools are present', () => {
      const result = glmToolStrategy.buildPrompt({
        systemPrompt: 'You are helpful.',
        toolPrompt: '## Tools...',
        messages: [{ role: 'user', content: 'Search for cats' }],
        conversationId: 'conv-glm-123',
      });

      expect(result.messages[0].content).toContain('[SYSTEM HINT]');
    });

    it('does not append SYSTEM HINT when no tools', () => {
      const result = glmToolStrategy.buildPrompt({
        systemPrompt: 'You are helpful.',
        toolPrompt: '',
        messages: [{ role: 'user', content: 'Hello' }],
        conversationId: 'conv-glm-123',
      });

      expect(result.messages[0].content).not.toContain('[SYSTEM HINT]');
    });

    it('sends tool response with proceed hint on continuation', () => {
      const result = glmToolStrategy.buildPrompt({
        systemPrompt: 'You are helpful.',
        toolPrompt: '## Tools...',
        messages: [
          {
            role: 'user',
            content:
              '<tool_response id="abc" name="web_search">\nresults here\n</tool_response>',
          },
        ],
        conversationId: 'conv-glm-123',
      });

      expect(result.messages[0].content).toContain('<tool_response');
      expect(result.messages[0].content).toContain(
        'Please proceed based on this tool result.',
      );
      expect(result.messages[0].content).toContain('[SYSTEM HINT]');
    });

    it('handles empty messages on continuation', () => {
      const result = glmToolStrategy.buildPrompt({
        systemPrompt: 'System',
        toolPrompt: '',
        messages: [],
        conversationId: 'conv-glm-123',
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('');
    });
  });

  describe('extractConversationId', () => {
    it('extracts conversation_id', () => {
      expect(glmToolStrategy.extractConversationId!({ conversation_id: 'glm-conv-abc' })).toBe(
        'glm-conv-abc',
      );
    });

    it('returns undefined when no conversation_id present', () => {
      expect(glmToolStrategy.extractConversationId!({ text: 'hello' })).toBeUndefined();
    });
  });

  describe('serializeAssistantContent', () => {
    it('serializes think, text, and tool_call blocks', () => {
      const result = glmToolStrategy.serializeAssistantContent!([
        { type: 'thinking', thinking: 'reasoning' },
        { type: 'text', text: 'I will search.' },
        { type: 'toolCall', id: 'x1', name: 'web_search', arguments: { query: 'cats' } },
      ]);
      expect(result).toContain('<think>');
      expect(result).toContain('I will search.');
      expect(result).toContain('<tool_call id="x1" name="web_search">');
    });

    it('skips empty thinking blocks', () => {
      const result = glmToolStrategy.serializeAssistantContent!([
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Hello' },
      ]);
      expect(result).not.toContain('<think>');
      expect(result).toBe('Hello');
    });
  });
});

// ── Gemini Strategy ──────────────────────────────

describe('geminiToolStrategy', () => {
  it('shares same buildToolPrompt format as qwen (markdown)', () => {
    const tools = [
      {
        name: 'test',
        description: 'A test tool',
        parameters: { type: 'object', properties: {} },
      },
    ];
    expect(geminiToolStrategy.buildToolPrompt(tools)).toBe(
      qwenToolStrategy.buildToolPrompt(tools),
    );
  });

  it('returns empty string for no tools', () => {
    expect(geminiToolStrategy.buildToolPrompt([])).toBe('');
  });

  describe('buildPrompt', () => {
    it('always aggregates full history (stateless, like kimi)', () => {
      const result = geminiToolStrategy.buildPrompt({
        systemPrompt: 'Be helpful.',
        toolPrompt: '## Tools...',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'Search cats' },
        ],
      });

      expect(result.systemPrompt).toBe('');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toContain('System: Be helpful.');
      expect(result.messages[0].content).toContain('## Tools...');
      expect(result.messages[0].content).toContain('User: Hello');
      expect(result.messages[0].content).toContain('Assistant: Hi there');
      expect(result.messages[0].content).toContain('User: Search cats');
    });

    it('ignores conversationId (always aggregates)', () => {
      const result = geminiToolStrategy.buildPrompt({
        systemPrompt: 'Be helpful.',
        toolPrompt: '',
        messages: [{ role: 'user', content: 'Hello' }],
        conversationId: 'should-be-ignored',
      });

      expect(result.systemPrompt).toBe('');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toContain('System: Be helpful.');
      expect(result.messages[0].content).toContain('User: Hello');
    });
  });

  it('does not have extractConversationId', () => {
    expect(geminiToolStrategy.extractConversationId).toBeUndefined();
  });

  it('serializes assistant content with think and tool_call tags', () => {
    const result = geminiToolStrategy.serializeAssistantContent!([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'I will search.' },
      { type: 'toolCall', id: 'x1', name: 'web_search', arguments: { query: 'cats' } },
    ]);
    expect(result).toContain('<think>');
    expect(result).toContain('I will search.');
    expect(result).toContain('<tool_call id="x1" name="web_search">');
  });
});

// ── Conversation ID Cache ────────────────────────

describe('conversation ID cache', () => {
  it('stores and retrieves conversation IDs', () => {
    setConversationId('test-key', 'conv-123');
    expect(getConversationId('test-key')).toBe('conv-123');
  });

  it('returns undefined for unknown keys', () => {
    expect(getConversationId('nonexistent-key')).toBeUndefined();
  });

  it('overwrites existing values', () => {
    setConversationId('overwrite-key', 'first');
    setConversationId('overwrite-key', 'second');
    expect(getConversationId('overwrite-key')).toBe('second');
  });
});
