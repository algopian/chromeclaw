/**
 * Unit tests for skill management operations used by SkillConfig component.
 * Tests the storage layer operations that SkillConfig relies on,
 * since component rendering is covered by E2E tests.
 */
import { isSkillFile, parseSkillFrontmatter } from '@extension/shared';
import {
  listSkillFiles,
  listWorkspaceFiles,
  createWorkspaceFile,
  updateWorkspaceFile,
  deleteWorkspaceFile,
  seedPredefinedWorkspaceFiles,
  chatDb,
} from '@extension/storage';
import { describe, expect, it, beforeEach } from 'vitest';
import type { DbWorkspaceFile } from '@extension/storage';

beforeEach(async () => {
  await chatDb.workspaceFiles.clear();
  // Seed predefined files (includes bundled skills scoped to 'main')
  await seedPredefinedWorkspaceFiles();
});

describe('SkillConfig — skill list operations', () => {
  it('renders bundled skills for main agent', async () => {
    // Bundled skills are seeded with agentId='main'
    const skills = await listSkillFiles('main');
    expect(skills.length).toBe(3);
    const names = skills.map(f => f.name);
    expect(names).toContain('skills/daily-journal/SKILL.md');
    expect(names).toContain('skills/skill-creator/SKILL.md');
    expect(names).toContain('skills/tool-creator/SKILL.md');
  });

  it('global page shows only unscoped skills', async () => {
    // Predefined skills are now agent-scoped, so global starts empty
    const globalSkills = await listSkillFiles();
    expect(globalSkills.length).toBe(0);

    // Create a global (unscoped) skill
    const now = Date.now();
    await createWorkspaceFile({
      id: 'global-skill',
      name: 'skills/my-global/SKILL.md',
      content: '---\nname: Global\ndescription: A global skill\n---\n',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: now,
      updatedAt: now,
    });

    const updated = await listSkillFiles();
    expect(updated.length).toBe(1);
    expect(updated.find(f => f.id === 'global-skill')).toBeDefined();

    // Agent-scoped skills should NOT appear in global query
    await createWorkspaceFile({
      id: 'agent-only-skill',
      name: 'skills/agent-only/SKILL.md',
      content: '---\nname: Agent Only\ndescription: Scoped skill\n---\n',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: now,
      updatedAt: now,
      agentId: 'agent-1',
    });

    const afterAgent = await listSkillFiles();
    expect(afterAgent.length).toBe(1);
  });

  it('displays skill name and description from frontmatter', async () => {
    const skills = await listSkillFiles('main');
    for (const skill of skills) {
      const meta = parseSkillFrontmatter(skill.content);
      expect(meta).not.toBeNull();
      expect(meta!.name).toBeTruthy();
      expect(meta!.description).toBeTruthy();
    }
  });

  it('toggle button updates enabled state', async () => {
    const skills = await listSkillFiles('main');
    const skill = skills[0];
    expect(skill.enabled).toBe(false); // daily-journal is disabled by default

    // Toggle on
    await updateWorkspaceFile(skill.id, { enabled: true });
    const updated = await listSkillFiles('main');
    const toggled = updated.find(f => f.id === skill.id);
    expect(toggled!.enabled).toBe(true);

    // Toggle back off
    await updateWorkspaceFile(skill.id, { enabled: false });
    const restored = await listSkillFiles('main');
    const restoredSkill = restored.find(f => f.id === skill.id);
    expect(restoredSkill!.enabled).toBe(false);
  });

  it('new skill creates file with template', async () => {
    const now = Date.now();
    const file: DbWorkspaceFile = {
      id: 'test-new-skill',
      name: 'skills/untitled/SKILL.md',
      content: '---\nname: Untitled\ndescription: Describe what this skill does\n---\n',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: now,
      updatedAt: now,
    };
    await createWorkspaceFile(file);

    // Global skills: predefined skills are now agent-scoped, so only the new one is global
    const globalSkills = await listSkillFiles();
    expect(globalSkills.length).toBe(1);
    const created = globalSkills.find(f => f.id === 'test-new-skill');
    expect(created).toBeDefined();
    expect(isSkillFile(created!.name)).toBe(true);
    expect(created!.content).toContain('name: Untitled');
  });

  it('new skill auto-increments name if duplicate', async () => {
    // Create first skill
    const now = Date.now();
    await createWorkspaceFile({
      id: 'dup-1',
      name: 'skills/untitled/SKILL.md',
      content: '---\nname: Untitled\ndescription: Test\n---\n',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: now,
      updatedAt: now,
    });

    // Auto-increment logic: check existing names, generate untitled-2
    const allFiles = await listWorkspaceFiles();
    const existingNames = new Set(allFiles.map(f => f.name));
    expect(existingNames.has('skills/untitled/SKILL.md')).toBe(true);

    let skillName = 'untitled';
    let path = `skills/${skillName}/SKILL.md`;
    let counter = 2;
    while (existingNames.has(path)) {
      skillName = `untitled-${counter}`;
      path = `skills/${skillName}/SKILL.md`;
      counter++;
    }
    expect(path).toBe('skills/untitled-2/SKILL.md');
  });

  it('delete button removes custom skill', async () => {
    const now = Date.now();
    await createWorkspaceFile({
      id: 'delete-me',
      name: 'skills/to-delete/SKILL.md',
      content: '---\nname: To Delete\ndescription: Delete me\n---\n',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: now,
      updatedAt: now,
    });

    let skills = await listSkillFiles();
    expect(skills.some(f => f.id === 'delete-me')).toBe(true);

    await deleteWorkspaceFile('delete-me');

    skills = await listSkillFiles();
    expect(skills.some(f => f.id === 'delete-me')).toBe(false);
  });

  it('delete button hidden for predefined skills (deleteWorkspaceFile rejects)', async () => {
    // Predefined skills are agent-scoped, query with agentId
    const skills = await listSkillFiles('main');
    const predefined = skills.find(f => f.predefined);
    expect(predefined).toBeDefined();

    // Attempting to delete a predefined file should throw
    await expect(deleteWorkspaceFile(predefined!.id)).rejects.toThrow();
  });

  it('edit button opens inline editor (file content is accessible)', async () => {
    const skills = await listSkillFiles('main');
    const skill = skills[0];
    // The editor loads the file's name and content
    expect(skill.name).toBeTruthy();
    expect(skill.content).toBeTruthy();
    expect(skill.content).toContain('---');

    // Simulate edit: update content
    await updateWorkspaceFile(skill.id, { content: skill.content + '\n# Updated' });
    const updated = await listSkillFiles('main');
    const editedSkill = updated.find(f => f.id === skill.id);
    expect(editedSkill!.content).toContain('# Updated');
  });

  it('import creates a workspace file with correct path', async () => {
    // Simulate what happens after importSkillFromZip returns a result
    const now = Date.now();
    const importedFile: DbWorkspaceFile = {
      id: 'imported-skill',
      name: 'skills/imported-tool/SKILL.md',
      content:
        '---\nname: Imported Tool\ndescription: A skill imported from zip\n---\n\n# Instructions\n',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: now,
      updatedAt: now,
    };
    await createWorkspaceFile(importedFile);

    const skills = await listSkillFiles();
    const imported = skills.find(f => f.id === 'imported-skill');
    expect(imported).toBeDefined();
    expect(isSkillFile(imported!.name)).toBe(true);
    const meta = parseSkillFrontmatter(imported!.content);
    expect(meta!.name).toBe('Imported Tool');
  });
});

/**
 * Regression tests for BUG-17 through BUG-20.
 * These tests verify specific edge cases found during code review of FR-12.
 */
describe('SkillConfig — regression tests', () => {
  // BUG-17: Display name should come from frontmatter, not directory slug
  it('BUG-17: bundled skills display frontmatter name, not directory slug', async () => {
    // Bundled skills are agent-scoped
    const skills = await listSkillFiles('main');
    const bundled = skills.filter(f => f.predefined);
    const expectedFrontmatterNames = ['Daily Journal', 'Skill Creator', 'Tool Creator'];
    for (const skill of bundled) {
      const meta = parseSkillFrontmatter(skill.content);
      expect(meta).not.toBeNull();
      // The component uses meta.name as display name — verify these are human-readable
      // names (with spaces/capitalization), not directory slugs (with hyphens)
      expect(expectedFrontmatterNames).toContain(meta!.name);
      expect(meta!.name).not.toContain('-'); // frontmatter names use spaces, not hyphens
    }
  });

  // BUG-17: getSkillDisplayName is a fallback, not the primary display name
  it('BUG-17: directory slug is only a fallback when frontmatter is missing', async () => {
    const now = Date.now();
    // Create a skill with INVALID frontmatter (missing name)
    await createWorkspaceFile({
      id: 'no-name-skill',
      name: 'skills/my-tool/SKILL.md',
      content: '---\ndescription: Missing name field\n---\n\nSome content.',
      enabled: true,
      owner: 'user',
      predefined: false,
      createdAt: now,
      updatedAt: now,
    });

    const skills = await listSkillFiles();
    const noName = skills.find(f => f.id === 'no-name-skill');
    expect(noName).toBeDefined();
    const meta = parseSkillFrontmatter(noName!.content);
    // Frontmatter parse fails (missing name) → component falls back to directory slug
    expect(meta).toBeNull();
    // Verify the directory slug extraction works as fallback
    const match = noName!.name.match(/^skills\/([^/]+)\/SKILL\.md$/i);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('my-tool');
  });

  // BUG-19: Template heading uses generic text that doesn't need name-matching
  it('BUG-19: skill template uses generic heading, no name mismatch', () => {
    const SKILL_TEMPLATE = `---\nname: Untitled\ndescription: Describe what this skill does\n---\n\n# Skill Instructions\n\nWrite your instructions for the LLM here.\n`;
    const displayName = 'Untitled 2';
    const result = SKILL_TEMPLATE.replace(/name: Untitled/g, `name: ${displayName}`);

    // Frontmatter is updated
    expect(result).toContain('name: Untitled 2');
    // Heading is generic — no mismatch possible
    expect(result).toContain('# Skill Instructions');
  });

  // BUG-17: Verify all bundled skills have distinct frontmatter names
  it('BUG-17: all bundled skills have distinct, non-empty frontmatter names', async () => {
    // Bundled skills are agent-scoped
    const skills = await listSkillFiles('main');
    const bundled = skills.filter(f => f.predefined);
    expect(bundled.length).toBe(3);
    const names = new Set<string>();
    for (const skill of bundled) {
      const meta = parseSkillFrontmatter(skill.content);
      expect(meta).not.toBeNull();
      expect(meta!.name.length).toBeGreaterThan(0);
      expect(names.has(meta!.name)).toBe(false); // no duplicates
      names.add(meta!.name);
    }
    expect(names.size).toBe(3);
  });
});
