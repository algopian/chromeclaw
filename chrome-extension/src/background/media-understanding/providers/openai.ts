import { DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL } from '../defaults';
import { isAzureOpenAIEndpoint } from '../../agents/model-adapter';
import { createLogger } from '../../logging/logger-buffer';
import type { MediaProvider, TranscribeOptions } from '../types';

const DEFAULT_AZURE_API_VERSION = '2024-06-01';

const log = createLogger('media');

const transcribe = async (
  audio: ArrayBuffer,
  mimeType: string,
  options: TranscribeOptions,
): Promise<string> => {
  const {
    apiKey,
    baseUrl = DEFAULT_OPENAI_BASE_URL,
    model = DEFAULT_OPENAI_MODEL,
    language,
    apiVersion,
  } = options;
  if (!apiKey) throw new Error('No API key for OpenAI STT');

  const ext = mimeType.includes('ogg')
    ? 'ogg'
    : mimeType.includes('mp3') || mimeType.includes('mpeg')
      ? 'mp3'
      : 'webm';
  const blob = new Blob([audio], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, `audio.${ext}`);
  form.append('model', model);
  if (language) form.append('language', language);

  // Azure OpenAI differs from vanilla OpenAI: it authenticates with an `api-key`
  // header (not Bearer) and requires an `api-version` query param. Detect from the
  // base URL host and adapt the request; non-Azure endpoints are unchanged.
  const isAzure = isAzureOpenAIEndpoint(baseUrl);

  // Append the path to the base URL's pathname so any existing query string
  // (e.g. a pre-set `?api-version=`) is preserved rather than mangled by naive
  // string concatenation. If the base URL already targets an audio operation
  // (common for Azure deployment URLs that include the full operation path),
  // use it as-is instead of double-appending `/audio/transcriptions`.
  const url = new URL(baseUrl);
  const trimmedPath = url.pathname.replace(/\/$/, '');
  const alreadyTargetsAudioOp = /\/audio\/(transcriptions|translations)$/.test(trimmedPath);
  url.pathname = alreadyTargetsAudioOp ? trimmedPath : `${trimmedPath}/audio/transcriptions`;
  if (isAzure && !url.searchParams.has('api-version')) {
    url.searchParams.set('api-version', apiVersion || DEFAULT_AZURE_API_VERSION);
  }

  const headers: Record<string, string> = isAzure
    ? { 'api-key': apiKey }
    : { Authorization: `Bearer ${apiKey}` };

  // Diagnostic logging (never logs the raw key) — surfaces in the Logs panel so a
  // live repro reveals exactly what request was constructed.
  log.debug('STT request', {
    url: url.toString(),
    isAzure,
    authScheme: isAzure ? 'api-key' : 'Bearer',
    model,
    mimeType,
    apiVersion: isAzure ? apiVersion || DEFAULT_AZURE_API_VERSION : undefined,
    hasKey: Boolean(apiKey),
  });

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log.error('STT request failed', {
      status: response.status,
      isAzure,
      url: url.toString(),
      body: body.slice(0, 500),
    });
    throw new Error(`OpenAI STT failed (${response.status}): ${body}`);
  }

  log.debug('STT request succeeded', { status: response.status, isAzure });

  const data = (await response.json()) as { text: string };
  return data.text;
};

const openaiProvider: MediaProvider = { id: 'openai', transcribe };

export { openaiProvider };
