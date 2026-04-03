import type { WebProviderPlugin } from '../plugin-types';
import { geminiWeb } from './gemini-web';
import { createGeminiStreamAdapter } from './gemini-web-stream-adapter';
import { geminiToolStrategy } from '../tool-strategy';

export const geminiWebPlugin: WebProviderPlugin = {
  definition: geminiWeb,
  createStreamAdapter: () => createGeminiStreamAdapter(),
  toolStrategy: geminiToolStrategy,
};
