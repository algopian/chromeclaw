import type { WebProviderPlugin } from '../plugin-types';
import { kimiWeb } from './kimi-web';
import { createKimiStreamAdapter } from './kimi-web-stream-adapter';
import { kimiToolStrategy } from '../tool-strategy';

export const kimiWebPlugin: WebProviderPlugin = {
  definition: kimiWeb,
  createStreamAdapter: () => createKimiStreamAdapter(),
  toolStrategy: kimiToolStrategy,
};
