import { describe, it, expect } from 'vitest';
import {
  parseOpenAIReasoningSignature,
  downgradeOpenAIReasoningBlocks,
  downgradeOpenAIFunctionCallReasoningPairs,
} from './openai-reasoning-sanitization';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

// ── Helpers ──────────────────────────────────────────────

const makeAssistant = (
  content: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): AgentMessage =>
  ({
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt-4o',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...extra,
  }) as AgentMessage;

const makeToolResult = (toolCallId: string): AgentMessage =>
  ({
    role: 'toolResult',
    toolCallId,
    toolName: 'test_tool',
    content: [{ type: 'text', text: 'result' }],
    isError: false,
    timestamp: Date.now(),
  }) as AgentMessage;

const makeUser = (text = 'hello'): AgentMessage =>
  ({ role: 'user', content: text, timestamp: Date.now() }) as AgentMessage;

// ── parseOpenAIReasoningSignature ────────────────────────

describe('parseOpenAIReasoningSignature', () => {
  it('parses valid JSON string with rs_ prefix', () => {
    const result = parseOpenAIReasoningSignature('{"id":"rs_abc123","type":"reasoning"}');
    expect(result).toEqual({ id: 'rs_abc123', type: 'reasoning' });
  });

  it('parses valid object directly', () => {
    const result = parseOpenAIReasoningSignature({ id: 'rs_xyz', type: 'reasoning' });
    expect(result).toEqual({ id: 'rs_xyz', type: 'reasoning' });
  });

  it('accepts reasoning.* type prefix', () => {
    const result = parseOpenAIReasoningSignature({ id: 'rs_1', type: 'reasoning.summary' });
    expect(result).toEqual({ id: 'rs_1', type: 'reasoning.summary' });
  });

  it('returns null for id without rs_ prefix', () => {
    expect(parseOpenAIReasoningSignature({ id: 'abc', type: 'reasoning' })).toBeNull();
  });

  it('returns null for missing type field', () => {
    expect(parseOpenAIReasoningSignature({ id: 'rs_abc' })).toBeNull();
  });

  it('returns null for wrong type', () => {
    expect(parseOpenAIReasoningSignature({ id: 'rs_abc', type: 'other' })).toBeNull();
  });

  it('returns null for non-JSON string', () => {
    expect(parseOpenAIReasoningSignature('not json')).toBeNull();
  });

  it('returns null for falsy input', () => {
    expect(parseOpenAIReasoningSignature(null)).toBeNull();
    expect(parseOpenAIReasoningSignature(undefined)).toBeNull();
    expect(parseOpenAIReasoningSignature('')).toBeNull();
    expect(parseOpenAIReasoningSignature(0)).toBeNull();
  });

  it('handles whitespace around JSON string', () => {
    const result = parseOpenAIReasoningSignature('  {"id":"rs_abc","type":"reasoning"}  ');
    expect(result).toEqual({ id: 'rs_abc', type: 'reasoning' });
  });
});

// ── downgradeOpenAIReasoningBlocks ───────────────────────

describe('downgradeOpenAIReasoningBlocks', () => {
  it('keeps thinking with signature when followed by text', () => {
    const messages = [
      makeAssistant([
        { type: 'thinking', thinking: 'hmm', thinkingSignature: '{"id":"rs_1","type":"reasoning"}' },
        { type: 'text', text: 'answer' },
      ]),
    ];
    const result = downgradeOpenAIReasoningBlocks(messages);
    expect(result).toHaveLength(1);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(2);
    expect(content[0]!.type).toBe('thinking');
  });

  it('drops thinking with signature at end of turn (standalone)', () => {
    const messages = [
      makeAssistant([
        { type: 'text', text: 'hello' },
        { type: 'thinking', thinking: 'hmm', thinkingSignature: '{"id":"rs_1","type":"reasoning"}' },
      ]),
    ];
    const result = downgradeOpenAIReasoningBlocks(messages);
    expect(result).toHaveLength(1);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
  });

  it('keeps thinking without signature (not OpenAI reasoning)', () => {
    const messages = [
      makeAssistant([
        { type: 'thinking', thinking: 'hmm' },
      ]),
    ];
    const result = downgradeOpenAIReasoningBlocks(messages);
    expect(result).toHaveLength(1);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('thinking');
  });

  it('drops entire assistant message when all blocks are standalone reasoning', () => {
    const messages = [
      makeAssistant([
        { type: 'thinking', thinking: 'hmm', thinkingSignature: '{"id":"rs_1","type":"reasoning"}' },
      ]),
    ];
    const result = downgradeOpenAIReasoningBlocks(messages);
    expect(result).toHaveLength(0);
  });

  it('passes through non-assistant messages unchanged', () => {
    const user = makeUser('hi');
    const toolResult = makeToolResult('tc-1');
    const messages = [user, toolResult];
    const result = downgradeOpenAIReasoningBlocks(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(user);
    expect(result[1]).toBe(toolResult);
  });

  it('keeps thinking with signature when followed by toolCall', () => {
    const messages = [
      makeAssistant([
        { type: 'thinking', thinking: 'hmm', thinkingSignature: '{"id":"rs_1","type":"reasoning"}' },
        { type: 'toolCall', id: 'tc-1', name: 'search', arguments: {} },
      ]),
    ];
    const result = downgradeOpenAIReasoningBlocks(messages);
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(content).toHaveLength(2);
  });
});

// ── downgradeOpenAIFunctionCallReasoningPairs ────────────

describe('downgradeOpenAIFunctionCallReasoningPairs', () => {
  it('keeps |fc_ suffix when valid reasoning is present', () => {
    const messages = [
      makeAssistant([
        { type: 'thinking', thinking: 'hmm', thinkingSignature: '{"id":"rs_1","type":"reasoning"}' },
        { type: 'toolCall', id: 'call_abc|fc_item1', name: 'search', arguments: {} },
      ]),
      makeToolResult('call_abc|fc_item1'),
    ];
    const result = downgradeOpenAIFunctionCallReasoningPairs(messages);
    const content = (result[0] as { content: Array<{ id?: string }> }).content;
    expect(content[1]!.id).toBe('call_abc|fc_item1');
    expect((result[1] as { toolCallId: string }).toolCallId).toBe('call_abc|fc_item1');
  });

  it('strips |fc_ suffix when no reasoning is present', () => {
    const messages = [
      makeAssistant([
        { type: 'toolCall', id: 'call_abc|fc_item1', name: 'search', arguments: {} },
      ]),
      makeToolResult('call_abc|fc_item1'),
    ];
    const result = downgradeOpenAIFunctionCallReasoningPairs(messages);
    const content = (result[0] as { content: Array<{ id?: string }> }).content;
    expect(content[0]!.id).toBe('call_abc');
    expect((result[1] as { toolCallId: string }).toolCallId).toBe('call_abc');
  });

  it('does not modify tool calls without |fc_ suffix', () => {
    const messages = [
      makeAssistant([
        { type: 'toolCall', id: 'call_abc', name: 'search', arguments: {} },
      ]),
      makeToolResult('call_abc'),
    ];
    const result = downgradeOpenAIFunctionCallReasoningPairs(messages);
    // Should return original reference (no change)
    expect(result).toBe(messages);
  });

  it('returns original array when nothing changed', () => {
    const messages = [makeUser('hi')];
    const result = downgradeOpenAIFunctionCallReasoningPairs(messages);
    expect(result).toBe(messages);
  });

  it('handles mixed: some tool calls with |fc_, some without', () => {
    const messages = [
      makeAssistant([
        { type: 'toolCall', id: 'call_a|fc_x', name: 'tool1', arguments: {} },
        { type: 'toolCall', id: 'call_b', name: 'tool2', arguments: {} },
      ]),
      makeToolResult('call_a|fc_x'),
      makeToolResult('call_b'),
    ];
    const result = downgradeOpenAIFunctionCallReasoningPairs(messages);
    const content = (result[0] as { content: Array<{ id?: string }> }).content;
    expect(content[0]!.id).toBe('call_a'); // |fc_x stripped
    expect(content[1]!.id).toBe('call_b'); // no |fc_ suffix, unchanged
    expect((result[1] as { toolCallId: string }).toolCallId).toBe('call_a');
    // call_b toolResult shouldn't be rewritten (not in pendingRewrittenIds)
    expect((result[2] as { toolCallId: string }).toolCallId).toBe('call_b');
  });

  it('does not strip non-fc_ suffixes', () => {
    const messages = [
      makeAssistant([
        { type: 'toolCall', id: 'call_abc|other_item', name: 'search', arguments: {} },
      ]),
    ];
    const result = downgradeOpenAIFunctionCallReasoningPairs(messages);
    expect(result).toBe(messages);
  });
});
