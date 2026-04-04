/**
 * Agent backup & restore utilities.
 *
 * Creates and parses ZIP archives containing agent configuration
 * and workspace files for backup/restore workflows.
 */

import JSZip from 'jszip';
import type {
  AgentConfig,
  AgentIdentity,
  AgentModelConfig,
  CustomToolDef,
  DbWorkspaceFile,
  ToolConfig,
} from '@extension/storage';

// ── Types ────────────────────────────────────────────

interface AgentBackupMeta {
  version: number;
  name: string;
  identity?: AgentIdentity;
  model?: AgentModelConfig;
  toolConfig?: ToolConfig;
  customTools?: CustomToolDef[];
  compactionConfig?: AgentConfig['compactionConfig'];
}

interface AgentBackupFile {
  name: string;
  content: string;
}

interface AgentBackupData {
  meta: AgentBackupMeta;
  files: AgentBackupFile[];
}

// ── Constants ────────────────────────────────────────

const MAX_BACKUP_SIZE = 50 * 1024 * 1024; // 50 MB
const AGENT_JSON = 'agent.json';
const WORKSPACE_PREFIX = 'workspace/';

// ── Backup (export) ──────────────────────────────────

/**
 * Build a ZIP blob containing the agent config + all workspace files.
 */
const backupAgent = async (agent: AgentConfig, files: DbWorkspaceFile[]): Promise<Blob> => {
  const zip = new JSZip();

  // agent.json — portable metadata (omits id, isDefault, timestamps)
  const meta: AgentBackupMeta = {
    version: 1,
    name: agent.name,
    identity: agent.identity,
    model: agent.model,
    toolConfig: agent.toolConfig,
    customTools: agent.customTools,
    compactionConfig: agent.compactionConfig,
  };
  zip.file(AGENT_JSON, JSON.stringify(meta, null, 2));

  // workspace files — preserve the `name` hierarchy (e.g. "memory/notes.md")
  for (const f of files) {
    zip.file(WORKSPACE_PREFIX + f.name, f.content);
  }

  return zip.generateAsync({ type: 'blob' });
};

/**
 * Generate a filesystem-safe backup filename.
 * Format: `{AgentName}_{YYYY-MM-DDThh-mm-ss}.zip`
 */
const backupFilename = (agentName: string): string => {
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
  const ts = new Date()
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, '');
  return `${safe}_${ts}.zip`;
};

// ── Restore (import) ─────────────────────────────────

/**
 * Parse and validate an agent backup ZIP.
 *
 * Does NOT write to the DB — returns structured data for the caller to apply
 * after user confirmation.
 *
 * @throws Error on validation failure
 */
const parseAgentBackup = async (file: File): Promise<AgentBackupData> => {
  if (file.size > MAX_BACKUP_SIZE) {
    throw new Error(
      `Backup file too large (${Math.round(file.size / (1024 * 1024))}MB). Maximum is 50MB.`,
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // ── Read agent.json ──
  const agentJsonEntry = zip.file(AGENT_JSON);
  if (!agentJsonEntry) {
    throw new Error('Invalid backup: missing agent.json');
  }

  const agentJsonRaw = await agentJsonEntry.async('string');
  let meta: AgentBackupMeta;
  try {
    meta = JSON.parse(agentJsonRaw) as AgentBackupMeta;
  } catch {
    throw new Error('Invalid backup: agent.json is not valid JSON');
  }

  if (!meta.version || !meta.name) {
    throw new Error('Invalid backup: agent.json must contain "version" and "name"');
  }

  // ── Extract workspace files ──
  const files: AgentBackupFile[] = [];
  const promises: Promise<void>[] = [];

  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    if (relativePath === AGENT_JSON) return;

    if (relativePath.startsWith(WORKSPACE_PREFIX)) {
      const name = relativePath.slice(WORKSPACE_PREFIX.length);
      if (name) {
        promises.push(
          entry.async('string').then(content => {
            files.push({ name, content });
          }),
        );
      }
    }
  });

  await Promise.all(promises);

  return { meta, files };
};

export type { AgentBackupMeta, AgentBackupFile, AgentBackupData };
export { backupAgent, backupFilename, parseAgentBackup };
