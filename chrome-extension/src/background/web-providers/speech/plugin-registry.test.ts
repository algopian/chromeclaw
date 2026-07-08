/**
 * Tests for speech/plugin-registry.ts — ensures every speech web provider has
 * a registered plugin with a valid definition.
 *
 * Mirrors web-providers/plugin-registry.test.ts (LLM side).
 */
import { describe, it, expect } from 'vitest';
import { getSpeechPlugin, getAllSpeechPlugins } from './plugin-registry';

describe('speech plugin-registry', () => {
  it('getSpeechPlugin("gemini-web") returns the gemini speech plugin', () => {
    const plugin = getSpeechPlugin('gemini-web');
    expect(plugin).toBeDefined();
    expect(plugin!.definition.id).toBe('gemini-web');
    expect(plugin!.definition.name).toBeTruthy();
    expect(plugin!.definition.loginUrl).toBeTruthy();
    expect(plugin!.definition.cookieDomain).toBeTruthy();
    expect(plugin!.definition.sessionIndicators.length).toBeGreaterThan(0);
  });

  it('getSpeechPlugin returns undefined for unknown id', () => {
    expect(getSpeechPlugin('unknown-provider')).toBeUndefined();
    expect(getSpeechPlugin('')).toBeUndefined();
    expect(getSpeechPlugin('openai')).toBeUndefined();
  });

  it('getAllSpeechPlugins returns all registered plugins', () => {
    const plugins = getAllSpeechPlugins();
    expect(plugins.length).toBeGreaterThan(0);
    const ids = plugins.map(p => p.definition.id);
    expect(ids).toContain('gemini-web');
  });

  it('each plugin has encodeRequest, decodeResult, and channelClient', () => {
    for (const plugin of getAllSpeechPlugins()) {
      expect(typeof plugin.encodeRequest).toBe('function');
      expect(typeof plugin.decodeResult).toBe('function');
      expect(typeof plugin.channelClient).toBe('function');
    }
  });
});
