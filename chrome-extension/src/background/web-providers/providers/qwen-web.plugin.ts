import type { WebProviderPlugin } from '../plugin-types';
import { qwenWeb } from './qwen-web';
import { createQwenStreamAdapter } from './qwen-stream-adapter';
import { qwenToolStrategy } from '../tool-strategy';

export const qwenWebPlugin: WebProviderPlugin = {
  definition: qwenWeb,
  createStreamAdapter: opts => createQwenStreamAdapter({ skipNativeTools: opts?.excludeTools }),
  toolStrategy: qwenToolStrategy,
};
