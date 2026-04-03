import { createStorage, StorageEnum } from '../base/index.js';

/** Stored credential for a web provider session. */
interface WebProviderCredential {
  providerId: string;
  cookies: Record<string, string>;
  token?: string;
  expiresAt?: number;
  capturedAt: number;
  /** Timestamp of the last successful request (used by chatgpt-web for stale-session detection). */
  lastRequestAt?: number;
  /** Provider-specific metadata (e.g., chatgpt-web stores deviceId here for cross-request stability). */
  metadata?: Record<string, string>;
}

const webCredentialsStorage = createStorage<Record<string, WebProviderCredential>>(
  'web-credentials',
  {},
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export { webCredentialsStorage };
export type { WebProviderCredential };
