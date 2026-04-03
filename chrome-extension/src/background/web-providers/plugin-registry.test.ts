/**
 * Tests for plugin-registry.ts — ensures every WebProviderId has a registered plugin.
 */
import { describe, it, expect } from 'vitest';
import { getPlugin, getAllPlugins } from './plugin-registry';
import type { WebProviderId } from './types';

/** All provider IDs — must match the WebProviderId union in types.ts. */
const ALL_PROVIDER_IDS: WebProviderId[] = [
  'claude-web',
  'kimi-web',
  'qwen-web',
  'qwen-cn-web',
  'glm-web',
  'glm-intl-web',
  'gemini-web',
  'deepseek-web',
  'doubao-web',
  'chatgpt-web',
  'rakuten-web',
];

describe('plugin-registry', () => {
  it('has a plugin registered for every WebProviderId', () => {
    for (const id of ALL_PROVIDER_IDS) {
      const plugin = getPlugin(id);
      expect(plugin, `Missing plugin for provider: ${id}`).toBeDefined();
      expect(plugin!.definition.id).toBe(id);
    }
  });

  it('getAllPlugins returns all providers', () => {
    const plugins = getAllPlugins();
    expect(plugins.length).toBe(ALL_PROVIDER_IDS.length);
    const ids = new Set(plugins.map(p => p.definition.id));
    for (const id of ALL_PROVIDER_IDS) {
      expect(ids.has(id), `Missing plugin in getAllPlugins for: ${id}`).toBe(true);
    }
  });

  it('each plugin has a definition with required fields', () => {
    for (const plugin of getAllPlugins()) {
      expect(plugin.definition.id).toBeTruthy();
      expect(plugin.definition.name).toBeTruthy();
      expect(plugin.definition.loginUrl).toBeTruthy();
    }
  });
});
