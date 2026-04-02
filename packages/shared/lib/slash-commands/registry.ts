import { clearCommand } from './cmd-clear.js';
import { compactCommand } from './cmd-compact.js';
import { copyCommand } from './cmd-copy.js';
import { exportCommand } from './cmd-export.js';
import { newCommand } from './cmd-new.js';
import type { SlashCommandDef } from './types.js';

const commands: SlashCommandDef[] = [clearCommand, compactCommand, copyCommand, exportCommand, newCommand];

export { commands };
