type MediaEngine = 'auto' | 'off' | 'openai' | 'transformers' | 'gemini-web';

interface TranscribeOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  /** Azure OpenAI api-version query param; only used for Azure endpoints. */
  apiVersion?: string;
}

interface MediaProvider {
  id: string;
  transcribe: (audio: ArrayBuffer, mimeType: string, options: TranscribeOptions) => Promise<string>;
}

export type { MediaEngine, TranscribeOptions, MediaProvider };
export type { SttConfig } from '@extension/storage';
