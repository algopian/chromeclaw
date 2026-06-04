import { createMergingStorage } from './create-merging-storage.js';
import { createStorage, StorageEnum } from '../base/index.js';

interface SttConfig {
  engine: 'auto' | 'off' | 'openai' | 'transformers';
  /** `apiVersion` is the Azure OpenAI `api-version` query param; ignored by vanilla OpenAI. */
  openai: { apiKey: string; model: string; baseUrl: string; apiVersion?: string };
  language: string;
  localModel: string;
}

const defaultSttConfig: SttConfig = {
  engine: 'transformers',
  openai: { apiKey: '', model: 'whisper-1', baseUrl: 'https://api.openai.com/v1', apiVersion: '2024-06-01' },
  language: 'en',
  localModel: 'tiny',
};

const rawSttConfigStorage = createStorage<SttConfig>('stt-config', defaultSttConfig, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const sttConfigStorage = createMergingStorage(rawSttConfigStorage, defaultSttConfig, ['openai']);

export type { SttConfig };
export { sttConfigStorage, defaultSttConfig };
