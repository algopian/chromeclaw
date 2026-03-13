import { parseSlashCommand, getSlashCommands, executeSlashCommand } from './index';
import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from './types';

const mockContext = (): SlashCommandContext => ({
  chatId: 'test-chat',
  messages: [],
  model: { id: 'test', name: 'Test', provider: 'openai', routingMode: 'direct' },
  appendSystemMessage: vi.fn(),
  replaceMessages: vi.fn(),
  clearInput: vi.fn(),
  resetUsage: vi.fn(),
  incrementCompactionCount: vi.fn(),
  setIsCompacting: vi.fn(),
});

describe('parseSlashCommand', () => {
  it('returns null for non-commands', () => {
    expect(parseSlashCommand('hello')).toBeNull();
  });

  it('returns null for invalid slash patterns', () => {
    expect(parseSlashCommand('/ space')).toBeNull();
    expect(parseSlashCommand('//double')).toBeNull();
  });

  it('parses known commands', () => {
    expect(parseSlashCommand('/clear')).toEqual({ command: 'clear', args: '' });
    expect(parseSlashCommand('/compact')).toEqual({ command: 'compact', args: '' });
  });

  it('is case-insensitive', () => {
    expect(parseSlashCommand('/CLEAR')).toEqual({ command: 'clear', args: '' });
    expect(parseSlashCommand('/Clear')).toEqual({ command: 'clear', args: '' });
  });

  it('returns null for unknown commands', () => {
    expect(parseSlashCommand('/unknown')).toBeNull();
    expect(parseSlashCommand('/foo')).toBeNull();
    expect(parseSlashCommand('/help')).toBeNull();
  });

  it('handles leading and trailing whitespace', () => {
    expect(parseSlashCommand('  /clear  ')).toEqual({ command: 'clear', args: '' });
  });

  it('returns null when command is embedded in text', () => {
    expect(parseSlashCommand('hey /clear')).toBeNull();
    expect(parseSlashCommand('run /clear now')).toBeNull();
  });

  it('returns null for multi-line input with command', () => {
    expect(parseSlashCommand('/clear\nmore text')).toBeNull();
    expect(parseSlashCommand('/compact\n')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseSlashCommand('')).toBeNull();
    expect(parseSlashCommand('   ')).toBeNull();
  });

  it('returns null for slash with args', () => {
    expect(parseSlashCommand('/clear me')).toBeNull();
  });
});

describe('getSlashCommands', () => {
  it('returns all registered commands', () => {
    const cmds = getSlashCommands();
    const names = cmds.map(c => c.name);
    expect(names).toContain('clear');
    expect(names).toContain('compact');
    expect(cmds.length).toBe(2);
  });

  it('each command has a name and description', () => {
    for (const cmd of getSlashCommands()) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(typeof cmd.execute).toBe('function');
    }
  });
});

describe('executeSlashCommand', () => {
  it('executes clear command', async () => {
    const ctx = mockContext();
    const result = await executeSlashCommand('clear', ctx);
    expect(result).toBe(true);
    expect(ctx.clearInput).toHaveBeenCalledOnce();
  });

  it('returns false for unknown command', async () => {
    const ctx = mockContext();
    const result = await executeSlashCommand('nonexistent', ctx);
    expect(result).toBe(false);
  });
});
