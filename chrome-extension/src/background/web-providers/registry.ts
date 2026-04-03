/**
 * Web provider registry — derives provider definitions from the plugin registry.
 */

import { getPlugin, getAllPlugins } from './plugin-registry';
import type { WebProviderDefinition, WebProviderId } from './types';

/**
 * Look up a web provider definition by ID.
 */
const getWebProvider = (id: WebProviderId): WebProviderDefinition | undefined =>
  getPlugin(id)?.definition;

/**
 * Get all registered web provider definitions.
 */
const getAllWebProviders = (): WebProviderDefinition[] =>
  getAllPlugins().map(p => p.definition);

export { getWebProvider, getAllWebProviders };
