/**
 * Tests for xml-tag-parser.ts — shared XML tag parser for LLM text streams.
 */
import { describe, it, expect, vi } from 'vitest';
import { createXmlTagParser } from './xml-tag-parser';

vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

describe('createXmlTagParser', () => {
  it('passes plain text through', () => {
    const parser = createXmlTagParser();
    const events = parser.feed('Hello world');
    expect(events).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('parses <think> block into thinking_start + thinking_delta + thinking_end', () => {
    const parser = createXmlTagParser();
    const events = parser.feed('<think>reasoning here</think>');
    expect(events).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking_delta', text: 'reasoning here' },
      { type: 'thinking_end' },
    ]);
  });

  it('handles incremental <think> delivery across multiple feed() calls', () => {
    const parser = createXmlTagParser();

    const e1 = parser.feed('<think>part');
    expect(e1).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking_delta', text: 'part' },
    ]);

    const e2 = parser.feed(' one');
    expect(e2).toEqual([{ type: 'thinking_delta', text: ' one' }]);

    const e3 = parser.feed('</think>after');
    expect(e3).toEqual([
      { type: 'thinking_end' },
      { type: 'text', text: 'after' },
    ]);
  });

  it('parses <tool_call> with JSON body', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<tool_call>{"name":"web_search","arguments":{"query":"test"}}</tool_call>',
    );
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'test-uuid',
        name: 'web_search',
        arguments: { query: 'test' },
      },
    ]);
  });

  it('parses <tool_call> with id and name attributes — body is arguments', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<tool_call id="abc" name="web_search">{"query":"test"}</tool_call>',
    );
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'abc',
        name: 'web_search',
        arguments: { query: 'test' },
      },
    ]);
  });

  it('emits tool_call_malformed for invalid JSON', () => {
    const parser = createXmlTagParser();
    const events = parser.feed('<tool_call>not valid json</tool_call>');
    expect(events).toEqual([
      { type: 'tool_call_malformed', rawText: 'not valid json' },
    ]);
  });

  it('strips ```json wrapper from tool_call body', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<tool_call>```json\n{"name":"read","arguments":{"path":"a.txt"}}\n```</tool_call>',
    );
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'test-uuid',
        name: 'read',
        arguments: { path: 'a.txt' },
      },
    ]);
  });

  it('double-parses string arguments', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<tool_call>{"name":"search","arguments":"{\\"query\\":\\"hello\\"}"}</tool_call>',
    );
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'test-uuid',
        name: 'search',
        arguments: { query: 'hello' },
      },
    ]);
  });

  it('strips special tokens like <|im_end|>', () => {
    const parser = createXmlTagParser();
    const events = parser.feed('Hello<|im_end|> world<|im_start|>!');
    expect(events).toEqual([{ type: 'text', text: 'Hello world!' }]);
  });

  it('handles mixed text + think + tool_call', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      'Let me think.<think>hmm</think>Ok, searching.<tool_call>{"name":"web_search","arguments":{"query":"test"}}</tool_call>Done.',
    );
    expect(events).toEqual([
      { type: 'text', text: 'Let me think.' },
      { type: 'thinking_start' },
      { type: 'thinking_delta', text: 'hmm' },
      { type: 'thinking_end' },
      { type: 'text', text: 'Ok, searching.' },
      {
        type: 'tool_call',
        id: 'test-uuid',
        name: 'web_search',
        arguments: { query: 'test' },
      },
      { type: 'text', text: 'Done.' },
    ]);
  });

  it('buffers partial tag (<t → wait → ool_call>...)', () => {
    const parser = createXmlTagParser();

    // Send partial tag start
    const e1 = parser.feed('<t');
    expect(e1).toEqual([]); // Buffered, waiting for more

    // Complete the tag
    const e2 = parser.feed(
      'ool_call>{"name":"test","arguments":{}}</tool_call>',
    );
    expect(e2).toEqual([
      {
        type: 'tool_call',
        id: 'test-uuid',
        name: 'test',
        arguments: {},
      },
    ]);
  });

  it('flush() with unclosed <think> emits thinking_end', () => {
    const parser = createXmlTagParser();
    parser.feed('<think>unclosed thinking');
    const events = parser.flush();
    expect(events).toEqual([{ type: 'thinking_end' }]);
  });

  it('flush() with unclosed <tool_call> and invalid JSON emits tool_call_malformed', () => {
    const parser = createXmlTagParser();
    parser.feed('<tool_call>{"incomplete":');
    const events = parser.flush();
    expect(events).toEqual([
      { type: 'tool_call_malformed', rawText: '{"incomplete":' },
    ]);
  });

  it('flush() with unclosed <tool_call> and valid JSON parses tool_call', () => {
    const parser = createXmlTagParser();
    parser.feed('<tool_call id="abc" name="deep_research">{"topic": "test"}');
    const events = parser.flush();
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'abc',
        name: 'deep_research',
        arguments: { topic: 'test' },
      },
    ]);
  });

  it('flush() strips incomplete closing tag (e.g. GLM sends "</tool_call" without ">")', () => {
    const parser = createXmlTagParser();
    parser.feed('<tool_call id="search001" name="web_search">');
    parser.feed('\n{"query": "小红书 热帖"}\n</tool_call');
    const events = parser.flush();
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'search001',
        name: 'web_search',
        arguments: { query: '小红书 热帖' },
      },
    ]);
  });

  it('flush() strips incomplete closing tag with Chinese suffix (e.g. "</tool_call的工具")', () => {
    const parser = createXmlTagParser();
    parser.feed('<tool_call id="t1" name="search">');
    parser.feed('{"q":"test"}\n</tool_call的工具');
    const events = parser.flush();
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 't1',
        name: 'search',
        arguments: { q: 'test' },
      },
    ]);
  });

  it('flush() handles tool_call body with no trailing incomplete tag', () => {
    const parser = createXmlTagParser();
    parser.feed('<tool_call id="t1" name="search">{"q":"test"}');
    const events = parser.flush();
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 't1',
        name: 'search',
        arguments: { q: 'test' },
      },
    ]);
  });

  it('flush() with only incomplete closing tag and no body emits empty result', () => {
    const parser = createXmlTagParser();
    parser.feed('<tool_call id="t1" name="search">');
    parser.feed('</tool_call');
    const events = parser.flush();
    // After stripping incomplete closing tag, toolCallBuffer is empty — nothing to emit
    expect(events).toEqual([]);
  });

  it('buffers attribute-based tool_call tag arriving in small chunks', () => {
    const parser = createXmlTagParser();

    // Simulate streaming: the opening tag arrives in pieces exceeding 30 chars
    const e1 = parser.feed('<tool_call id="a1b2c3d4" ');
    expect(e1).toEqual([]); // Still buffering — no closing >

    const e2 = parser.feed('name="deep_research">');
    expect(e2).toEqual([]); // Tag opened, now in tool_call state, waiting for body+close

    const e3 = parser.feed('{"topic": "test"}</tool_call>');
    expect(e3).toEqual([
      {
        type: 'tool_call',
        id: 'a1b2c3d4',
        name: 'deep_research',
        arguments: { topic: 'test' },
      },
    ]);
  });

  it('buffers long attribute-based tag with text before it', () => {
    const parser = createXmlTagParser();

    // Text before the tag, then a long attribute tag split across chunks
    const e1 = parser.feed('Let me search.');
    expect(e1).toEqual([{ type: 'text', text: 'Let me search.' }]);

    const e2 = parser.feed('<tool_call id="x1y2z3w4" name="web_search">');
    expect(e2).toEqual([]); // Tag consumed, now in tool_call state

    const e3 = parser.feed('{"query": "weather SF"}</tool_call>');
    expect(e3).toEqual([
      {
        type: 'tool_call',
        id: 'x1y2z3w4',
        name: 'web_search',
        arguments: { query: 'weather SF' },
      },
    ]);
  });

  it('handles multiple sequential tool_calls', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
        '<tool_call>{"name":"b","arguments":{"x":1}}</tool_call>',
    );
    expect(events).toEqual([
      { type: 'tool_call', id: 'test-uuid', name: 'a', arguments: {} },
      { type: 'tool_call', id: 'test-uuid', name: 'b', arguments: { x: 1 } },
    ]);
  });

  it('retains partial tag at end of buffer when preceded by text', () => {
    const parser = createXmlTagParser();

    // Chunk ends with partial "<tool_" — should NOT emit it as text
    const e1 = parser.feed('Let me search.<tool_');
    expect(e1).toEqual([{ type: 'text', text: 'Let me search.' }]);

    // Complete the tag
    const e2 = parser.feed('call id="abc" name="web_search">{"query":"test"}</tool_call>');
    expect(e2).toEqual([
      {
        type: 'tool_call',
        id: 'abc',
        name: 'web_search',
        arguments: { query: 'test' },
      },
    ]);
  });

  it('retains bare "<" at end of buffer', () => {
    const parser = createXmlTagParser();

    const e1 = parser.feed('some text<');
    expect(e1).toEqual([{ type: 'text', text: 'some text' }]);

    const e2 = parser.feed('tool_call>{"name":"a","arguments":{}}</tool_call>');
    expect(e2).toEqual([
      { type: 'tool_call', id: 'test-uuid', name: 'a', arguments: {} },
    ]);
  });

  it('emits "<" as text if followed by non-tag content', () => {
    const parser = createXmlTagParser();

    const e1 = parser.feed('5 <');
    expect(e1).toEqual([{ type: 'text', text: '5 ' }]);

    // Next chunk makes it clear this is not a tag
    const e2 = parser.feed('10 is true');
    expect(e2).toEqual([{ type: 'text', text: '<10 is true' }]);
  });

  it('handles tool_call tag split across many SSE chunks', () => {
    const parser = createXmlTagParser();

    // Simulate token-by-token delivery like Qwen
    const e1 = parser.feed('I will research this.\n\n');
    expect(e1).toEqual([{ type: 'text', text: 'I will research this.\n\n' }]);

    const e2 = parser.feed('<');
    expect(e2).toEqual([]);

    const e3 = parser.feed('tool_call');
    expect(e3).toEqual([]);

    const e4 = parser.feed(' id="x1" name="deep_research"');
    expect(e4).toEqual([]);

    const e5 = parser.feed('>');
    expect(e5).toEqual([]); // now in tool_call state

    const e6 = parser.feed('{"topic": "test"}');
    expect(e6).toEqual([]);

    const e7 = parser.feed('</tool_call>');
    expect(e7).toEqual([
      {
        type: 'tool_call',
        id: 'x1',
        name: 'deep_research',
        arguments: { topic: 'test' },
      },
    ]);
  });

  it('retains partial <think at end of buffer', () => {
    const parser = createXmlTagParser();

    const e1 = parser.feed('Hmm, <th');
    expect(e1).toEqual([{ type: 'text', text: 'Hmm, ' }]);

    const e2 = parser.feed('ink>reasoning</think>');
    expect(e2).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking_delta', text: 'reasoning' },
      { type: 'thinking_end' },
    ]);
  });

  it('does not retain non-matching < in middle of text', () => {
    const parser = createXmlTagParser();

    // "<b>" is not a plausible tag prefix — should be emitted as text
    const events = parser.feed('use <b>bold</b> text');
    expect(events).toEqual([{ type: 'text', text: 'use <b>bold</b> text' }]);
  });

  // ── Case-insensitive tag matching ──────────────

  it('parses case-insensitive <Tool_Call> tag', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<Tool_Call>{"name":"test","arguments":{}}</Tool_Call>',
    );
    expect(events).toEqual([
      { type: 'tool_call', id: 'test-uuid', name: 'test', arguments: {} },
    ]);
  });

  it('parses case-insensitive <TOOL_CALL> tag', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<TOOL_CALL>{"name":"test","arguments":{}}</TOOL_CALL>',
    );
    expect(events).toEqual([
      { type: 'tool_call', id: 'test-uuid', name: 'test', arguments: {} },
    ]);
  });

  it('parses case-insensitive <Think> block', () => {
    const parser = createXmlTagParser();
    const events = parser.feed('<Think>reasoning</Think>');
    expect(events).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking_delta', text: 'reasoning' },
      { type: 'thinking_end' },
    ]);
  });

  it('parses case-insensitive <THINK> block', () => {
    const parser = createXmlTagParser();
    const events = parser.feed('<THINK>deep thought</THINK>');
    expect(events).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking_delta', text: 'deep thought' },
      { type: 'thinking_end' },
    ]);
  });

  it('handles mixed-case tool_call with attributes', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<Tool_Call id="abc" name="web_search">{"query":"test"}</Tool_Call>',
    );
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'abc',
        name: 'web_search',
        arguments: { query: 'test' },
      },
    ]);
  });

  // ── Flexible attribute quoting ─────────────────

  it('handles single-quoted attributes', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      "<tool_call id='abc' name='web_search'>{\"query\":\"test\"}</tool_call>",
    );
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'abc',
        name: 'web_search',
        arguments: { query: 'test' },
      },
    ]);
  });

  it('handles unquoted attributes', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<tool_call id=abc name=web_search>{"query":"test"}</tool_call>',
    );
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'abc',
        name: 'web_search',
        arguments: { query: 'test' },
      },
    ]);
  });

  it('handles mixed quote styles in attributes', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<tool_call id="abc" name=\'web_search\'>{"query":"test"}</tool_call>',
    );
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'abc',
        name: 'web_search',
        arguments: { query: 'test' },
      },
    ]);
  });

  // ── Double-wrapped <tool_call> (Qwen format) ──

  it('handles double-wrapped tool_call (Qwen format)', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<tool_call>\n<tool_call id="research01" name="deep_research">{"topic": "quantum computing"}\n</tool_call>',
    );
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'research01',
        name: 'deep_research',
        arguments: { topic: 'quantum computing' },
      },
    ]);
  });

  it('handles double-wrapped tool_call with streaming delivery', () => {
    const parser = createXmlTagParser();

    // Bare outer <tool_call> arrives first
    const e1 = parser.feed('Thinking completed\n<tool_call>');
    expect(e1).toEqual([{ type: 'text', text: 'Thinking completed\n' }]);

    // Inner attributed tag arrives in next chunk
    const e2 = parser.feed('\n<tool_call id="r01" name="deep_research">');
    expect(e2).toEqual([]);

    // JSON body and closing tag
    const e3 = parser.feed('{"topic": "AI safety"}\n</tool_call>');
    expect(e3).toEqual([
      {
        type: 'tool_call',
        id: 'r01',
        name: 'deep_research',
        arguments: { topic: 'AI safety' },
      },
    ]);
  });

  it('handles closing tag split across feed() calls', () => {
    const parser = createXmlTagParser();

    parser.feed('<tool_call id="e5f6g7h8" name="web_search">');
    const e1 = parser.feed('{"query":"test","maxResults":5}');
    expect(e1).toEqual([]);

    // Closing tag split: "\n</" then "tool_call>"
    const e2 = parser.feed('\n</');
    expect(e2).toEqual([]);

    const e3 = parser.feed('tool_call>');
    expect(e3).toEqual([
      {
        type: 'tool_call',
        id: 'e5f6g7h8',
        name: 'web_search',
        arguments: { query: 'test', maxResults: 5 },
      },
    ]);
  });

  it('returns tool_call_malformed for double-wrapped with invalid inner JSON', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<tool_call>\n<tool_call id="r01" name="deep_research">not valid json\n</tool_call>',
    );
    expect(events).toEqual([
      {
        type: 'tool_call_malformed',
        rawText: '\n<tool_call id="r01" name="deep_research">not valid json\n',
      },
    ]);
  });
});

describe('hallucinated tool_response suppression', () => {
  it('discards <tool_response>...</tool_response> content entirely', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      'Hello<tool_response id="t1" name="web_fetch">\nSan Francisco: +55°F\n</tool_response>\nGoodbye',
    );
    expect(events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: '\nGoodbye' },
    ]);
  });

  it('discards tool_response after tool_call', () => {
    const parser = createXmlTagParser();
    const events = parser.feed(
      '<tool_call id="a1" name="web_fetch">{"url":"https://example.com"}</tool_call>\n\n<tool_response id="a1" name="web_fetch">\nfake data\n</tool_response>\n\nReal answer here.',
    );
    const types = events.map(e => e.type);
    expect(types).toContain('tool_call');
    expect(types).not.toContain('tool_call_malformed');
    // tool_response content should not appear in any text event
    const textContent = events
      .filter(e => e.type === 'text')
      .map(e => (e as { type: 'text'; text: string }).text)
      .join('');
    expect(textContent).not.toContain('fake data');
    expect(textContent).toContain('Real answer here.');
  });

  it('handles tool_response split across chunks', () => {
    const parser = createXmlTagParser();
    const e1 = parser.feed('Before<tool_response id="t1" name="search">');
    const e2 = parser.feed('hallucinated content');
    const e3 = parser.feed('</tool_response>After');
    const all = [...e1, ...e2, ...e3];
    const text = all
      .filter(e => e.type === 'text')
      .map(e => (e as { type: 'text'; text: string }).text)
      .join('');
    expect(text).toBe('BeforeAfter');
  });

  it('discards unclosed tool_response on flush', () => {
    const parser = createXmlTagParser();
    const e1 = parser.feed('Text<tool_response id="t1" name="x">no closing tag');
    const e2 = parser.flush();
    const all = [...e1, ...e2];
    const text = all
      .filter(e => e.type === 'text')
      .map(e => (e as { type: 'text'; text: string }).text)
      .join('');
    expect(text).toBe('Text');
    expect(text).not.toContain('no closing tag');
  });
});
