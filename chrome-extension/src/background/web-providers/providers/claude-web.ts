import type { WebProviderDefinition } from '../types';

const ROOT_PARENT_UUID = '00000000-0000-4000-8000-000000000000';

const claudeWeb: WebProviderDefinition = {
  id: 'claude-web',
  name: 'Claude (Web)',
  loginUrl: 'https://claude.ai',
  cookieDomain: '.claude.ai',
  sessionIndicators: ['sessionKey', 'lastActiveOrg'],
  defaultModelId: 'claude-sonnet-4.6',
  defaultModelName: 'Claude Sonnet 4.6',
  supportsTools: true,
  supportsReasoning: true,
  contextWindow: 200_000,
  buildRequest: opts => {
    const orgId = opts.credential.cookies['lastActiveOrg'] ?? '';
    const basePath = orgId
      ? `https://claude.ai/api/organizations/${orgId}`
      : 'https://claude.ai/api';
    const prompt = opts.messages.at(-1)?.content ?? '';
    const conversationUuid = crypto.randomUUID();

    return {
      url: `${basePath}/chat_conversations/{uuid}/completion`,
      urlTemplate: true,
      setupRequest: {
        url: `${basePath}/chat_conversations`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '', uuid: conversationUuid }),
          credentials: 'include' as RequestCredentials,
        },
      },
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'anthropic-client-platform': 'web_claude_ai',
        },
        body: JSON.stringify({
          prompt,
          parent_message_uuid: ROOT_PARENT_UUID,
          model: 'claude-sonnet-4-6',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          rendering_mode: 'messages',
          attachments: [],
          files: [],
          locale: 'en-US',
          personalized_styles: [],
          sync_sources: [],
          tools: [],
        }),
        credentials: 'include' as RequestCredentials,
      },
    };
  },
  parseSseDelta: data => {
    const obj = data as Record<string, unknown>;
    if (obj.type === 'content_block_delta') {
      const delta = obj.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        return delta.text;
      }
    }
    return null;
  },
};

export { claudeWeb };
