/**
 * Shared GLM request builder — used by both glm-web.ts and glm-intl-web.ts.
 * Encapsulates the common headers, body structure, signing, and token refresh logic.
 */

import type { WebRequestOpts } from '../types';
import { generateGlmSign, GLM_DEVICE_ID } from './glm-signing';

interface GlmProviderConfig {
  baseUrl: string;
  tokenCookieNames: string[];
  refreshTokenCookieNames: string[];
}

const buildGlmRequestConfig = (opts: WebRequestOpts, config: GlmProviderConfig) => {
  // glmToolStrategy.buildPrompt aggregates all history into a single user message
  const prompt = opts.messages[0]?.content ?? '';

  // Find auth token from stored cookies
  let authToken = '';
  for (const name of config.tokenCookieNames) {
    if (opts.credential.cookies[name]) {
      authToken = opts.credential.cookies[name];
      break;
    }
  }

  // Find refresh token for setupRequest token refresh
  let refreshToken = '';
  for (const name of config.refreshTokenCookieNames) {
    if (opts.credential.cookies[name]) {
      refreshToken = opts.credential.cookies[name];
      break;
    }
  }

  const needsRefresh = !authToken && !!refreshToken;

  // Generate signing headers
  const { timestamp, nonce, sign } = generateGlmSign();
  const setupSign = needsRefresh ? generateGlmSign() : undefined;

  return {
    url: `${config.baseUrl}/chatglm/backend-api/assistant/stream`,
    urlTemplate: needsRefresh,
    setupRequest: needsRefresh
      ? {
          url: `${config.baseUrl}/chatglm/user-api/user/refresh`,
          init: {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${refreshToken}`,
              'App-Name': 'chatglm',
              'X-App-Platform': 'pc',
              'X-App-Version': '0.0.1',
              'X-Device-Id': GLM_DEVICE_ID,
              'X-Request-Id': crypto.randomUUID(),
              'X-Sign': setupSign!.sign,
              'X-Nonce': setupSign!.nonce,
              'X-Timestamp': setupSign!.timestamp,
            },
            body: JSON.stringify({}),
            credentials: 'include' as RequestCredentials,
          },
        }
      : undefined,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: authToken
          ? `Bearer ${authToken}`
          : needsRefresh
            ? 'Bearer {access_token}'
            : '',
        'App-Name': 'chatglm',
        'X-App-Platform': 'pc',
        'X-App-Version': '0.0.1',
        'X-App-fr': 'default',
        'X-Device-Brand': '',
        'X-Device-Id': GLM_DEVICE_ID,
        'X-Device-Model': '',
        'X-Lang': 'zh',
        'X-Request-Id': crypto.randomUUID(),
        'X-Sign': sign,
        'X-Nonce': nonce,
        'X-Timestamp': timestamp,
      },
      body: JSON.stringify({
        assistant_id: '65940acff94777010aa6b796',
        conversation_id: opts.conversationId ?? '',
        project_id: '',
        chat_type: 'user_chat',
        meta_data: {
          cogview: { rm_label_watermark: false },
          is_test: false,
          input_question_type: 'xxxx',
          channel: '',
          draft_id: '',
          chat_mode: 'zero',
          is_networking: false,
          quote_log_id: '',
          platform: 'pc',
        },
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
          },
        ],
      }),
      credentials: 'include' as RequestCredentials,
    },
  };
};

/** Standard GLM parseSseDelta — extracts text from parts[].content[].text. */
const parseGlmSseDelta = (data: unknown): string | null => {
  const obj = data as Record<string, unknown>;
  const parts = obj.parts as Array<{ content?: Array<{ text?: string }> }> | undefined;
  return parts?.[0]?.content?.[0]?.text ?? null;
};

/**
 * Extended GLM parseSseDelta with fallback formats — for international endpoint
 * which may use alternative response shapes.
 */
const parseGlmIntlSseDelta = (data: unknown): string | null => {
  const primary = parseGlmSseDelta(data);
  if (primary != null) return primary;
  const obj = data as Record<string, unknown>;
  return (
    (obj.text as string | undefined) ??
    (obj.content as string | undefined) ??
    (obj.delta as string | undefined) ??
    null
  );
};

export { buildGlmRequestConfig, parseGlmSseDelta, parseGlmIntlSseDelta };
export type { GlmProviderConfig };
