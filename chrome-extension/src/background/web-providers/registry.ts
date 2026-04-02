/**
 * Web provider registry — re-exports all provider definitions.
 */

import { claudeWeb } from './providers/claude-web';
import { chatgptWeb } from './providers/chatgpt-web';
import { deepseekWeb } from './providers/deepseek-web';
import { doubaoWeb } from './providers/doubao-web';
import { qwenWeb } from './providers/qwen-web';
import { qwenCnWeb } from './providers/qwen-cn-web';
import { kimiWeb } from './providers/kimi-web';
import { glmWeb } from './providers/glm-web';
import { glmIntlWeb } from './providers/glm-intl-web';
import { geminiWeb } from './providers/gemini-web';
import { rakutenWeb } from './providers/rakuten-web';
import type { WebProviderDefinition, WebProviderId } from './types';

const providers: WebProviderDefinition[] = [
  geminiWeb,
  chatgptWeb,
  claudeWeb,
  deepseekWeb,
  doubaoWeb,
  kimiWeb,
  qwenWeb,
  qwenCnWeb,
  glmWeb,
  glmIntlWeb,
  rakutenWeb,
];

const providerMap = new Map<WebProviderId, WebProviderDefinition>(providers.map(p => [p.id, p]));

/**
 * Look up a web provider definition by ID.
 */
const getWebProvider = (id: WebProviderId): WebProviderDefinition | undefined =>
  providerMap.get(id);

/**
 * Get all registered web provider definitions.
 */
const getAllWebProviders = (): WebProviderDefinition[] => providers;

export { getWebProvider, getAllWebProviders };
