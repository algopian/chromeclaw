/**
 * Tests for registry.ts — web provider registry.
 */
import { describe, it, expect } from 'vitest';
import { getWebProvider, getAllWebProviders } from './registry';

describe('web provider registry', () => {
  it('returns all 7 providers', () => {
    const all = getAllWebProviders();
    expect(all).toHaveLength(7);
  });

  it('looks up claude-web provider by ID', () => {
    const provider = getWebProvider('claude-web');
    expect(provider).toBeDefined();
    expect(provider!.name).toBe('Claude (Web)');
    expect(provider!.loginUrl).toBe('https://claude.ai');
  });

  it('returns undefined for unknown provider ID', () => {
    const provider = getWebProvider('nonexistent' as any);
    expect(provider).toBeUndefined();
  });

  it('all providers have required fields', () => {
    const all = getAllWebProviders();
    for (const p of all) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.loginUrl).toBeTruthy();
      expect(p.cookieDomain).toBeTruthy();
      expect(p.sessionIndicators.length).toBeGreaterThan(0);
      expect(p.defaultModelId).toBeTruthy();
      expect(typeof p.buildRequest).toBe('function');
      expect(typeof p.parseSseDelta).toBe('function');
    }
  });
});
