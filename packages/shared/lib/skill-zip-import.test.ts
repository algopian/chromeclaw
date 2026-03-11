import { importSkillFromZip } from './skill-zip-import';
import JSZip from 'jszip';
import { describe, it, expect } from 'vitest';

const VALID_SKILL_MD = `---
name: My Test Skill
description: A test skill
---

# My Test Skill

Instructions here.
`;

const createZipFile = async (
  files: Record<string, string>,
  sizeOverride?: number,
): Promise<File> => {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const file = new File([blob], 'test.zip', { type: 'application/zip' });
  if (sizeOverride) {
    Object.defineProperty(file, 'size', { value: sizeOverride });
  }
  return file;
};

describe('importSkillFromZip', () => {
  it('extracts SKILL.md from root of zip', async () => {
    const file = await createZipFile({ 'SKILL.md': VALID_SKILL_MD });
    const result = await importSkillFromZip(file);
    expect(result.name).toBe('My Test Skill');
    expect(result.skillDir).toBe('skills/my-test-skill');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('SKILL.md');
    expect(result.files[0].content).toBe(VALID_SKILL_MD);
  });

  it('extracts SKILL.md from single top-level directory', async () => {
    const file = await createZipFile({ 'my-cool-skill/SKILL.md': VALID_SKILL_MD });
    const result = await importSkillFromZip(file);
    expect(result.name).toBe('My Test Skill');
    expect(result.skillDir).toBe('skills/my-cool-skill');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('SKILL.md');
    expect(result.files[0].content).toBe(VALID_SKILL_MD);
  });

  it('derives skill name from directory name in zip', async () => {
    const file = await createZipFile({ 'Custom Skill Name/SKILL.md': VALID_SKILL_MD });
    const result = await importSkillFromZip(file);
    expect(result.skillDir).toBe('skills/custom-skill-name');
  });

  it('falls back to kebab-cased frontmatter name when no directory', async () => {
    const file = await createZipFile({ 'SKILL.md': VALID_SKILL_MD });
    const result = await importSkillFromZip(file);
    expect(result.skillDir).toBe('skills/my-test-skill');
  });

  it('rejects zip without SKILL.md', async () => {
    const file = await createZipFile({ 'README.md': '# Hello' });
    await expect(importSkillFromZip(file)).rejects.toThrow('No SKILL.md found');
  });

  it('rejects zip with multiple SKILL.md files', async () => {
    const file = await createZipFile({
      'skill-a/SKILL.md': VALID_SKILL_MD,
      'skill-b/SKILL.md': VALID_SKILL_MD,
    });
    await expect(importSkillFromZip(file)).rejects.toThrow('Multiple SKILL.md');
  });

  it('rejects zip exceeding 1 MB', async () => {
    const file = await createZipFile({ 'SKILL.md': VALID_SKILL_MD }, 2 * 1024 * 1024);
    await expect(importSkillFromZip(file)).rejects.toThrow('too large');
  });

  it('rejects SKILL.md with invalid frontmatter', async () => {
    const badContent = '# Just a markdown file\n\nNo frontmatter.';
    const file = await createZipFile({ 'SKILL.md': badContent });
    await expect(importSkillFromZip(file)).rejects.toThrow('invalid or missing frontmatter');
  });

  it('returns correct skillDir (skills/{name})', async () => {
    const file = await createZipFile({ 'web-research/SKILL.md': VALID_SKILL_MD });
    const result = await importSkillFromZip(file);
    expect(result.skillDir).toBe('skills/web-research');
  });

  it('extracts all files from zip with multiple files', async () => {
    const file = await createZipFile({
      'SKILL.md': VALID_SKILL_MD,
      'data/example.json': '{"key": "value"}',
      'templates/prompt.txt': 'Hello {{name}}',
    });
    const result = await importSkillFromZip(file);
    expect(result.files).toHaveLength(3);
    const paths = result.files.map(f => f.path).sort();
    expect(paths).toEqual(['SKILL.md', 'data/example.json', 'templates/prompt.txt']);
    expect(result.files.find(f => f.path === 'data/example.json')?.content).toBe(
      '{"key": "value"}',
    );
  });

  it('extracts all files from zip with top-level directory', async () => {
    const file = await createZipFile({
      'my-skill/SKILL.md': VALID_SKILL_MD,
      'my-skill/data/example.json': '{"key": "value"}',
      'my-skill/README.md': '# Readme',
    });
    const result = await importSkillFromZip(file);
    expect(result.skillDir).toBe('skills/my-skill');
    expect(result.files).toHaveLength(3);
    const paths = result.files.map(f => f.path).sort();
    expect(paths).toEqual(['README.md', 'SKILL.md', 'data/example.json']);
  });

  it('preserves nested folder structure in file paths', async () => {
    const file = await createZipFile({
      'my-skill/SKILL.md': VALID_SKILL_MD,
      'my-skill/a/b/c/deep.txt': 'deep content',
    });
    const result = await importSkillFromZip(file);
    const deepFile = result.files.find(f => f.path === 'a/b/c/deep.txt');
    expect(deepFile).toBeDefined();
    expect(deepFile?.content).toBe('deep content');
  });
});
