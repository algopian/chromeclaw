import { createStorage, StorageEnum } from '../base/index.js';

/**
 * Persists thinking level preference per web provider.
 * Key: webProviderId (e.g. 'gemini-web'), value: 'fast' | 'thinking'.
 * Chrome storage key kept as 'speed-mode-prefs' for backward compatibility.
 */
export const thinkingLevelStorage = createStorage<Record<string, string>>('speed-mode-prefs', {}, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});
