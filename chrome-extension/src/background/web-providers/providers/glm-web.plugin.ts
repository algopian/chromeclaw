import type { WebProviderPlugin } from '../plugin-types';
import { glmWeb } from './glm-web';
import { createGlmStreamAdapter } from './glm-stream-adapter';
import { glmToolStrategy } from '../tool-strategy';

export const glmWebPlugin: WebProviderPlugin = {
  definition: glmWeb,
  createStreamAdapter: () => createGlmStreamAdapter(),
  toolStrategy: glmToolStrategy,
};
