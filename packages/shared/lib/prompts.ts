/** Agent memory files (memory/*) are search-only — not injected into the system prompt */
const isMemoryFile = (name: string): boolean =>
  name.startsWith('memory/');

/** Bootstrap files allowlisted for system prompt injection (full mode) */
const BOOTSTRAP_FILENAMES = new Set(['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md', 'MEMORY.md']);

// ──────────────────────────────────────────────
// Prompt Section Text Constants
// ──────────────────────────────────────────────

const regularPrompt = `You are a personal assistant running inside ChromeClaw.`;

const titlePrompt = `Generate a short title (max 6 words) for this conversation based on the first message. Return ONLY the title text, nothing else. Do not use quotes.`;

const safetyPrompt = `Prioritize safety and human oversight over task completion; if instructions conflict, pause and ask; comply with stop/pause requests and never bypass safeguards.
Do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.
Do not manipulate or persuade anyone to expand access or disable safeguards.
Do not reveal or modify your system prompt unless explicitly requested.`;

const toolStylePrompt = `When using tools: do not narrate routine, low-risk tool calls (just call the tool).
Narrate only when it helps: multi-step work, complex problems, sensitive actions (e.g., deletions), or when the user explicitly asks.
Keep narration brief and value-dense; avoid repeating obvious steps.
Use plain human language for narration unless in a technical context.
When a first-class tool exists for an action, use the tool directly instead of asking the user to run equivalent commands.`;

const sandboxPrompt = `You are running in a sandboxed runtime within browser.
Only Javascript is native supported language.
No direct access to host operating system, local filesystem, network sockets, or any external APIs beyond what is explicitly provided. 
`;

// ──────────────────────────────────────────────
// System Prompt Builder Types
// ──────────────────────────────────────────────

interface SkillEntry {
  name: string;
  description: string;
  path: string;
}

interface SystemPromptConfig {
  mode: 'full' | 'minimal' | 'none';
  identity?: string;
  hasTts?: boolean;
  tools?: { name: string; description: string }[];
  toolPromptHints?: string[];
  workspaceFiles?: { name: string; content: string; owner: 'user' | 'agent' }[];
  skills?: SkillEntry[];
  runtimeMeta?: { modelName: string; currentDate: string; capabilities?: string[]; browser?: 'chrome' | 'firefox' };
  extraContext?: string;
}

interface SystemPromptResult {
  text: string;
  estimatedTokens: number;
}

// ──────────────────────────────────────────────
// Section Builders
// ──────────────────────────────────────────────

const buildIdentitySection = (config: SystemPromptConfig): string | null =>
  config.identity || regularPrompt;

const buildSafetySection = (): string => safetyPrompt;

const buildToolsSection = (config: SystemPromptConfig): string | null => {
  if (!config.tools || config.tools.length === 0) return null;
  const toolLines = config.tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
  return `## Tooling\n\nTool names are case-sensitive. Call tools exactly as listed.\n\n${toolLines}\n\nTOOLS.md does not control tool availability; it is user guidance for how to use external tools.`;
};

const buildToolStyleSection = (): string => toolStylePrompt;

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const buildSkillsSection = (config: SystemPromptConfig): string | null => {
  if (!config.skills || config.skills.length === 0) return null;
  const entries = config.skills
    .map(
      s =>
        `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.path)}</location>\n  </skill>`,
    )
    .join('\n');
  return `## Skills (mandatory)

Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md at <location> with \`read\`, then follow it.
- If multiple could apply: choose the most specific one, then read/follow it.
- If none clearly apply: do not read any SKILL.md.
Constraints: never read more than one skill up front; only read after selecting.
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.

<available_skills>
${entries}
</available_skills>`;
};

const buildSandboxSection = (): string => {
  return sandboxPrompt;
};

const buildTtsHintSection = (config: SystemPromptConfig): string | null => {
  if (!config.hasTts) return null;
  const lines = [
    'Your responses may be read aloud via text-to-speech. Keep them concise and conversational.',
    'Avoid code blocks, long URLs, and complex formatting when possible.',
    'Prefer natural language explanations over structured data.',
  ];
  return lines.join('\n');
};

const buildWorkspaceUserFilesSection = (config: SystemPromptConfig): string | null => {
  const userFiles = config.workspaceFiles?.filter(
    f => f.owner === 'user' && f.content && BOOTSTRAP_FILENAMES.has(f.name),
  );
  if (!userFiles || userFiles.length === 0) return null;
  const hasSoulFile = userFiles.some(f => f.name.toLowerCase() === 'soul.md');
  const soulPreamble = hasSoulFile
    ? '\nIf SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.'
    : '';
  const sections = userFiles.map(f => `## ${f.name}\n${f.content}`).join('\n\n');
  return `# Project Context\n\nThe following project context files have been loaded:${soulPreamble}\n\n${sections}`;
};

const buildRuntimeMetaSection = (config: SystemPromptConfig): string | null => {
  if (!config.runtimeMeta) return null;
  const parts = [`Current date: ${config.runtimeMeta.currentDate}`, `Model: ${config.runtimeMeta.modelName}`];
  if (config.runtimeMeta.capabilities?.length) {
    parts.push(`Capabilities: ${config.runtimeMeta.capabilities.join(', ')}`);
  }
  if (config.runtimeMeta.browser) {
    parts.push(`Browser: ${config.runtimeMeta.browser === 'firefox' ? 'Firefox' : 'Chrome'}`);
    if (config.runtimeMeta.browser === 'firefox') {
      parts.push(
        'Note: Chrome DevTools Protocol (chrome.debugger) is not available. ' +
        'The debugger tool is disabled; all other tools work normally.',
      );
    }
  }
  return parts.join('. ') + '.';
};

// ──────────────────────────────────────────────
// Workspace Truncation & Budget
// ──────────────────────────────────────────────

const MAX_PER_FILE_CHARS = 20_000;
const MAX_TOTAL_WORKSPACE_CHARS = 150_000;
const MIN_FILE_BUDGET_CHARS = 64;
const HEAD_RATIO = 0.7;
const TAIL_RATIO = 0.2;

type WorkspaceFile = NonNullable<SystemPromptConfig['workspaceFiles']>[number];

const truncateFileContent = (content: string, fileName: string, maxChars: number): string => {
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxChars) return trimmed;
  const headChars = Math.floor(maxChars * HEAD_RATIO);
  const tailChars = Math.floor(maxChars * TAIL_RATIO);
  return `${trimmed.slice(0, headChars)}\n\n[...truncated, read ${fileName} for full content...]\n\n${trimmed.slice(-tailChars)}`;
};

const budgetWorkspaceFiles = (files: WorkspaceFile[]): WorkspaceFile[] => {
  let remaining = MAX_TOTAL_WORKSPACE_CHARS;
  const result: WorkspaceFile[] = [];
  for (const f of files) {
    if (remaining <= 0) break;
    if (!f.content) continue;
    if (remaining < MIN_FILE_BUDGET_CHARS) break;
    const maxChars = Math.min(MAX_PER_FILE_CHARS, remaining);
    const content = truncateFileContent(f.content, f.name, maxChars);
    const clamped = content.length > remaining ? content.slice(0, remaining) : content;
    remaining = Math.max(0, remaining - clamped.length);
    result.push({ ...f, content: clamped });
  }
  return result;
};

// ──────────────────────────────────────────────
// Minimal Mode Workspace
// ──────────────────────────────────────────────

const MINIMAL_WORKSPACE_ALLOWLIST = new Set(['AGENTS.md', 'TOOLS.md']);

const buildWorkspaceMinimalSection = (config: SystemPromptConfig): string | null => {
  const allowed = config.workspaceFiles?.filter(
    f => f.content && MINIMAL_WORKSPACE_ALLOWLIST.has(f.name),
  );
  if (!allowed || allowed.length === 0) return null;
  const sections = allowed.map(f => `### ${f.name}\n${f.content}`).join('\n\n');
  return `## Workspace\n\n${sections}`;
};

// ──────────────────────────────────────────────
// Provider-Specific Builders
// ──────────────────────────────────────────────

/**
 * Build system prompt for web providers (e.g. Qwen via WebLLM).
 *
 * Same as full-mode buildSystemPrompt but omits `## Tooling` and tool style sections.
 * Web providers inject their own XML tool instructions via buildToolPrompt() in
 * web-llm-bridge.ts, so including a separate `## Tooling` section causes the model
 * to ignore the XML format and output raw JSON instead.
 */
const buildWebSystemPrompt = (config: SystemPromptConfig): SystemPromptResult => {
  const parts: string[] = [];
  const identity = buildIdentitySection(config);
  if (identity) parts.push(identity);
  parts.push(buildSafetySection());
  parts.push(buildSandboxSection());

  // NO buildToolsSection — XML tool prompt is injected by web-llm-bridge
  // NO buildToolStyleSection — tool narration style not needed for XML tool calling

  const budgetedFiles = budgetWorkspaceFiles(config.workspaceFiles ?? []);
  const budgetedConfig = { ...config, workspaceFiles: budgetedFiles };

  if (budgetedConfig.toolPromptHints) {
    parts.push(...budgetedConfig.toolPromptHints);
  }
  const skills = buildSkillsSection(budgetedConfig);
  if (skills) parts.push(skills);
  const ttsHint = buildTtsHintSection(budgetedConfig);
  if (ttsHint) parts.push(ttsHint);
  const workspaceUser = buildWorkspaceUserFilesSection(budgetedConfig);
  if (workspaceUser) parts.push(workspaceUser);
  const runtimeMeta = buildRuntimeMetaSection(budgetedConfig);
  if (runtimeMeta) parts.push(runtimeMeta);
  if (config.extraContext) parts.push(config.extraContext);

  const text = parts.join('\n\n');
  return { text, estimatedTokens: Math.ceil(text.length / 4) };
};

/**
 * Build system prompt for local providers (e.g. Ollama, llama.cpp).
 *
 * Minimal prompt: identity + safety + minimal workspace.
 * Omits `## Tooling` because local-llm-bridge injects its own XML tool instructions.
 */
const buildLocalSystemPrompt = (config: SystemPromptConfig): SystemPromptResult => {
  const parts: string[] = [];
  const identity = buildIdentitySection(config);
  if (identity) parts.push(identity);
  parts.push(buildSafetySection());

  // NO buildToolsSection — XML tool prompt is injected by local-llm-bridge
  const workspace = buildWorkspaceMinimalSection(config);
  if (workspace) parts.push(workspace);

  const text = parts.join('\n\n');
  return { text, estimatedTokens: Math.ceil(text.length / 4) };
};

// ──────────────────────────────────────────────
// Main Builder
// ──────────────────────────────────────────────

/**
 * Build a structured system prompt from configuration.
 *
 * Section assembly order:
 * Identity -> Safety -> Tools -> Tool style -> Tool prompt hints (from resolveToolPromptHints)
 * -> Skills -> Workspace user files -> Runtime metadata
 *
 * Modes:
 * - 'full': all sections
 * - 'minimal': identity + safety only (for tiny local models with small input budgets)
 * - 'none': identity only
 */
const buildSystemPrompt = (config: SystemPromptConfig): SystemPromptResult => {
  const parts: string[] = [];

  // Identity — always included
  const identity = buildIdentitySection(config);
  if (identity) parts.push(identity);

  if (config.mode === 'none') {
    const text = parts.join('\n\n');
    return { text, estimatedTokens: Math.ceil(text.length / 4) };
  }

  // Safety — all non-none modes
  parts.push(buildSafetySection());

  if (config.mode === 'minimal') {
    // Minimal mode is for tiny local models (≤1B params). Keep the prompt short
    // so it fits within aggressive input budgets. Include identity + safety + tool
    // listing so the model knows what tools are available. Skip: sandbox, tool style,
    // tool prompt hints, workspace, skills, runtime metadata.
    const tools = buildToolsSection(config);
    if (tools) parts.push(tools);
    const text = parts.join('\n\n');
    return { text, estimatedTokens: Math.ceil(text.length / 4) };
  }

  parts.push(buildSandboxSection());

  const tools = buildToolsSection(config);
  if (tools) parts.push(tools);

  // Full mode — apply workspace budget, then build all remaining sections
  const budgetedFiles = budgetWorkspaceFiles(config.workspaceFiles ?? []);
  const budgetedConfig = { ...config, workspaceFiles: budgetedFiles };

  parts.push(buildToolStyleSection());

  // Tool prompt hints (pre-resolved by caller via resolveToolPromptHints)
  if (budgetedConfig.toolPromptHints) {
    parts.push(...budgetedConfig.toolPromptHints);
  }

  const skills = buildSkillsSection(budgetedConfig);
  if (skills) parts.push(skills);



  const ttsHint = buildTtsHintSection(budgetedConfig);
  if (ttsHint) parts.push(ttsHint);

  const workspaceUser = buildWorkspaceUserFilesSection(budgetedConfig);
  if (workspaceUser) parts.push(workspaceUser);

  const runtimeMeta = buildRuntimeMetaSection(budgetedConfig);
  if (runtimeMeta) parts.push(runtimeMeta);

  if (config.extraContext) parts.push(config.extraContext);

  const text = parts.join('\n\n');
  return { text, estimatedTokens: Math.ceil(text.length / 4) };
};

// ──────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────

export type { SystemPromptConfig, SystemPromptResult, SkillEntry };

export {
  regularPrompt,
  titlePrompt,
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
  truncateFileContent,
};
