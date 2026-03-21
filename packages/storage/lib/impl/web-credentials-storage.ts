import { createStorage, StorageEnum } from '../base/index.js';

/** Stored credential for a web provider session. */
interface WebProviderCredential {
  providerId: string;
  cookies: Record<string, string>;
  token?: string;
  expiresAt?: number;
  capturedAt: number;
}

const webCredentialsStorage = createStorage<Record<string, WebProviderCredential>>(
  'web-credentials',
  {},
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export { webCredentialsStorage };
export type { WebProviderCredential };
