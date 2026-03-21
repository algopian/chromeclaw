import type { WebProviderDefinition } from '../types';

const qwenCnWeb: WebProviderDefinition = {
  id: 'qwen-cn-web',
  name: 'Qwen CN (Web)',
  loginUrl: 'https://qianwen.com',
  cookieDomain: '.qianwen.com',
  sessionIndicators: ['tongyi_sso_ticket'],
  defaultModelId: 'qwen-max',
  defaultModelName: 'Qwen Max (CN)',
  supportsTools: true,
  supportsReasoning: true,
  contextWindow: 32_000,
  buildRequest: opts => {
    const xsrfToken = opts.credential.cookies['XSRF-TOKEN'] ?? '';
    return {
      url: 'https://qianwen.com/api/chat/completions',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(xsrfToken ? { 'X-XSRF-TOKEN': xsrfToken } : {}),
        },
        body: JSON.stringify({
          model: 'qwen-max',
          messages: [{ role: 'system', content: opts.systemPrompt }, ...opts.messages],
          stream: true,
        }),
        credentials: 'include' as RequestCredentials,
      },
    };
  },
  parseSseDelta: data => {
    const obj = data as Record<string, unknown>;
    const choices = obj.choices as Array<{ delta?: { content?: string } }> | undefined;
    return choices?.[0]?.delta?.content ?? null;
  },
};

export { qwenCnWeb };
