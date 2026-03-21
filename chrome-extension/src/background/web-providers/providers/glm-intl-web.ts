import type { WebProviderDefinition } from '../types';
import { refreshGlmAuth } from './glm-signing';
import { buildGlmRequestConfig, parseGlmIntlSseDelta } from './glm-shared';

const glmIntlWeb: WebProviderDefinition = {
  id: 'glm-intl-web',
  name: 'GLM Intl (Web)',
  loginUrl: 'https://chat.z.ai',
  cookieDomain: '.z.ai',
  sessionIndicators: ['chatglm_refresh_token', 'chatglm_token', 'refresh_token', 'auth_token', 'access_token', 'token'],
  defaultModelId: 'glm-4',
  defaultModelName: 'GLM-4 International',
  supportsTools: true,
  supportsReasoning: false,
  contextWindow: 128_000,
  refreshAuth: opts => refreshGlmAuth({ ...opts, baseUrl: 'https://chat.z.ai' }),
  buildRequest: opts =>
    buildGlmRequestConfig(opts, {
      baseUrl: 'https://chat.z.ai',
      tokenCookieNames: ['chatglm_token', 'access_token', 'auth_token', 'token'],
      refreshTokenCookieNames: ['chatglm_refresh_token', 'refresh_token'],
    }),
  parseSseDelta: parseGlmIntlSseDelta,
};

export { glmIntlWeb };
