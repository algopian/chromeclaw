import type { WebProviderPlugin } from '../plugin-types';
import { claudeWeb } from './claude-web';
import { createClaudeStreamAdapter } from './claude-web-stream-adapter';
import { claudeToolStrategy } from '../tool-strategy';

export const claudeWebPlugin: WebProviderPlugin = {
  definition: claudeWeb,
  createStreamAdapter: () => createClaudeStreamAdapter(),
  toolStrategy: claudeToolStrategy,
};
