import type { WebProviderDefinition } from '../types';

const kimiWeb: WebProviderDefinition = {
  id: 'kimi-web',
  name: 'Kimi (Web)',
  loginUrl: 'https://www.kimi.com',
  cookieDomain: '.kimi.com',
  sessionIndicators: ['kimi-auth'],
  defaultModelId: 'kimi',
  defaultModelName: 'Kimi',
  supportsTools: true,
  supportsReasoning: false,
  contextWindow: 128_000,
  buildRequest: opts => {
    const token = opts.credential.cookies['kimi-auth'] ?? '';
    // kimiToolStrategy.buildPrompt aggregates all history into a single user message
    const prompt = opts.messages[0]?.content ?? '';
    const scenario = 'SCENARIO_K2';
    return {
      url: 'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat',
      binaryProtocol: 'connect-json' as const,
      binaryEncodeBody: true,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/connect+json',
          'Connect-Protocol-Version': '1',
          'X-Language': 'zh-CN',
          'X-Msh-Platform': 'web',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          scenario,
          message: {
            role: 'user',
            blocks: [{ message_id: '', text: { content: prompt } }],
            scenario,
          },
          options: { thinking: false },
        }),
        credentials: 'include' as RequestCredentials,
      },
    };
  },
  parseSseDelta: data => {
    const obj = data as Record<string, unknown>;
    if (obj.done === true) return null;
    const op = obj.op as string | undefined;
    if (op === 'set' || op === 'append') {
      const block = obj.block as Record<string, unknown> | undefined;
      const text = block?.text as { content?: string } | undefined;
      return text?.content ?? null;
    }
    return null;
  },
};

export { kimiWeb };
