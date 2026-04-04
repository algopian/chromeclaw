import type { WebProviderPlugin } from '../plugin-types';
import { glmIntlWeb } from './glm-intl-web';
import { createGlmIntlStreamAdapter } from './glm-intl-stream-adapter';
import { glmIntlToolStrategy } from '../tool-strategy';
import { glmIntlMainWorldFetch } from '../content-fetch-glm-intl';

export const glmIntlWebPlugin: WebProviderPlugin = {
  definition: glmIntlWeb,
  createStreamAdapter: () => createGlmIntlStreamAdapter(),
  toolStrategy: glmIntlToolStrategy,
  contentFetchHandler: glmIntlMainWorldFetch,
};
