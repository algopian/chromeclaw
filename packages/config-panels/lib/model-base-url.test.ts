import {
  AZURE_BASE_URL_PLACEHOLDER,
  getBaseUrlPlaceholder,
  isFixedBaseUrlProvider,
} from './model-base-url';
import { PROVIDER_DEFAULT_BASE_URLS } from '@extension/shared';
import { describe, expect, it } from 'vitest';

describe('getBaseUrlPlaceholder', () => {
  it('returns the requesty default for the requesty provider', () => {
    expect(getBaseUrlPlaceholder('requesty')).toBe(PROVIDER_DEFAULT_BASE_URLS.requesty);
  });

  it('returns the openrouter default for the openrouter provider', () => {
    expect(getBaseUrlPlaceholder('openrouter')).toBe(PROVIDER_DEFAULT_BASE_URLS.openrouter);
  });

  it('returns the anthropic/google defaults', () => {
    expect(getBaseUrlPlaceholder('anthropic')).toBe(PROVIDER_DEFAULT_BASE_URLS.anthropic);
    expect(getBaseUrlPlaceholder('google')).toBe(PROVIDER_DEFAULT_BASE_URLS.google);
  });

  it('returns the Azure resource template for azure', () => {
    expect(getBaseUrlPlaceholder('azure')).toBe(AZURE_BASE_URL_PLACEHOLDER);
    expect(getBaseUrlPlaceholder('azure')).toContain('{resource}');
  });

  it('falls back to the OpenAI default for openai, custom, and unknown providers', () => {
    expect(getBaseUrlPlaceholder('openai')).toBe(PROVIDER_DEFAULT_BASE_URLS.openai);
    expect(getBaseUrlPlaceholder('custom')).toBe(PROVIDER_DEFAULT_BASE_URLS.openai);
    expect(getBaseUrlPlaceholder('something-else')).toBe(PROVIDER_DEFAULT_BASE_URLS.openai);
  });
});

describe('isFixedBaseUrlProvider', () => {
  // Providers whose base URL the model adapter applies unconditionally.
  it('is true for providers whose base URL the backend ignores', () => {
    for (const p of ['anthropic', 'google', 'openrouter', 'requesty']) {
      expect(isFixedBaseUrlProvider(p)).toBe(true);
    }
  });

  it('is false for user-configurable / non-applicable providers', () => {
    for (const p of ['openai', 'custom', 'azure', 'openai-codex', 'web', 'local', 'unknown']) {
      expect(isFixedBaseUrlProvider(p)).toBe(false);
    }
  });
});
