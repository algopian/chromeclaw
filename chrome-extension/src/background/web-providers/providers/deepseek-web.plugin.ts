import type { WebProviderPlugin } from '../plugin-types';
import { deepseekWeb } from './deepseek-web';
import { createDeepSeekStreamAdapter } from './deepseek-stream-adapter';
import { deepseekToolStrategy } from '../tool-strategy';

export const deepseekWebPlugin: WebProviderPlugin = {
  definition: deepseekWeb,
  createStreamAdapter: () => createDeepSeekStreamAdapter(),
  toolStrategy: deepseekToolStrategy,
};
