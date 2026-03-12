import { clearCommand } from './cmd-clear.js';
import { compactCommand } from './cmd-compact.js';
import type { SlashCommandDef } from './types.js';

const commands: SlashCommandDef[] = [clearCommand, compactCommand];

export { commands };
