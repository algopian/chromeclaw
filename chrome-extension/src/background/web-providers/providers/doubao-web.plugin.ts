import type { WebProviderPlugin } from '../plugin-types';
import { doubaoWeb } from './doubao-web';
import { createDoubaoStreamAdapter } from './doubao-stream-adapter';
import { doubaoToolStrategy } from '../tool-strategy';

export const doubaoWebPlugin: WebProviderPlugin = {
  definition: doubaoWeb,
  createStreamAdapter: () => createDoubaoStreamAdapter(),
  toolStrategy: doubaoToolStrategy,
};
