/**
 * Converts extension ChatModel to pi-mono Model<Api>,
 * along with resolved apiKey and headers for streaming.
 */

import { getModelContextLimit } from '@extension/shared';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { ChatModel } from '@extension/shared';
import { normalizeModelCompat } from './model-compat';

interface ResolvedModel {
  model: Model<Api>;
  apiKey?: string;
  /** Azure API version — only set when routing to azure-openai-responses. */
  azureApiVersion?: string;
}

/** Detect Azure OpenAI endpoints (https://{resource}.openai.azure.com/...) */
const isAzureOpenAIEndpoint = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl).hostname.endsWith('.openai.azure.com');
  } catch {
    return false;
  }
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api/v1',
};

export const chatModelToPiModel = (config: ChatModel): ResolvedModel => {
  let api: Api;
  let baseUrl: string;
  let provider: string;
  const apiKey = config.apiKey || undefined;

  switch (config.provider) {
    case 'openai':
      api = 'openai-completions';
      baseUrl = config.baseUrl || DEFAULT_BASE_URLS.openai;
      provider = 'openai';
      break;
    case 'anthropic':
      api = 'anthropic-messages';
      baseUrl = DEFAULT_BASE_URLS.anthropic;
      provider = 'anthropic';
      break;
    case 'google':
      api = 'google-generative-ai';
      baseUrl = DEFAULT_BASE_URLS.google;
      provider = 'google';
      break;
    case 'openrouter':
      api = 'openai-completions';
      baseUrl = DEFAULT_BASE_URLS.openrouter;
      provider = 'openrouter';
      break;
    case 'custom':
      api = 'openai-completions';
      baseUrl = config.baseUrl || DEFAULT_BASE_URLS.openai;
      provider = 'openai';
      break;
    case 'azure':
      api = 'openai-responses';
      baseUrl = config.baseUrl || '';
      provider = 'openai';
      break;
    case 'openai-codex':
      api = 'openai-codex-responses' as Api;
      baseUrl = config.baseUrl || 'https://chatgpt.com/backend-api';
      provider = 'openai-codex';
      break;
    case 'local':
      api = 'openai-completions'; // placeholder — not actually used for local
      baseUrl = '';
      provider = 'local';
      break;
    case 'web':
      api = 'openai-completions'; // placeholder — not used for web
      baseUrl = '';
      provider = 'web';
      break;
    default:
      api = 'openai-completions';
      baseUrl = config.baseUrl || DEFAULT_BASE_URLS.openai;
      provider = config.provider;
  }

  // Resolve OpenAI-compatible API: explicit field > auto-detect > provider default
  if (config.api) {
    api = config.api;
  } else if (api === 'openai-completions' && config.provider === 'openai') {
    const id = config.id.toLowerCase();
    if (/^(gpt-5|o[3-9]($|[^1-9])|o\d{2,})/.test(id)) {
      api = 'openai-responses';
    } else if (id.includes('codex')) {
      api = 'openai-codex-responses';
    }
  }

  // Azure OpenAI: detect Azure endpoints and pass api-version for the fetch
  // interceptor in stream-bridge. Uses standard OpenAI client (not AzureOpenAI)
  // because Azure endpoints accept Bearer auth, which AzureOpenAI replaces with
  // api-key header.
  let azureApiVersion: string | undefined;
  const isAzure = config.provider === 'azure' || isAzureOpenAIEndpoint(baseUrl);
  if (isAzure) {
    azureApiVersion = config.azureApiVersion || '2025-04-01-preview';
  }

  // Priority: explicit override > local default > table lookup
  const contextWindow =
    config.contextWindow ?? (config.provider === 'local' ? 4096 : getModelContextLimit(config.id));

  return {
    model: normalizeModelCompat({
      id: config.id,
      name: config.name,
      api,
      provider,
      baseUrl,
      reasoning: config.supportsReasoning ?? false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: Math.floor(contextWindow * 0.25),
    }),
    apiKey,
    azureApiVersion,
  };
};

export type { ResolvedModel };
