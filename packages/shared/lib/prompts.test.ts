import {
  regularPrompt,
  safetyPrompt,
  toolStylePrompt,
  sandboxPrompt,
  buildSystemPrompt,
  buildWebSystemPrompt,
  buildLocalSystemPrompt,
  isMemoryFile,
  BOOTSTRAP_FILENAMES,
  MAX_PER_FILE_CHARS,
  MAX_TOTAL_WORKSPACE_CHARS,
  budgetWorkspaceFiles,
} from './prompts';
import { toolRegistryMeta, resolveToolPromptHints, resolveToolListings } from './tool-registry';
import { describe, expect, it } from 'vitest';
import type { SystemPromptConfig } from './prompts';

// Helper to look up a group's promptHint from the registry
const promptHintFor = (groupKey: string): string =>
  toolRegistryMeta.find(g => g.groupKey === groupKey)!.promptHint!;

// ── buildSystemPrompt() tests ──

describe('buildSystemPrompt', () => {
  it('mode=full includes all sections', () => {
    const config: SystemPromptConfig = {
      mode: 'full',
      tools: [{ name: 'testTool', description: 'A test tool' }],
      toolPromptHints: resolveToolPromptHints({
        web_search: true,
        create_document: true,
      }),
      workspaceFiles: [
        { name: 'USER.md', content: 'User info', owner: 'user' },
        { name: 'memory/log.md', content: 'Agent notes', owner: 'agent' },
      ],
      runtimeMeta: { modelName: 'gpt-4o', currentDate: '2026-02-15' },
    };
    const result = buildSystemPrompt(config);
    expect(result.text).toContain(regularPrompt);
    expect(result.text).toContain(safetyPrompt);
    expect(result.text).toContain(toolStylePrompt);
    expect(result.text).toContain('testTool');
    expect(result.text).toContain(promptHintFor('documents'));
    expect(result.text).toContain(promptHintFor('webSearch'));
    expect(result.text).toContain('# Project Context');
    expect(result.text).toContain('User info');
    expect(result.text).not.toContain('## Memory');
    expect(result.text).not.toContain('Agent notes');
    expect(result.text).toContain('Current date: 2026-02-15');
    expect(result.text).toContain('Model: gpt-4o');
  });

  it('mode=minimal includes identity + safety + tool listing (for tiny local models)', () => {
    const config: SystemPromptConfig = {
      mode: 'minimal',
      tools: [{ name: 'testTool', description: 'A test tool' }],
      toolPromptHints: resolveToolPromptHints({
        web_search: true,
        create_document: true,
      }),
      workspaceFiles: [{ name: 'USER.md', content: 'User info', owner: 'user' }],
      runtimeMeta: { modelName: 'gpt-4o', currentDate: '2026-02-15' },
    };
    const result = buildSystemPrompt(config);
    expect(result.text).toContain(regularPrompt);
    expect(result.text).toContain(safetyPrompt);
    // Minimal includes tool listing so the model knows what tools are available
    expect(result.text).toContain('testTool');
    // But still strips tool style, hints, workspace, and runtime metadata
    expect(result.text).not.toContain(toolStylePrompt);
    expect(result.text).not.toContain(promptHintFor('documents'));
    expect(result.text).not.toContain(promptHintFor('webSearch'));
    expect(result.text).not.toContain('# Project Context');
    expect(result.text).not.toContain('Current date:');
  });

  it('mode=none returns identity only', () => {
    const config: SystemPromptConfig = {
      mode: 'none',
      tools: [{ name: 'testTool', description: 'A test tool' }],
      toolPromptHints: resolveToolPromptHints({ web_search: true }),
    };
    const result = buildSystemPrompt(config);
    expect(result.text).toBe(regularPrompt);
    expect(result.text).not.toContain(safetyPrompt);
    expect(result.text).not.toContain('testTool');
    expect(result.text).not.toContain(promptHintFor('webSearch'));
  });

  it('includes safety section with guardrails text', () => {
    const result = buildSystemPrompt({ mode: 'full' });
    expect(result.text).toContain('Prioritize safety and human oversight');
    expect(result.text).toContain('Do not pursue self-preservation');
  });

  it('includes tool descriptions when tools provided', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      tools: [
        { name: 'web_search', description: 'Search the web' },
        { name: 'web_fetch', description: 'Fetch a URL' },
      ],
    });
    expect(result.text).toContain('## Tooling');
    expect(result.text).toContain('- web_search: Search the web');
    expect(result.text).toContain('- web_fetch: Fetch a URL');
    expect(result.text).toContain('Tool names are case-sensitive');
    expect(result.text).toContain('TOOLS.md does not control tool availability');
  });

  it('includes tool style guidance', () => {
    const result = buildSystemPrompt({ mode: 'full' });
    expect(result.text).toContain(toolStylePrompt);
  });

  it('tool style prompt includes plain language and first-class tool lines', () => {
    expect(toolStylePrompt).toContain('plain human language');
    expect(toolStylePrompt).toContain('first-class tool exists');
  });

  it('includes workspace user files under Project Context heading', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [
        { name: 'USER.md', content: 'My name is Alice', owner: 'user' },
        { name: 'SOUL.md', content: 'Be kind', owner: 'user' },
      ],
    });
    expect(result.text).toContain('# Project Context');
    expect(result.text).toContain('The following project context files have been loaded:');
    expect(result.text).toContain('## USER.md');
    expect(result.text).toContain('My name is Alice');
    expect(result.text).toContain('## SOUL.md');
    expect(result.text).toContain('Be kind');
  });

  it('excludes memory files from system prompt', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [{ name: 'memory/log.md', content: 'User prefers Python', owner: 'agent' }],
    });
    expect(result.text).not.toContain('## Memory');
    expect(result.text).not.toContain('User prefers Python');
  });

  it('skips workspace section when no enabled files', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [],
    });
    expect(result.text).not.toContain('# Project Context');
    expect(result.text).not.toContain('## Memory');
  });

  it('skips workspace files with empty content', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [{ name: 'MEMORY.md', content: '', owner: 'user' }],
    });
    expect(result.text).not.toContain('# Project Context');
  });

  it('includes runtime metadata (model name, date)', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      runtimeMeta: { modelName: 'claude-sonnet-4-5-20250929', currentDate: '2026-01-15' },
    });
    expect(result.text).toContain('Current date: 2026-01-15');
    expect(result.text).toContain('Model: claude-sonnet-4-5-20250929');
  });

  it('skips runtime metadata when not provided', () => {
    const result = buildSystemPrompt({ mode: 'full' });
    expect(result.text).not.toContain('Current date:');
    expect(result.text).not.toContain('Model:');
  });

  it('includes capabilities in runtime metadata when provided', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      runtimeMeta: {
        modelName: 'gpt-4o',
        currentDate: '2026-02-15',
        capabilities: ['tools', 'vision'],
      },
    });
    expect(result.text).toContain('Capabilities: tools, vision');
  });

  it('omits capabilities from runtime metadata when empty', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      runtimeMeta: {
        modelName: 'gpt-4o',
        currentDate: '2026-02-15',
        capabilities: [],
      },
    });
    expect(result.text).not.toContain('Capabilities');
  });

  it('estimatedTokens is approximately text.length / 4', () => {
    const result = buildSystemPrompt({ mode: 'full' });
    expect(result.estimatedTokens).toBe(Math.ceil(result.text.length / 4));
  });

  it('uses custom identity when provided', () => {
    const result = buildSystemPrompt({
      mode: 'none',
      identity: 'You are a pirate assistant. Arr!',
    });
    expect(result.text).toBe('You are a pirate assistant. Arr!');
    expect(result.text).not.toContain(regularPrompt);
  });

  it('includes extraContext in full mode', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      extraContext: '## Subagent Context\n\nYou were spawned for a specific task.',
    });
    expect(result.text).toContain('## Subagent Context');
    expect(result.text).toContain('You were spawned for a specific task.');
  });

  it('excludes extraContext in minimal mode', () => {
    const result = buildSystemPrompt({
      mode: 'minimal',
      extraContext: '## Subagent Context\n\nTask: Research quantum computing',
    });
    expect(result.text).not.toContain('## Subagent Context');
    expect(result.text).not.toContain('Task: Research quantum computing');
  });

  it('excludes extraContext in none mode', () => {
    const result = buildSystemPrompt({
      mode: 'none',
      extraContext: 'Should not appear',
    });
    expect(result.text).not.toContain('Should not appear');
  });

  it('extraContext appears after runtime metadata in full mode', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      runtimeMeta: { modelName: 'gpt-4o', currentDate: '2026-03-04' },
      extraContext: '## Extra Section',
    });
    const runtimeIdx = result.text.indexOf('Model: gpt-4o');
    const extraIdx = result.text.indexOf('## Extra Section');
    expect(runtimeIdx).toBeGreaterThan(-1);
    expect(extraIdx).toBeGreaterThan(runtimeIdx);
  });

  it('minimal mode excludes workspace and extraContext', () => {
    const result = buildSystemPrompt({
      mode: 'minimal',
      workspaceFiles: [{ name: 'AGENTS.md', content: 'Agent config', owner: 'user' }],
      extraContext: '## Extra Section',
    });
    expect(result.text).not.toContain('Agent config');
    expect(result.text).not.toContain('## Extra Section');
  });

  it('minimal mode excludes tool style and tool hints', () => {
    const result = buildSystemPrompt({
      mode: 'minimal',
      toolPromptHints: ['Custom hint for web search.'],
    });
    expect(result.text).not.toContain(toolStylePrompt);
    expect(result.text).not.toContain('Custom hint for web search.');
  });

  it('minimal mode with custom identity includes identity + safety + tools', () => {
    const result = buildSystemPrompt({
      mode: 'minimal',
      identity: 'You are a focused task assistant.',
      tools: [{ name: 'web_search', description: 'Search the web' }],
      workspaceFiles: [],
      extraContext: '## Subagent Context\n\nTask: Research topic X',
    });
    expect(result.text).toContain('focused task assistant');
    expect(result.text).not.toContain(regularPrompt);
    expect(result.text).toContain(safetyPrompt);
    // Tool listing included so model knows available tools
    expect(result.text).toContain('web_search');
    // Everything else stripped for tiny local models
    expect(result.text).not.toContain(toolStylePrompt);
    expect(result.text).not.toContain('## Subagent Context');
    expect(result.text).not.toContain('# Project Context');
    expect(result.text).not.toContain('## Skills');
  });

  it('includes Memory Recall section when memory_search enabled', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      toolPromptHints: resolveToolPromptHints({ memory_search: true }),
    });
    expect(result.text).toContain('## Memory Recall');
    expect(result.text).toContain('memory_search');
    expect(result.text).toContain('memory_get');
  });

  it('omits Memory Recall section when no tools enabled', () => {
    const result = buildSystemPrompt({
      mode: 'full',
    });
    expect(result.text).not.toContain('## Memory Recall');
    expect(result.text).not.toContain(promptHintFor('memory'));
  });
});

// ── buildSystemPrompt — Skills section ──

describe('buildSystemPrompt — Skills section', () => {
  const sampleSkills = [
    {
      name: 'Web Research',
      description: 'Multi-step web research',
      path: 'skills/web-research/SKILL.md',
    },
    { name: 'Summarize', description: 'Summarize content', path: 'skills/summarize/SKILL.md' },
  ];

  it('includes Skills section when skills provided', () => {
    const result = buildSystemPrompt({ mode: 'full', skills: sampleSkills });
    expect(result.text).toContain('## Skills (mandatory)');
  });

  it('lists skill names and descriptions in XML format', () => {
    const result = buildSystemPrompt({ mode: 'full', skills: sampleSkills });
    expect(result.text).toContain('<available_skills>');
    expect(result.text).toContain('</available_skills>');
    expect(result.text).toContain('<name>Web Research</name>');
    expect(result.text).toContain('<description>Multi-step web research</description>');
    expect(result.text).toContain('<location>skills/web-research/SKILL.md</location>');
    expect(result.text).toContain('<name>Summarize</name>');
    expect(result.text).toContain('<description>Summarize content</description>');
    expect(result.text).toContain('<location>skills/summarize/SKILL.md</location>');
  });

  it('includes tiebreaking read instructions for skills', () => {
    const result = buildSystemPrompt({ mode: 'full', skills: sampleSkills });
    expect(result.text).toContain('read its SKILL.md at <location> with `read`, then follow it');
    expect(result.text).toContain('choose the most specific one');
    expect(result.text).toContain('never read more than one skill up front');
  });

  it('omits Skills section when no skills provided', () => {
    const result = buildSystemPrompt({ mode: 'full' });
    expect(result.text).not.toContain('## Skills');
  });

  it('omits Skills section when skills array is empty', () => {
    const result = buildSystemPrompt({ mode: 'full', skills: [] });
    expect(result.text).not.toContain('## Skills');
  });

  it('excludes skill files from Project Context section', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      skills: sampleSkills,
      workspaceFiles: [
        { name: 'USER.md', content: 'User info', owner: 'user' },
        { name: 'skills/web-research/SKILL.md', content: 'Skill content', owner: 'user' },
      ],
    });
    expect(result.text).toContain('# Project Context');
    expect(result.text).toContain('## USER.md');
    // Skill file should NOT appear in Project Context section
    expect(result.text).not.toContain('## skills/web-research/SKILL.md');
  });

  it('escapes XML special characters in skill metadata', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [
        {
          name: 'R&D "Tools"',
          description: 'Research <advanced> & development',
          path: 'skills/r&d/SKILL.md',
        },
      ],
    });
    expect(result.text).toContain('<name>R&amp;D &quot;Tools&quot;</name>');
    expect(result.text).toContain('<location>skills/r&amp;d/SKILL.md</location>');
    expect(result.text).toContain('<description>Research &lt;advanced&gt; &amp; development</description>');
  });

  it('Skills section appears after tool prompt hints', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      toolPromptHints: resolveToolPromptHints({ memory_search: true, create_document: true }),
      skills: sampleSkills,
    });
    const memoryRecallIdx = result.text.indexOf('## Memory Recall');
    const skillsIdx = result.text.indexOf('## Skills (mandatory)');
    // Tool prompt hints (memory, documents) should appear before Skills
    expect(memoryRecallIdx).toBeGreaterThan(-1);
    expect(memoryRecallIdx).toBeLessThan(skillsIdx);
  });
});

// ── buildSystemPrompt — TTS hint section ──

describe('buildSystemPrompt — TTS hint section', () => {
  it('includes TTS hint when hasTts=true', () => {
    const result = buildSystemPrompt({ mode: 'full', hasTts: true });
    expect(result.text).toContain('text-to-speech');
    expect(result.text).toContain('concise and conversational');
  });

  it('omits TTS hint when hasTts=false', () => {
    const result = buildSystemPrompt({ mode: 'full', hasTts: false });
    expect(result.text).not.toContain('text-to-speech');
  });

  it('omits TTS hint when hasTts not set', () => {
    const result = buildSystemPrompt({ mode: 'full' });
    expect(result.text).not.toContain('text-to-speech');
  });

  it('TTS hint appears in full mode only', () => {
    const minResult = buildSystemPrompt({ mode: 'minimal', hasTts: true });
    expect(minResult.text).not.toContain('text-to-speech');

    const noneResult = buildSystemPrompt({ mode: 'none', hasTts: true });
    expect(noneResult.text).not.toContain('text-to-speech');
  });
});

// ── SOUL.md persona instruction ──

describe('buildSystemPrompt — SOUL.md persona', () => {
  it('includes persona preamble when SOUL.md is present', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [
        { name: 'SOUL.md', content: 'Be witty and creative', owner: 'user' },
        { name: 'USER.md', content: 'Name: Alice', owner: 'user' },
      ],
    });
    expect(result.text).toContain('embody its persona and tone');
    expect(result.text).toContain('Avoid stiff, generic replies');
    expect(result.text).toContain('Be witty and creative');
  });

  it('omits persona preamble when no SOUL.md', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [{ name: 'USER.md', content: 'Name: Alice', owner: 'user' }],
    });
    expect(result.text).not.toContain('embody its persona and tone');
    expect(result.text).toContain('Name: Alice');
  });

  it('excludes non-bootstrap casing like soul.md', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [{ name: 'soul.md', content: 'Be chill', owner: 'user' }],
    });
    expect(result.text).not.toContain('Be chill');
    expect(result.text).not.toContain('embody its persona and tone');
  });
});

// ── Bootstrap allowlist filtering ──

describe('buildSystemPrompt — bootstrap allowlist', () => {
  it('exports the expected bootstrap filenames', () => {
    expect(BOOTSTRAP_FILENAMES).toEqual(
      new Set(['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md', 'MEMORY.md']),
    );
  });

  it('excludes non-bootstrap user files from Project Context', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [
        { name: 'SOUL.md', content: 'Be kind', owner: 'user' },
        { name: 'TOOLS.md', content: 'Tool docs', owner: 'user' },
        { name: 'analysis/report.md', content: 'Iran insider trading', owner: 'user' },
        { name: 'bot/config.js', content: 'module.exports = {}', owner: 'user' },
        { name: 'proposals/redesign.md', content: 'Proposal text', owner: 'user' },
      ],
    });
    expect(result.text).toContain('## SOUL.md');
    expect(result.text).toContain('Be kind');
    expect(result.text).toContain('## TOOLS.md');
    expect(result.text).toContain('Tool docs');
    expect(result.text).not.toContain('analysis/report.md');
    expect(result.text).not.toContain('Iran insider trading');
    expect(result.text).not.toContain('bot/config.js');
    expect(result.text).not.toContain('proposals/redesign.md');
  });
});

// ── Workspace truncation & budget ──

describe('buildSystemPrompt — truncation & budget', () => {
  it('exports truncation constants', () => {
    expect(MAX_PER_FILE_CHARS).toBe(20_000);
    expect(MAX_TOTAL_WORKSPACE_CHARS).toBe(150_000);
  });

  it('truncates a large file with head/tail split', () => {
    const bigContent = 'x'.repeat(25_000);
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [{ name: 'IDENTITY.md', content: bigContent, owner: 'user' }],
    });
    expect(result.text).toContain('[...truncated, read IDENTITY.md for full content...]');
    // Original 25K content should NOT appear in full
    expect(result.text).not.toContain(bigContent);
  });

  it('does not truncate files within per-file limit', () => {
    const smallContent = 'hello world';
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [{ name: 'TOOLS.md', content: smallContent, owner: 'user' }],
    });
    expect(result.text).toContain(smallContent);
    expect(result.text).not.toContain('[...truncated');
  });

  it('drops files that exceed total budget', () => {
    // Create 20 files of 19K each = 380K total, well over 150K budget
    const fileContent = 'y'.repeat(19_000);
    const files = Array.from({ length: 20 }, (_, i) => ({
      name: `FILE${i}.md`,
      content: fileContent,
      owner: 'user' as const,
    }));
    const budgeted = budgetWorkspaceFiles(files);
    // First files should be included
    expect(budgeted.some(f => f.name === 'FILE0.md')).toBe(true);
    // Files near the end should be dropped once budget is exhausted
    expect(budgeted.some(f => f.name === 'FILE19.md')).toBe(false);
  });

  it('skips empty files but continues processing subsequent files', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [
        { name: 'AGENTS.md', content: '', owner: 'user' },
        { name: 'USER.md', content: 'after content', owner: 'user' },
      ],
    });
    expect(result.text).not.toContain('AGENTS.md');
    expect(result.text).toContain('after content');
  });

  it('stops processing when remaining budget is below minimum', () => {
    // 7 files of MAX_PER_FILE_CHARS + 1 filler = 149,970 chars total
    // Leaves 30 chars remaining, below MIN_FILE_BUDGET_CHARS (64)
    const files: { name: string; content: string; owner: 'user' }[] = Array.from(
      { length: 7 },
      (_, i) => ({
        name: `BIG${i}.md`,
        content: 'z'.repeat(MAX_PER_FILE_CHARS),
        owner: 'user' as const,
      }),
    );
    files.push({
      name: 'FILLER.md',
      content: 'z'.repeat(MAX_TOTAL_WORKSPACE_CHARS - 7 * MAX_PER_FILE_CHARS - 30),
      owner: 'user' as const,
    });
    files.push({ name: 'TINY.md', content: 'tiny', owner: 'user' as const });
    const budgeted = budgetWorkspaceFiles(files);
    expect(budgeted.some(f => f.name === 'BIG0.md')).toBe(true);
    expect(budgeted.some(f => f.name === 'FILLER.md')).toBe(true);
    // TINY.md should be dropped because remaining (30) < MIN_FILE_BUDGET_CHARS (64)
    expect(budgeted.some(f => f.name === 'TINY.md')).toBe(false);
  });
});

// ── Minimal mode workspace filtering ──

describe('buildSystemPrompt — minimal workspace', () => {
  it('excludes all workspace files in minimal mode', () => {
    const result = buildSystemPrompt({
      mode: 'minimal',
      workspaceFiles: [
        { name: 'AGENTS.md', content: 'Agent instructions', owner: 'user' },
        { name: 'TOOLS.md', content: 'Tool docs', owner: 'user' },
        { name: 'USER.md', content: 'User info', owner: 'user' },
        { name: 'SOUL.md', content: 'Be nice', owner: 'user' },
      ],
    });
    expect(result.text).not.toContain('## Workspace');
    expect(result.text).not.toContain('Agent instructions');
    expect(result.text).not.toContain('Tool docs');
    expect(result.text).not.toContain('User info');
    expect(result.text).not.toContain('Be nice');
  });

  it('omits workspace section in minimal mode when no workspace files', () => {
    const result = buildSystemPrompt({ mode: 'minimal' });
    expect(result.text).not.toContain('## Workspace');
  });
});

// ── Memory file exclusion ──

describe('buildSystemPrompt — memory file exclusion', () => {
  it('includes MEMORY.md in Project Context', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [
        { name: 'MEMORY.md', content: 'Remember: user likes dark mode', owner: 'user' },
        { name: 'USER.md', content: 'Name: Alice', owner: 'user' },
      ],
    });
    expect(result.text).toContain('## USER.md');
    expect(result.text).toContain('Name: Alice');
    expect(result.text).toContain('## MEMORY.md');
    expect(result.text).toContain('user likes dark mode');
  });

  it('excludes memory/*.md agent files from Agent Memory', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [
        { name: 'memory/2026-02-26.md', content: 'Daily journal entry', owner: 'agent' },
        { name: 'memory/projects.md', content: 'Project notes', owner: 'agent' },
      ],
    });
    expect(result.text).not.toContain('## Memory');
    expect(result.text).not.toContain('Daily journal entry');
    expect(result.text).not.toContain('Project notes');
  });

  it('excludes non-memory agent files from system prompt', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [
        { name: 'notes/scratch.md', content: 'Agent scratch notes', owner: 'agent' },
      ],
    });
    expect(result.text).not.toContain('## Memory');
    expect(result.text).not.toContain('Agent scratch notes');
  });

  it('still shows Memory Recall instruction via tool prompt hints', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      toolPromptHints: resolveToolPromptHints({ memory_search: true }),
      workspaceFiles: [
        { name: 'MEMORY.md', content: 'Some memory content', owner: 'user' },
      ],
    });
    expect(result.text).toContain('## Memory Recall');
    expect(result.text).toContain('Some memory content');
  });

  it('includes MEMORY.md but excludes memory/* files', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [
        { name: 'SOUL.md', content: 'Be friendly', owner: 'user' },
        { name: 'USER.md', content: 'Name: Bob', owner: 'user' },
        { name: 'MEMORY.md', content: 'Long term facts', owner: 'user' },
        { name: 'memory/2026-02-26.md', content: 'Today journal', owner: 'agent' },
        { name: 'memory/projects.md', content: 'Project list', owner: 'agent' },
      ],
    });
    expect(result.text).toContain('## SOUL.md');
    expect(result.text).toContain('## USER.md');
    expect(result.text).toContain('## MEMORY.md');
    expect(result.text).toContain('Long term facts');
    expect(result.text).not.toContain('Today journal');
    expect(result.text).not.toContain('Project list');
  });
});

// ── resolveToolPromptHints ──

describe('resolveToolPromptHints', () => {
  it('returns registry hints for enabled tools', () => {
    const hints = resolveToolPromptHints({ web_search: true });
    expect(hints).toContain(promptHintFor('webSearch'));
  });

  it('omits hints for disabled tools', () => {
    const hints = resolveToolPromptHints({ web_search: false });
    expect(hints).not.toContain(promptHintFor('webSearch'));
  });

  it('returns empty array when no tools enabled', () => {
    const hints = resolveToolPromptHints({});
    expect(hints).toEqual([]);
  });

  it('includes custom tool hints when enabled', () => {
    const customTools = [{ name: 'my_tool', promptHint: 'Use my_tool for custom operations.' }];
    const hints = resolveToolPromptHints({ my_tool: true }, customTools);
    expect(hints).toContain('Use my_tool for custom operations.');
  });

  it('omits custom tool hints when tool is not enabled', () => {
    const customTools = [{ name: 'my_tool', promptHint: 'Use my_tool for custom operations.' }];
    const hints = resolveToolPromptHints({}, customTools);
    expect(hints).not.toContain('Use my_tool for custom operations.');
  });

  it('skips custom tools without promptHint', () => {
    const customTools = [{ name: 'no_hint_tool' }];
    const hints = resolveToolPromptHints({ no_hint_tool: true }, customTools);
    expect(hints).toEqual([]);
  });

  it('combines registry and custom tool hints', () => {
    const customTools = [{ name: 'my_tool', promptHint: 'Custom hint.' }];
    const hints = resolveToolPromptHints({ web_search: true, my_tool: true }, customTools);
    expect(hints).toContain(promptHintFor('webSearch'));
    expect(hints).toContain('Custom hint.');
  });
});

// ── resolveToolListings ──

describe('resolveToolListings', () => {
  it('returns listings for enabled tools from registry', () => {
    const listings = resolveToolListings({ web_search: true, web_fetch: true });
    expect(listings).toEqual(
      expect.arrayContaining([
        { name: 'web_search', description: 'Search the web for current information' },
        { name: 'web_fetch', description: 'Fetch and extract readable content from URLs' },
      ]),
    );
  });

  it('omits disabled tools', () => {
    const listings = resolveToolListings({ web_search: false });
    expect(listings.find(l => l.name === 'web_search')).toBeUndefined();
  });

  it('returns empty array when no tools enabled', () => {
    const listings = resolveToolListings({});
    expect(listings).toEqual([]);
  });

  it('includes custom tools when enabled', () => {
    const customTools = [{ name: 'my_tool', description: 'Custom tool' }];
    const listings = resolveToolListings({ my_tool: true }, customTools);
    expect(listings).toContainEqual({ name: 'my_tool', description: 'Custom tool' });
  });

  it('omits custom tools when not enabled', () => {
    const customTools = [{ name: 'my_tool', description: 'Custom tool' }];
    const listings = resolveToolListings({}, customTools);
    expect(listings.find(l => l.name === 'my_tool')).toBeUndefined();
  });

  it('omits custom tools without description', () => {
    const customTools = [{ name: 'no_desc' }];
    const listings = resolveToolListings({ no_desc: true }, customTools);
    expect(listings).toEqual([]);
  });

  it('combines registry and custom tool listings', () => {
    const customTools = [{ name: 'my_tool', description: 'Custom tool' }];
    const listings = resolveToolListings({ web_search: true, my_tool: true }, customTools);
    expect(listings.find(l => l.name === 'web_search')).toBeDefined();
    expect(listings.find(l => l.name === 'my_tool')).toBeDefined();
  });
});

// ── isMemoryFile helper ──

describe('isMemoryFile', () => {
  it('returns false for MEMORY.md', () => {
    expect(isMemoryFile('MEMORY.md')).toBe(false);
  });

  it('returns true for memory/ prefixed paths', () => {
    expect(isMemoryFile('memory/2026-02-26.md')).toBe(true);
    expect(isMemoryFile('memory/projects.md')).toBe(true);
    expect(isMemoryFile('memory/nested/deep.md')).toBe(true);
  });

  it('returns false for non-memory files', () => {
    expect(isMemoryFile('USER.md')).toBe(false);
    expect(isMemoryFile('SOUL.md')).toBe(false);
    expect(isMemoryFile('AGENTS.md')).toBe(false);
    expect(isMemoryFile('notes/scratch.md')).toBe(false);
  });

  it('returns false for files that contain "memory" but do not match pattern', () => {
    expect(isMemoryFile('my-memory.md')).toBe(false);
    expect(isMemoryFile('notes/memory-notes.md')).toBe(false);
    expect(isMemoryFile('MEMORY_backup.md')).toBe(false);
  });

  it('is case-sensitive for MEMORY.md', () => {
    expect(isMemoryFile('memory.md')).toBe(false);
    expect(isMemoryFile('Memory.md')).toBe(false);
  });
});

// ── buildWebSystemPrompt() tests ──

describe('buildWebSystemPrompt', () => {
  it('omits ## Tooling section', () => {
    const result = buildWebSystemPrompt({
      mode: 'full',
      tools: [{ name: 'web_search', description: 'Search the web' }],
    });
    expect(result.text).not.toContain('## Tooling');
    expect(result.text).not.toContain('Tool names are case-sensitive');
  });

  it('omits tool style prompt', () => {
    const result = buildWebSystemPrompt({ mode: 'full' });
    expect(result.text).not.toContain(toolStylePrompt);
  });

  it('includes identity, safety, and sandbox sections', () => {
    const result = buildWebSystemPrompt({ mode: 'full' });
    expect(result.text).toContain(regularPrompt);
    expect(result.text).toContain(safetyPrompt);
    expect(result.text).toContain(sandboxPrompt.trim());
  });

  it('includes custom identity when provided', () => {
    const result = buildWebSystemPrompt({
      mode: 'full',
      identity: 'You are a web assistant.',
    });
    expect(result.text).toContain('You are a web assistant.');
    expect(result.text).not.toContain(regularPrompt);
  });

  it('includes tool prompt hints', () => {
    const hints = resolveToolPromptHints({ web_search: true });
    const result = buildWebSystemPrompt({
      mode: 'full',
      toolPromptHints: hints,
    });
    expect(result.text).toContain(promptHintFor('webSearch'));
  });

  it('includes skills section', () => {
    const result = buildWebSystemPrompt({
      mode: 'full',
      skills: [{ name: 'Research', description: 'Web research', path: 'skills/research/SKILL.md' }],
    });
    expect(result.text).toContain('## Skills (mandatory)');
    expect(result.text).toContain('<name>Research</name>');
  });

  it('includes workspace user files', () => {
    const result = buildWebSystemPrompt({
      mode: 'full',
      workspaceFiles: [{ name: 'USER.md', content: 'Name: Alice', owner: 'user' }],
    });
    expect(result.text).toContain('# Project Context');
    expect(result.text).toContain('Name: Alice');
  });

  it('includes runtime metadata', () => {
    const result = buildWebSystemPrompt({
      mode: 'full',
      runtimeMeta: { modelName: 'qwen-2.5', currentDate: '2026-03-19' },
    });
    expect(result.text).toContain('Current date: 2026-03-19');
    expect(result.text).toContain('Model: qwen-2.5');
  });

  it('includes extraContext', () => {
    const result = buildWebSystemPrompt({
      mode: 'full',
      extraContext: '## Extra',
    });
    expect(result.text).toContain('## Extra');
  });

  it('includes TTS hint when hasTts=true', () => {
    const result = buildWebSystemPrompt({ mode: 'full', hasTts: true });
    expect(result.text).toContain('text-to-speech');
  });

  it('returns correct estimatedTokens', () => {
    const result = buildWebSystemPrompt({ mode: 'full' });
    expect(result.estimatedTokens).toBe(Math.ceil(result.text.length / 4));
  });
});

// ── buildLocalSystemPrompt() tests ──

describe('buildLocalSystemPrompt', () => {
  it('omits ## Tooling section', () => {
    const result = buildLocalSystemPrompt({
      mode: 'minimal',
      tools: [{ name: 'web_search', description: 'Search the web' }],
    });
    expect(result.text).not.toContain('## Tooling');
    expect(result.text).not.toContain('Tool names are case-sensitive');
  });

  it('includes identity and safety', () => {
    const result = buildLocalSystemPrompt({ mode: 'minimal' });
    expect(result.text).toContain(regularPrompt);
    expect(result.text).toContain(safetyPrompt);
  });

  it('includes minimal workspace (AGENTS.md, TOOLS.md only)', () => {
    const result = buildLocalSystemPrompt({
      mode: 'minimal',
      workspaceFiles: [
        { name: 'AGENTS.md', content: 'Agent config', owner: 'user' },
        { name: 'TOOLS.md', content: 'Tool docs', owner: 'user' },
        { name: 'USER.md', content: 'Should not appear', owner: 'user' },
        { name: 'SOUL.md', content: 'Should not appear', owner: 'user' },
      ],
    });
    expect(result.text).toContain('## Workspace');
    expect(result.text).toContain('Agent config');
    expect(result.text).toContain('Tool docs');
    expect(result.text).not.toContain('Should not appear');
  });

  it('omits sandbox, tool style, skills, runtime meta, and extraContext', () => {
    const result = buildLocalSystemPrompt({
      mode: 'minimal',
      tools: [{ name: 'web_search', description: 'Search' }],
      toolPromptHints: ['Custom hint'],
      skills: [{ name: 'Research', description: 'Web research', path: 'skills/research/SKILL.md' }],
      runtimeMeta: { modelName: 'llama', currentDate: '2026-03-19' },
      extraContext: '## Extra',
    });
    expect(result.text).not.toContain(sandboxPrompt.trim());
    expect(result.text).not.toContain(toolStylePrompt);
    expect(result.text).not.toContain('## Skills');
    expect(result.text).not.toContain('Current date:');
    expect(result.text).not.toContain('## Extra');
    expect(result.text).not.toContain('Custom hint');
  });

  it('returns correct estimatedTokens', () => {
    const result = buildLocalSystemPrompt({ mode: 'minimal' });
    expect(result.estimatedTokens).toBe(Math.ceil(result.text.length / 4));
  });
});

// ── buildSystemPrompt — memory exclusion edge cases ──

describe('buildSystemPrompt — memory exclusion edge cases', () => {
  it('excludes all workspace files from minimal mode', () => {
    const result = buildSystemPrompt({
      mode: 'minimal',
      workspaceFiles: [
        { name: 'AGENTS.md', content: 'Agent config', owner: 'user' },
        { name: 'MEMORY.md', content: 'Should not appear', owner: 'user' },
        { name: 'memory/2026-02-26.md', content: 'Journal entry', owner: 'agent' },
      ],
    });
    expect(result.text).not.toContain('Agent config');
    expect(result.text).not.toContain('Should not appear');
    expect(result.text).not.toContain('Journal entry');
  });

  it('memory files do not count toward workspace file budget', () => {
    const memoryContent = 'x'.repeat(MAX_PER_FILE_CHARS);
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [
        { name: 'memory/big.md', content: memoryContent, owner: 'agent' },
        { name: 'USER.md', content: 'Name: Alice', owner: 'user' },
      ],
    });
    // USER.md should still appear even though the memory file is huge
    expect(result.text).toContain('Name: Alice');
    expect(result.text).not.toContain(memoryContent);
  });

  it('excludes non-bootstrap user files even if not memory-related', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [
        { name: 'my-memory-notes.md', content: 'Personal notes about memory', owner: 'user' },
        { name: 'USER.md', content: 'User profile', owner: 'user' },
      ],
    });
    // Non-bootstrap file excluded by allowlist
    expect(result.text).not.toContain('Personal notes about memory');
    // Bootstrap file included
    expect(result.text).toContain('User profile');
  });

  it('handles workspace with only memory files gracefully', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      workspaceFiles: [
        { name: 'MEMORY.md', content: 'Facts to remember', owner: 'user' },
        { name: 'memory/2026-01-01.md', content: 'New year journal', owner: 'agent' },
        { name: 'memory/projects.md', content: 'Project list', owner: 'agent' },
      ],
    });
    // MEMORY.md is now a bootstrap file, so Project Context appears
    expect(result.text).toContain('# Project Context');
    expect(result.text).toContain('Facts to remember');
    // memory/* files are still excluded
    expect(result.text).not.toContain('## Memory');
    expect(result.text).not.toContain('New year journal');
    expect(result.text).not.toContain('Project list');
  });

  it('memory exclusion works alongside skill file exclusion', () => {
    const result = buildSystemPrompt({
      mode: 'full',
      skills: [
        { name: 'Research', description: 'Web research', path: 'skills/research/SKILL.md' },
      ],
      workspaceFiles: [
        { name: 'USER.md', content: 'Name: Bob', owner: 'user' },
        { name: 'MEMORY.md', content: 'Memory data', owner: 'user' },
        { name: 'skills/research/SKILL.md', content: 'Skill content', owner: 'user' },
        { name: 'memory/2026-02-26.md', content: 'Journal data', owner: 'agent' },
      ],
    });
    // USER.md and MEMORY.md should appear in project context
    expect(result.text).toContain('## USER.md');
    expect(result.text).toContain('Name: Bob');
    expect(result.text).toContain('## MEMORY.md');
    expect(result.text).toContain('Memory data');
    // Skill files and memory/* should be excluded
    expect(result.text).not.toContain('## skills/research/SKILL.md');
    expect(result.text).not.toContain('Skill content');
    expect(result.text).not.toContain('Journal data');
    // Skills section itself should still be present
    expect(result.text).toContain('## Skills (mandatory)');
  });
});
