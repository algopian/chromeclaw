import type { WebProviderPlugin } from '../plugin-types';
import { qwenCnWeb } from './qwen-cn-web';
import { createQwenStreamAdapter } from './qwen-stream-adapter';
import { qwenToolStrategy } from '../tool-strategy';

export const qwenCnWebPlugin: WebProviderPlugin = {
  definition: qwenCnWeb,
  createStreamAdapter: opts => createQwenStreamAdapter({ skipNativeTools: opts?.excludeTools }),
  toolStrategy: qwenToolStrategy,
};
