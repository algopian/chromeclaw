import { createStorage, StorageEnum } from '../base/index.js';

/** Supported locale codes. Keep in sync with LocaleCode in @extension/i18n. */
type LocaleCode = 'auto' | 'en' | 'zh_CN' | 'zh_TW' | 'ja' | 'es' | 'de' | 'fr' | 'nl' | 'ru' | 'pt';

interface SettingsData {
  theme: 'light' | 'dark' | 'system';
  locale: LocaleCode;
}

const defaultSettings: SettingsData = {
  theme: 'system',
  locale: 'auto',
};

const settingsStorage = createStorage<SettingsData>('settings', defaultSettings, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type { SettingsData, LocaleCode };
export { settingsStorage };
