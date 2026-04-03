import type { WebProviderPlugin } from '../plugin-types';
import { chatgptWeb } from './chatgpt-web';
import { createChatGPTStreamAdapter } from './chatgpt-stream-adapter';
import { chatgptToolStrategy } from '../tool-strategy';
import { chatgptMainWorldFetch } from '../content-fetch-chatgpt';

export const chatgptWebPlugin: WebProviderPlugin = {
  definition: chatgptWeb,
  createStreamAdapter: () => createChatGPTStreamAdapter(),
  toolStrategy: chatgptToolStrategy,
  contentFetchHandler: chatgptMainWorldFetch,
  hooks: {
    onStreamDone: ({ credential }) => {
      // Dynamic import to avoid pulling chrome.storage into test environments
      import('../auth').then(({ storeWebCredential }) => {
        storeWebCredential({ ...credential, lastRequestAt: Date.now() }).catch(() => {
          /* non-critical — stale detection degrades gracefully */
        });
      });
    },

    onMetadata: ({ providerId, metadata }) => {
      const meta = metadata as Record<string, string>;
      import('../auth').then(({ getWebCredential, storeWebCredential }) => {
        getWebCredential(providerId)
          .then(cred => {
            if (cred) {
              const merged = { ...cred.metadata, ...meta };
              storeWebCredential({ ...cred, metadata: merged }).catch(() => {
                /* non-critical */
              });
            }
          })
          .catch(() => {
            /* ignore */
          });
      });
    },

    shouldReloadTab: ({ credential }) => {
      const STALE_SESSION_MS = 10 * 60_000; // 10 minutes
      const lastReq = credential.lastRequestAt ?? 0;
      return Date.now() - lastReq > STALE_SESSION_MS;
    },

    supportsRetryRefresh: true,
  },
};
