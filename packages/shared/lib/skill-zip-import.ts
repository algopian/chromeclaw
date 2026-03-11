/**
 * Import a skill from a .zip file.
 *
 * Extracts all files from the zip, validates SKILL.md frontmatter, and returns
 * the skill directory and all file contents for the caller to create.
 */

import { parseSkillFrontmatter } from './skill-parser.js';
import JSZip from 'jszip';

const MAX_ZIP_SIZE = 1 * 1024 * 1024; // 1 MB

const toKebabCase = (str: string): string =>
  str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

interface SkillImportFile {
  path: string; // relative path under skills/{name}/, e.g. "SKILL.md", "data/example.json"
  content: string;
}

interface SkillImportResult {
  name: string;
  skillDir: string; // e.g. "skills/my-skill"
  files: SkillImportFile[];
}

/**
 * Import a skill from a zip file.
 *
 * The zip must contain exactly one SKILL.md at the root or inside a single
 * top-level directory (e.g., `my-skill/SKILL.md`).
 *
 * Returns all files from the ZIP with paths relative to the skill directory.
 *
 * @throws Error on validation failure
 */
const importSkillFromZip = async (file: File): Promise<SkillImportResult> => {
  if (file.size > MAX_ZIP_SIZE) {
    throw new Error(`Zip file too large (${Math.round(file.size / 1024)}KB). Maximum is 1MB.`);
  }

  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Find all SKILL.md files in the zip
  const skillFiles: { path: string; dir: string | null }[] = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    const filename = relativePath.split('/').pop();
    if (filename?.toUpperCase() === 'SKILL.MD') {
      const parts = relativePath.split('/');
      const dir = parts.length > 1 ? parts[0] : null;
      skillFiles.push({ path: relativePath, dir });
    }
  });

  if (skillFiles.length === 0) {
    throw new Error('No SKILL.md found in zip file.');
  }

  if (skillFiles.length > 1) {
    throw new Error('Multiple SKILL.md files found in zip. Expected exactly one.');
  }

  const entry = skillFiles[0];
  const zipFile = zip.file(entry.path);
  if (!zipFile) {
    throw new Error('Failed to read SKILL.md from zip.');
  }

  const skillMdContent = await zipFile.async('string');
  const metadata = parseSkillFrontmatter(skillMdContent);

  if (!metadata) {
    throw new Error('SKILL.md has invalid or missing frontmatter. Required: name, description.');
  }

  // Derive skill name from directory name in zip, or kebab-cased frontmatter name
  const skillName = entry.dir ? toKebabCase(entry.dir) : toKebabCase(metadata.name);

  if (!skillName) {
    throw new Error('Could not derive skill name from zip contents or frontmatter.');
  }

  const skillDir = `skills/${skillName}`;

  // Extract all non-directory files from the zip
  const files: SkillImportFile[] = [];
  const filePromises: Promise<void>[] = [];

  zip.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) return;
    filePromises.push(
      zipEntry.async('string').then(content => {
        // Normalize path: strip top-level directory prefix if present
        let normalizedPath = relativePath;
        if (entry.dir && relativePath.startsWith(entry.dir + '/')) {
          normalizedPath = relativePath.slice(entry.dir.length + 1);
        }
        files.push({ path: normalizedPath, content });
      }),
    );
  });

  await Promise.all(filePromises);

  return {
    name: metadata.name,
    skillDir,
    files,
  };
};

export type { SkillImportResult, SkillImportFile };
export { importSkillFromZip };
