/**
 * Unit tests for AgentsConfig component storage operations and helpers.
 * Tests the storage layer and helper functions that AgentsConfig relies on,
 * since component rendering is covered by E2E tests.
 */
import { isSkillFile } from '@extension/shared';
import {
  listUserWorkspaceFiles,
  listAgentMemoryFiles,
  createWorkspaceFile,
  updateWorkspaceFile,
  deleteWorkspaceFile,
  seedPredefinedWorkspaceFiles,
} from '@extension/storage';
import { describe, expect, it, beforeEach } from 'vitest';
import type { DbWorkspaceFile } from '@extension/storage';

// Import helpers directly from the component module
import { formatFileSize, formatTimeAgo, parseIdentityField } from './agents-config';

beforeEach(async () => {
  await seedPredefinedWorkspaceFiles();
});

describe('AgentsConfig — workspace file list', () => {
  it('lists 7 predefined core files (excluding skills)', async () => {
    const files = await listUserWorkspaceFiles();
    const nonSkill = files.filter(f => !isSkillFile(f.name));
    expect(nonSkill.length).toBe(7);
    const names = nonSkill.map(f => f.name).sort();
    expect(names).toEqual([
      'AGENTS.md',
      'HEARTBEAT.md',
      'IDENTITY.md',
      'MEMORY.md',
      'SOUL.md',
      'TOOLS.md',
      'USER.md',
    ]);
  });

  it('lists agent memory files separately', async () => {
    const agentFiles = await listAgentMemoryFiles();
    // Initially empty — no agent-created files
    expect(agentFiles.length).toBe(0);

    // Create an agent file
    const now = Date.now();
    await createWorkspaceFile({
      id: 'agent-mem-1',
      name: 'memory/journal.md',
      content: '# Journal',
      enabled: true,
      owner: 'agent',
      predefined: false,
      createdAt: now,
      updatedAt: now,
    });

    const updated = await listAgentMemoryFiles();
    expect(updated.length).toBe(1);
    expect(updated[0].name).toBe('memory/journal.md');
    expect(updated[0].owner).toBe('agent');
  });

  it('toggle file enabled/disabled', async () => {
    const files = await listUserWorkspaceFiles();
    const memory = files.find(f => f.name === 'MEMORY.md');
    expect(memory).toBeDefined();
    expect(memory!.enabled).toBe(true);

    await updateWorkspaceFile(memory!.id, { enabled: false });
    const updated = await listUserWorkspaceFiles();
    const toggled = updated.find(f => f.id === memory!.id);
    expect(toggled!.enabled).toBe(false);

    await updateWorkspaceFile(memory!.id, { enabled: true });
    const restored = await listUserWorkspaceFiles();
    expect(restored.find(f => f.id === memory!.id)!.enabled).toBe(true);
  });

  it('content update and save', async () => {
    const files = await listUserWorkspaceFiles();
    const memory = files.find(f => f.name === 'MEMORY.md');
    expect(memory).toBeDefined();

    await updateWorkspaceFile(memory!.id, { content: 'Updated memory content' });
    const updated = await listUserWorkspaceFiles();
    const saved = updated.find(f => f.id === memory!.id);
    expect(saved!.content).toBe('Updated memory content');
  });

  it('new custom file creation', async () => {
    const now = Date.now();
    const file: DbWorkspaceFile = {
      id: 'custom-file-1',
      name: 'untitled.md',
      content: '',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: now,
      updatedAt: now,
    };
    await createWorkspaceFile(file);

    const files = await listUserWorkspaceFiles();
    const nonSkill = files.filter(f => !isSkillFile(f.name));
    expect(nonSkill.length).toBe(8); // 7 predefined + 1 custom
    const custom = nonSkill.find(f => f.id === 'custom-file-1');
    expect(custom).toBeDefined();
    expect(custom!.predefined).toBe(false);
  });

  it('custom file deletion', async () => {
    const now = Date.now();
    await createWorkspaceFile({
      id: 'delete-me',
      name: 'temp.md',
      content: 'temp',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: now,
      updatedAt: now,
    });

    let files = await listUserWorkspaceFiles();
    expect(files.some(f => f.id === 'delete-me')).toBe(true);

    await deleteWorkspaceFile('delete-me');
    files = await listUserWorkspaceFiles();
    expect(files.some(f => f.id === 'delete-me')).toBe(false);
  });

  it('predefined file delete throws', async () => {
    const files = await listUserWorkspaceFiles();
    const predefined = files.find(f => f.predefined);
    expect(predefined).toBeDefined();
    await expect(deleteWorkspaceFile(predefined!.id)).rejects.toThrow();
  });
});

describe('AgentsConfig — identity parsing', () => {
  it('parses Name field from IDENTITY.md', () => {
    const content = '- **Name:** Claw\n- **Creature:** AI';
    expect(parseIdentityField(content, 'Name')).toBe('Claw');
  });

  it('parses Emoji field from IDENTITY.md', () => {
    const content = '- **Emoji:** 🦀';
    expect(parseIdentityField(content, 'Emoji')).toBe('🦀');
  });

  it('parses Creature field from IDENTITY.md', () => {
    const content = '- **Creature:** ghost in the machine';
    expect(parseIdentityField(content, 'Creature')).toBe('ghost in the machine');
  });

  it('parses Vibe field from IDENTITY.md', () => {
    const content = '- **Vibe:** sharp and warm';
    expect(parseIdentityField(content, 'Vibe')).toBe('sharp and warm');
  });

  it('returns (not set) for template placeholders with underscores', () => {
    const content = '- **Name:** _(pick something you like)_';
    expect(parseIdentityField(content, 'Name')).toBe('(not set)');
  });

  it('returns (not set) for missing fields', () => {
    const content = '- **Creature:** AI';
    expect(parseIdentityField(content, 'Name')).toBe('(not set)');
  });

  it('returns (not set) for placeholder with leading underscore only', () => {
    const content = '- **Emoji:** _not decided_';
    expect(parseIdentityField(content, 'Emoji')).toBe('(not set)');
  });
});

describe('AgentsConfig — file metadata helpers', () => {
  it('formatFileSize returns bytes for small content', () => {
    expect(formatFileSize('')).toBe('0 B');
    expect(formatFileSize('hi')).toBe('2 B');
  });

  it('formatFileSize returns KB for larger content', () => {
    const content = 'a'.repeat(2048);
    expect(formatFileSize(content)).toBe('2.0 KB');
  });

  it('formatTimeAgo returns "just now" for recent timestamps', () => {
    expect(formatTimeAgo(Date.now())).toBe('just now');
  });

  it('formatTimeAgo returns minutes for timestamps minutes ago', () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    expect(formatTimeAgo(fiveMinutesAgo)).toBe('5m ago');
  });

  it('formatTimeAgo returns hours for timestamps hours ago', () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    expect(formatTimeAgo(twoHoursAgo)).toBe('2h ago');
  });

  it('formatTimeAgo returns days for timestamps days ago', () => {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    expect(formatTimeAgo(threeDaysAgo)).toBe('3d ago');
  });

  it('formatTimeAgo returns months for old timestamps', () => {
    const twoMonthsAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    expect(formatTimeAgo(twoMonthsAgo)).toBe('2mo ago');
  });
});
