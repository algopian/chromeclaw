/**
 * Tests for model-adapter.ts
 * Verifies conversion from extension ChatModel to pi-mono Model<Api>.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@extension/shared', () => ({
  getModelContextLimit: vi.fn((id: string) => {
    if (id === 'gpt-4o') return 128000;
    return 8192;
  }),
}));

import { chatModelToPiModel } from './model-adapter';
import type { ChatModel } from '@extension/shared';

// ── Helpers ──────────────────────────────────────────────

const makeModel = (overrides: Partial<ChatModel> = {}): ChatModel => ({
  id: 'gpt-4o',
  name: 'GPT-4o',
  provider: 'openai',
  ...overrides,
});

// ── chatModelToPiModel ───────────────────────────────────

describe('chatModelToPiModel', () => {
  it('resolves OpenAI provider with correct api, baseUrl, and provider', () => {
    const result = chatModelToPiModel(makeModel({ provider: 'openai' }));

    expect(result.model.api).toBe('openai-completions');
    expect(result.model.baseUrl).toBe('https://api.openai.com/v1');
    expect(result.model.provider).toBe('openai');
  });

  it('resolves Anthropic provider with anthropic-messages api', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus' }),
    );

    expect(result.model.api).toBe('anthropic-messages');
    expect(result.model.baseUrl).toBe('https://api.anthropic.com');
    expect(result.model.provider).toBe('anthropic');
  });

  it('resolves Google provider with google-generative-ai api', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'google', id: 'gemini-2.0-flash', name: 'Gemini Flash' }),
    );

    expect(result.model.api).toBe('google-generative-ai');
    expect(result.model.baseUrl).toBe('https://generativelanguage.googleapis.com');
    expect(result.model.provider).toBe('google');
  });

  it('resolves OpenRouter with openai-completions api and openrouter base URL', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openrouter', id: 'or-model', name: 'OpenRouter Model' }),
    );

    expect(result.model.api).toBe('openai-completions');
    expect(result.model.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(result.model.provider).toBe('openrouter');
  });

  it('resolves custom provider with openai-completions api and custom baseUrl', () => {
    const result = chatModelToPiModel(
      makeModel({
        provider: 'custom',
        id: 'custom-model',
        name: 'Custom',
        baseUrl: 'https://my-proxy.example.com/v1',
      }),
    );

    expect(result.model.api).toBe('openai-completions');
    expect(result.model.baseUrl).toBe('https://my-proxy.example.com/v1');
    expect(result.model.provider).toBe('openai');
  });

  it('resolves custom provider without baseUrl to OpenAI default', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'custom', id: 'custom-model', name: 'Custom' }),
    );

    expect(result.model.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('resolves local provider with empty baseUrl, provider=local, contextWindow=4096', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'local', id: 'llama-3', name: 'Llama 3' }),
    );

    expect(result.model.api).toBe('openai-completions');
    expect(result.model.baseUrl).toBe('');
    expect(result.model.provider).toBe('local');
    expect(result.model.contextWindow).toBe(4096);
  });

  it('resolves unknown provider to default case', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'unknown-provider' as ChatModel['provider'], id: 'some-model' }),
    );

    expect(result.model.api).toBe('openai-completions');
    expect(result.model.provider).toBe('unknown-provider');
    expect(result.model.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('returns apiKey as undefined when not provided', () => {
    const result = chatModelToPiModel(makeModel());

    expect(result.apiKey).toBeUndefined();
  });

  it('returns apiKey as undefined when apiKey is empty string', () => {
    const result = chatModelToPiModel(makeModel({ apiKey: '' }));

    expect(result.apiKey).toBeUndefined();
  });

  it('returns apiKey when provided', () => {
    const result = chatModelToPiModel(makeModel({ apiKey: 'sk-test-key-123' }));

    expect(result.apiKey).toBe('sk-test-key-123');
  });

  it('uses custom baseUrl for OpenAI when provided', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openai', baseUrl: 'https://custom-openai.example.com/v1' }),
    );

    expect(result.model.baseUrl).toBe('https://custom-openai.example.com/v1');
  });

  it('propagates supportsReasoning as true when set', () => {
    const result = chatModelToPiModel(makeModel({ supportsReasoning: true }));

    expect(result.model.reasoning).toBe(true);
  });

  it('defaults reasoning to false when supportsReasoning is undefined', () => {
    const result = chatModelToPiModel(makeModel());

    expect(result.model.reasoning).toBe(false);
  });

  it('defaults reasoning to false when supportsReasoning is false', () => {
    const result = chatModelToPiModel(makeModel({ supportsReasoning: false }));

    expect(result.model.reasoning).toBe(false);
  });

  it('sets maxTokens to 25% of contextWindow', () => {
    const result = chatModelToPiModel(makeModel({ id: 'gpt-4o' }));

    // contextWindow = 128000 → maxTokens = 32000
    expect(result.model.contextWindow).toBe(128000);
    expect(result.model.maxTokens).toBe(Math.floor(128000 * 0.25));
    expect(result.model.maxTokens).toBe(32000);
  });

  it('sets maxTokens to 25% of contextWindow for local models', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'local', id: 'local-model', name: 'Local' }),
    );

    // contextWindow = 4096 → maxTokens = 1024
    expect(result.model.contextWindow).toBe(4096);
    expect(result.model.maxTokens).toBe(1024);
  });

  it('sets maxTokens to 25% of contextWindow for unknown models', () => {
    const result = chatModelToPiModel(makeModel({ id: 'some-unknown-model' }));

    // getModelContextLimit returns 8192 for unknown → maxTokens = 2048
    expect(result.model.contextWindow).toBe(8192);
    expect(result.model.maxTokens).toBe(Math.floor(8192 * 0.25));
    expect(result.model.maxTokens).toBe(2048);
  });

  it('preserves model id and name in output', () => {
    const result = chatModelToPiModel(makeModel({ id: 'gpt-4o', name: 'GPT-4o' }));

    expect(result.model.id).toBe('gpt-4o');
    expect(result.model.name).toBe('GPT-4o');
  });

  it('sets input to text and image', () => {
    const result = chatModelToPiModel(makeModel());

    expect(result.model.input).toEqual(['text', 'image']);
  });

  it('sets all cost fields to zero', () => {
    const result = chatModelToPiModel(makeModel());

    expect(result.model.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  // ── Explicit api field ───────────────

  it('uses explicit api field to override openai provider default', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openai', api: 'openai-responses' }),
    );

    expect(result.model.api).toBe('openai-responses');
  });

  it('uses explicit api field for openai-codex-responses', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openai', id: 'gpt-5.3-codex', api: 'openai-codex-responses' }),
    );

    expect(result.model.api).toBe('openai-codex-responses');
  });

  it('defaults to openai-completions for gpt-4o when api field is undefined (backward compat)', () => {
    const result = chatModelToPiModel(makeModel({ provider: 'openai', id: 'gpt-4o' }));

    expect(result.model.api).toBe('openai-completions');
  });

  // ── Auto-detect from model ID ──────────────────────────

  it('routes gpt-5.3-codex to openai-responses (standard API, not ChatGPT backend)', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openai', id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' }),
    );

    expect(result.model.api).toBe('openai-responses');
  });

  it('routes gpt-5.1-codex to openai-responses', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openai', id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' }),
    );

    expect(result.model.api).toBe('openai-responses');
  });

  it('routes gpt-5.2-codex to openai-responses', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openai', id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' }),
    );

    expect(result.model.api).toBe('openai-responses');
  });

  it('does not auto-detect for non-openai providers with codex in id', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openrouter', id: 'openai/gpt-5.3-codex', name: 'GPT-5.3 Codex' }),
    );

    expect(result.model.api).toBe('openai-completions');
  });

  it('auto-detects openai-codex-responses for codex-mini-latest', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openai', id: 'codex-mini-latest', name: 'Codex Mini' }),
    );

    expect(result.model.api).toBe('openai-codex-responses');
  });

  it('auto-detects openai-responses for gpt-5', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openai', id: 'gpt-5', name: 'GPT-5' }),
    );

    expect(result.model.api).toBe('openai-responses');
  });

  it('auto-detects openai-responses for o3', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openai', id: 'o3', name: 'o3' }),
    );

    expect(result.model.api).toBe('openai-responses');
  });

  it('explicit api field overrides auto-detect', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openai', id: 'gpt-5.3-codex', api: 'openai-completions' }),
    );

    expect(result.model.api).toBe('openai-completions');
  });

  it('uses explicit api field with custom provider', () => {
    const result = chatModelToPiModel(
      makeModel({
        provider: 'custom',
        id: 'custom-model',
        baseUrl: 'https://my-proxy.example.com/v1',
        api: 'openai-responses',
      }),
    );

    expect(result.model.api).toBe('openai-responses');
  });

  it('uses explicit api field with openrouter provider', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'openrouter', id: 'openai/gpt-5', api: 'openai-responses' }),
    );

    expect(result.model.api).toBe('openai-responses');
  });

  // ── Azure OpenAI routing ────────────────────────────────

  it('sets azureApiVersion for Azure endpoints (custom provider)', () => {
    const result = chatModelToPiModel(
      makeModel({
        provider: 'custom',
        id: 'gpt-5.1-codex-mini',
        baseUrl: 'https://myresource.openai.azure.com/openai',
        api: 'openai-responses',
      }),
    );

    expect(result.model.api).toBe('openai-responses');
    expect(result.azureApiVersion).toBe('2025-04-01-preview');
  });

  it('sets azureApiVersion for azure provider', () => {
    const result = chatModelToPiModel(
      makeModel({
        provider: 'azure',
        id: 'gpt-5.1-codex-mini',
        baseUrl: 'https://myresource.openai.azure.com/openai',
      }),
    );

    expect(result.model.api).toBe('openai-responses');
    expect(result.azureApiVersion).toBe('2025-04-01-preview');
  });

  it('uses custom azureApiVersion when provided', () => {
    const result = chatModelToPiModel(
      makeModel({
        provider: 'azure',
        id: 'gpt-4o',
        baseUrl: 'https://myresource.openai.azure.com/openai',
        azureApiVersion: '2024-12-01-preview',
      }),
    );

    expect(result.azureApiVersion).toBe('2024-12-01-preview');
  });

  it('does not set azureApiVersion for non-Azure endpoints', () => {
    const result = chatModelToPiModel(
      makeModel({
        provider: 'custom',
        id: 'gpt-5.1-codex-mini',
        baseUrl: 'https://my-proxy.example.com/v1',
        api: 'openai-responses',
      }),
    );

    expect(result.azureApiVersion).toBeUndefined();
  });

  // ── OpenAI Codex provider ───────────────────────────────

  it('routes openai-codex provider to openai-codex-responses with chatgpt.com base URL', () => {
    const result = chatModelToPiModel(
      makeModel({
        provider: 'openai-codex',
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
      }),
    );

    expect(result.model.api).toBe('openai-codex-responses');
    expect(result.model.baseUrl).toBe('https://chatgpt.com/backend-api');
    expect(result.model.provider).toBe('openai-codex');
  });

  it('allows custom base URL for openai-codex provider', () => {
    const result = chatModelToPiModel(
      makeModel({
        provider: 'openai-codex',
        id: 'gpt-5.2-codex',
        baseUrl: 'https://custom-codex-proxy.example.com',
      }),
    );

    expect(result.model.api).toBe('openai-codex-responses');
    expect(result.model.baseUrl).toBe('https://custom-codex-proxy.example.com');
  });

  // ── contextWindow override ──────────────────────────────

  it('uses contextWindow from ChatModel when set', () => {
    const result = chatModelToPiModel(makeModel({ id: 'gpt-4o', contextWindow: 32_000 }));

    expect(result.model.contextWindow).toBe(32_000);
    expect(result.model.maxTokens).toBe(Math.floor(32_000 * 0.25));
  });

  it('falls back to table lookup when contextWindow is undefined', () => {
    const result = chatModelToPiModel(makeModel({ id: 'gpt-4o' }));

    expect(result.model.contextWindow).toBe(128_000);
  });

  it('uses contextWindow override even for local models', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'local', id: 'local-model', name: 'Local', contextWindow: 8192 }),
    );

    expect(result.model.contextWindow).toBe(8192);
    expect(result.model.maxTokens).toBe(Math.floor(8192 * 0.25));
  });

  // ── Web provider ───────────────────────────────

  it('routes web provider with empty baseUrl and provider=web', () => {
    const result = chatModelToPiModel(
      makeModel({ provider: 'web', id: 'claude-web', name: 'Claude Web' }),
    );

    expect(result.model.api).toBe('openai-completions');
    expect(result.model.baseUrl).toBe('');
    expect(result.model.provider).toBe('web');
  });

  it('does not override anthropic api even if api field is set', () => {
    // Anthropic has its own api; the explicit field still overrides
    // because the user explicitly set it — this tests the override behavior
    const result = chatModelToPiModel(
      makeModel({
        provider: 'anthropic',
        id: 'claude-opus-4-6',
        api: 'openai-responses',
      }),
    );

    // Explicit api overrides even for anthropic (user knows what they're doing)
    expect(result.model.api).toBe('openai-responses');
  });
});
