import type { WebProviderPlugin } from '../plugin-types';
import { deepseekWeb } from './deepseek-web';
import { createDeepSeekStreamAdapter } from './deepseek-stream-adapter';
import { deepseekToolStrategy } from '../tool-strategy';
import { deepseekMainWorldFetch } from '../content-fetch-deepseek';

export const deepseekWebPlugin: WebProviderPlugin = {
  definition: deepseekWeb,
  createStreamAdapter: () => createDeepSeekStreamAdapter(),
  toolStrategy: deepseekToolStrategy,
  contentFetchHandler: deepseekMainWorldFetch,
};
