import { PROVIDER_DEFAULT_BASE_URLS } from '@extension/shared';

/** Azure uses a resource-templated endpoint rather than a single fixed URL. */
export const AZURE_BASE_URL_PLACEHOLDER = 'https://{resource}.openai.azure.com/openai';

/**
 * Providers whose effective base URL is fixed by the background model adapter
 * (`chatModelToPiModel`) — it applies the provider default unconditionally, so
 * any base URL entered in the dialog is ignored. The field is shown read-only
 * for these to avoid implying it's configurable.
 */
const FIXED_BASE_URL_PROVIDERS = new Set(['anthropic', 'google', 'openrouter', 'requesty']);

/** True when the provider's base URL cannot be overridden by the user. */
export const isFixedBaseUrlProvider = (provider: string): boolean =>
  FIXED_BASE_URL_PROVIDERS.has(provider);

/**
 * The base-URL placeholder shown for a provider in the Add/Edit Model dialog.
 * Reflects the endpoint that will actually be used; falls back to the OpenAI
 * default for OpenAI-compatible providers (openai/custom) and unknown values.
 */
export const getBaseUrlPlaceholder = (provider: string): string => {
  if (provider === 'azure') return AZURE_BASE_URL_PLACEHOLDER;
  return (
    PROVIDER_DEFAULT_BASE_URLS[provider as keyof typeof PROVIDER_DEFAULT_BASE_URLS] ??
    PROVIDER_DEFAULT_BASE_URLS.openai
  );
};
