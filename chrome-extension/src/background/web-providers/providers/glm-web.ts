import type { WebProviderDefinition } from '../types';
import { refreshGlmAuth } from './glm-signing';
import { buildGlmRequestConfig, parseGlmSseDelta } from './glm-shared';

const glmWeb: WebProviderDefinition = {
  id: 'glm-web',
  name: 'GLM (Web)',
  loginUrl: 'https://chatglm.cn',
  cookieDomain: '.chatglm.cn',
  sessionIndicators: ['chatglm_refresh_token', 'chatglm_token'],
  defaultModelId: 'glm-4',
  defaultModelName: 'GLM-4',
  supportsTools: true,
  supportsReasoning: false,
  contextWindow: 128_000,
  refreshAuth: opts => refreshGlmAuth({ ...opts, baseUrl: 'https://chatglm.cn' }),
  buildRequest: opts =>
    buildGlmRequestConfig(opts, {
      baseUrl: 'https://chatglm.cn',
      tokenCookieNames: ['chatglm_token', 'access_token'],
      refreshTokenCookieNames: ['chatglm_refresh_token'],
    }),
  parseSseDelta: parseGlmSseDelta,
};

export { glmWeb };
