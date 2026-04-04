/**
 * Plugin registry — single source of truth for all web provider plugins.
 *
 * Adding a new provider:
 * 1. Create providers/{id}.plugin.ts
 * 2. Import and add to the `plugins` array below
 * 3. Add the id to WebProviderId in types.ts
 */

import { claudeWebPlugin } from './providers/claude-web.plugin';
import { chatgptWebPlugin } from './providers/chatgpt-web.plugin';
import { geminiWebPlugin } from './providers/gemini-web.plugin';
import { qwenWebPlugin } from './providers/qwen-web.plugin';
import { qwenCnWebPlugin } from './providers/qwen-cn-web.plugin';
import { kimiWebPlugin } from './providers/kimi-web.plugin';
import { glmWebPlugin } from './providers/glm-web.plugin';
import { glmIntlWebPlugin } from './providers/glm-intl-web.plugin';
import { deepseekWebPlugin } from './providers/deepseek-web.plugin';
import { doubaoWebPlugin } from './providers/doubao-web.plugin';
import { rakutenWebPlugin } from './providers/rakuten-web.plugin';
import type { WebProviderId } from './types';
import type { WebProviderPlugin } from './plugin-types';

const plugins: readonly WebProviderPlugin[] = [
  geminiWebPlugin,
  chatgptWebPlugin,
  claudeWebPlugin,
  deepseekWebPlugin,
  doubaoWebPlugin,
  kimiWebPlugin,
  qwenWebPlugin,
  qwenCnWebPlugin,
  glmWebPlugin,
  glmIntlWebPlugin,
  rakutenWebPlugin,
];

const pluginMap = new Map<WebProviderId, WebProviderPlugin>(
  plugins.map(p => [p.definition.id, p]),
);

/** Look up a web provider plugin by ID. */
const getPlugin = (id: WebProviderId): WebProviderPlugin | undefined => pluginMap.get(id);

/** Get all registered web provider plugins. */
const getAllPlugins = (): readonly WebProviderPlugin[] => plugins;

export { getPlugin, getAllPlugins };
