import type { WebProviderDefinition } from '../types';

const qwenWeb: WebProviderDefinition = {
  id: 'qwen-web',
  name: 'Qwen (Web)',
  loginUrl: 'https://chat.qwen.ai',
  cookieDomain: '.qwen.ai',
  sessionIndicators: ['token', 'ctoken', 'login_aliyunid_ticket'],
  defaultModelId: 'qwen3.5-plus',
  defaultModelName: 'Qwen 3.5 Plus',
  supportsTools: true,
  supportsReasoning: true,
  contextWindow: 32_000,
  buildRequest: opts => {
    const fid = crypto.randomUUID();
    const model = 'qwen3.5-plus';

    // Strategy has already built the full prompt in opts.messages[0].content
    const prompt = opts.messages[0]?.content ?? '';
    const chatId = opts.conversationId;

    return {
      // When reusing a conversation, use the chat ID directly; otherwise use template
      url: chatId
        ? `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`
        : 'https://chat.qwen.ai/api/v2/chat/completions?chat_id={id}',
      urlTemplate: !chatId,
      // Only create a new chat session on first turn (no existing conversation)
      setupRequest: chatId
        ? undefined
        : {
            url: 'https://chat.qwen.ai/api/v2/chats/new',
            init: {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
              credentials: 'include' as RequestCredentials,
            },
          },
      // Stream completions
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          stream: true,
          version: '2.1',
          incremental_output: true,
          chat_id: chatId ?? '{id}',
          chat_mode: 'normal',
          model,
          parent_id: null,
          messages: [
            {
              fid,
              parentId: null,
              childrenIds: [],
              role: 'user',
              content: prompt,
              user_action: 'chat',
              files: [],
              timestamp: Math.floor(Date.now() / 1000),
              models: [model],
              chat_type: 't2t',
              feature_config: {
                thinking_enabled: true,
                output_schema: 'phase',
              },
            },
          ],
        }),
        credentials: 'include' as RequestCredentials,
      },
    };
  },
  parseSseDelta: data => {
    const obj = data as Record<string, unknown>;
    const choices = obj.choices as Array<{ delta?: { content?: string } }> | undefined;
    return (
      choices?.[0]?.delta?.content ??
      (obj.text as string | undefined) ??
      (obj.content as string | undefined) ??
      (obj.delta as string | undefined) ??
      null
    );
  },
};

export { qwenWeb };
