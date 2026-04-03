import type { WebProviderPlugin } from '../plugin-types';
import { rakutenWeb } from './rakuten-web';
import { createRakutenStreamAdapter } from './rakuten-stream-adapter';
import { rakutenToolStrategy } from '../tool-strategy';

export const rakutenWebPlugin: WebProviderPlugin = {
  definition: rakutenWeb,
  createStreamAdapter: () => createRakutenStreamAdapter(),
  toolStrategy: rakutenToolStrategy,
};
