import type { WebProviderPlugin } from '../plugin-types';
import { glmIntlWeb } from './glm-intl-web';
import { createGlmIntlStreamAdapter } from './glm-intl-stream-adapter';
import { glmIntlToolStrategy } from '../tool-strategy';

export const glmIntlWebPlugin: WebProviderPlugin = {
  definition: glmIntlWeb,
  createStreamAdapter: () => createGlmIntlStreamAdapter(),
  toolStrategy: glmIntlToolStrategy,
};
