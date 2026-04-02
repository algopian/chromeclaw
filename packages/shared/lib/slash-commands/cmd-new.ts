import type { SlashCommandDef } from './types.js';

const newCommand: SlashCommandDef = {
  name: 'new',
  description: 'Start a new chat session',
  execute: async ctx => {
    if (!ctx.onNewChat) {
      throw new Error('New chat not available');
    }
    ctx.clearInput();
    ctx.onNewChat();
  },
};

export { newCommand };
