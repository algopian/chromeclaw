import { chatDb } from './chat-db';
import {
  createWorkspaceFile,
  getWorkspaceFile,
  listWorkspaceFiles,
  listUserWorkspaceFiles,
  listAgentMemoryFiles,
  updateWorkspaceFile,
  deleteWorkspaceFile,
  getEnabledWorkspaceFiles,
  seedPredefinedWorkspaceFiles,
} from './chat-storage';
import { describe, it, expect, beforeEach } from 'vitest';
import type { DbWorkspaceFile } from './chat-db';

beforeEach(async () => {
  await chatDb.workspaceFiles.clear();
});

const makeWorkspaceFile = (overrides: Partial<DbWorkspaceFile> = {}): DbWorkspaceFile => ({
  id: 'ws-1',
  name: 'test-file.md',
  content: 'Test content',
  enabled: true,
  owner: 'user',
  predefined: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

describe('Workspace File CRUD', () => {
  it('creates and retrieves a workspace file', async () => {
    const file = makeWorkspaceFile();
    await createWorkspaceFile(file);
    const retrieved = await getWorkspaceFile('ws-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('test-file.md');
    expect(retrieved!.content).toBe('Test content');
  });

  it('lists all workspace files', async () => {
    await createWorkspaceFile(makeWorkspaceFile({ id: 'ws-1', owner: 'user' }));
    await createWorkspaceFile(
      makeWorkspaceFile({ id: 'ws-2', name: 'agent-file.md', owner: 'agent' }),
    );
    const files = await listWorkspaceFiles();
    expect(files).toHaveLength(2);
  });

  it('listUserWorkspaceFiles returns only user-owned files', async () => {
    await createWorkspaceFile(makeWorkspaceFile({ id: 'ws-1', owner: 'user' }));
    await createWorkspaceFile(
      makeWorkspaceFile({ id: 'ws-2', name: 'agent-file.md', owner: 'agent' }),
    );
    const userFiles = await listUserWorkspaceFiles();
    expect(userFiles).toHaveLength(1);
    expect(userFiles[0]!.owner).toBe('user');
  });

  it('listAgentMemoryFiles returns only agent-owned files', async () => {
    await createWorkspaceFile(makeWorkspaceFile({ id: 'ws-1', owner: 'user' }));
    await createWorkspaceFile(
      makeWorkspaceFile({ id: 'ws-2', name: 'memory/log.md', owner: 'agent' }),
    );
    const agentFiles = await listAgentMemoryFiles();
    expect(agentFiles).toHaveLength(1);
    expect(agentFiles[0]!.owner).toBe('agent');
  });

  it('updates workspace file content', async () => {
    await createWorkspaceFile(makeWorkspaceFile());
    await updateWorkspaceFile('ws-1', { content: 'Updated content' });
    const file = await getWorkspaceFile('ws-1');
    expect(file!.content).toBe('Updated content');
  });

  it('toggles workspace file enabled/disabled', async () => {
    await createWorkspaceFile(makeWorkspaceFile({ enabled: true }));
    await updateWorkspaceFile('ws-1', { enabled: false });
    const file = await getWorkspaceFile('ws-1');
    expect(file!.enabled).toBe(false);
  });

  it('deletes custom user workspace file', async () => {
    await createWorkspaceFile(makeWorkspaceFile({ predefined: false }));
    await deleteWorkspaceFile('ws-1');
    const file = await getWorkspaceFile('ws-1');
    expect(file).toBeUndefined();
  });

  it('deleteWorkspaceFile rejects deletion of predefined files', async () => {
    await createWorkspaceFile(makeWorkspaceFile({ predefined: true }));
    await expect(deleteWorkspaceFile('ws-1')).rejects.toThrow(
      'Cannot delete predefined workspace files',
    );
  });

  it('deletes agent memory file', async () => {
    await createWorkspaceFile(
      makeWorkspaceFile({ id: 'ws-agent', owner: 'agent', predefined: false }),
    );
    await deleteWorkspaceFile('ws-agent');
    const file = await getWorkspaceFile('ws-agent');
    expect(file).toBeUndefined();
  });

  it('getEnabledWorkspaceFiles returns only enabled files', async () => {
    await createWorkspaceFile(makeWorkspaceFile({ id: 'ws-1', enabled: true }));
    await createWorkspaceFile(
      makeWorkspaceFile({ id: 'ws-2', name: 'disabled.md', enabled: false }),
    );
    const enabled = await getEnabledWorkspaceFiles();
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.id).toBe('ws-1');
  });

  it('getEnabledWorkspaceFiles returns empty array when none enabled', async () => {
    await createWorkspaceFile(makeWorkspaceFile({ id: 'ws-1', enabled: false }));
    const enabled = await getEnabledWorkspaceFiles();
    expect(enabled).toEqual([]);
  });
});

describe('Predefined File Seeding', () => {
  it('seedPredefinedWorkspaceFiles creates 10 files on empty table', async () => {
    await seedPredefinedWorkspaceFiles();
    const files = await listWorkspaceFiles();
    expect(files).toHaveLength(10);
  });

  it('seedPredefinedWorkspaceFiles is idempotent (no duplicates)', async () => {
    await seedPredefinedWorkspaceFiles();
    await seedPredefinedWorkspaceFiles();
    const files = await listWorkspaceFiles();
    expect(files).toHaveLength(10);
  });

  it('predefined files have correct names and owner=user', async () => {
    await seedPredefinedWorkspaceFiles();
    const files = await listWorkspaceFiles();
    const names = files.map(f => f.name).sort();
    expect(names).toEqual([
      'AGENTS.md',
      'HEARTBEAT.md',
      'IDENTITY.md',
      'MEMORY.md',
      'SOUL.md',
      'TOOLS.md',
      'USER.md',
      'skills/daily-journal/SKILL.md',
      'skills/skill-creator/SKILL.md',
      'skills/tool-creator/SKILL.md',
    ]);
    for (const file of files) {
      expect(file.owner).toBe('user');
      expect(file.predefined).toBe(true);
      if (file.name.startsWith('skills/')) {
        expect(file.enabled).toBe(false);
      } else {
        expect(file.enabled).toBe(true);
      }
    }
  });
});
