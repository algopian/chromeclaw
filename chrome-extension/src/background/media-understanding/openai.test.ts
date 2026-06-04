import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;

describe('openai provider — transcribe', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let openaiProvider: any;

  beforeEach(async () => {
    globalThis.fetch = vi.fn();
    const mod = await import('./providers/openai');
    openaiProvider = mod.openaiProvider;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const options = {
    apiKey: 'sk-test-key',
    model: 'whisper-1',
    baseUrl: 'https://api.openai.com/v1',
  };
  const audio = new ArrayBuffer(100);

  it('sends correct FormData with model and file', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'hello world' }),
    });

    await openaiProvider.transcribe(audio, 'audio/webm', options);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.openai.com/v1/audio/transcriptions');

    const body = call[1].body as FormData;
    expect(body.get('model')).toBe('whisper-1');
    expect(body.get('file')).toBeInstanceOf(Blob);
  });

  it('sends Authorization header with API key', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'test' }),
    });

    await openaiProvider.transcribe(audio, 'audio/webm', options);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].headers.Authorization).toBe('Bearer sk-test-key');
  });

  it('returns transcript text on success', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'transcribed text here' }),
    });

    const result = await openaiProvider.transcribe(audio, 'audio/webm', options);
    expect(result).toBe('transcribed text here');
  });

  it('throws on non-ok response with body', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Invalid API key'),
    });

    await expect(openaiProvider.transcribe(audio, 'audio/webm', options)).rejects.toThrow(
      'OpenAI STT failed (401): Invalid API key',
    );
  });

  it('throws when no API key provided', async () => {
    await expect(
      openaiProvider.transcribe(audio, 'audio/webm', { model: 'whisper-1' }),
    ).rejects.toThrow('No API key for OpenAI STT');
  });

  it('uses ogg extension for audio/ogg mime type', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'ogg' }),
    });

    await openaiProvider.transcribe(audio, 'audio/ogg', options);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = call[1].body as FormData;
    const file = body.get('file') as File;
    expect(file.name).toBe('audio.ogg');
  });

  it('uses mp3 extension for audio/mpeg mime type', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'mp3' }),
    });

    await openaiProvider.transcribe(audio, 'audio/mpeg', options);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = call[1].body as FormData;
    const file = body.get('file') as File;
    expect(file.name).toBe('audio.mp3');
  });

  it('uses webm extension for unknown mime types', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'webm' }),
    });

    await openaiProvider.transcribe(audio, 'audio/wav', options);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = call[1].body as FormData;
    const file = body.get('file') as File;
    expect(file.name).toBe('audio.webm');
  });

  it('works with custom base URL', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'custom' }),
    });

    await openaiProvider.transcribe(audio, 'audio/ogg', {
      ...options,
      baseUrl: 'https://custom.api.com/v1',
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://custom.api.com/v1/audio/transcriptions');
  });

  it('appends language to FormData when provided', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'chinese' }),
    });

    await openaiProvider.transcribe(audio, 'audio/ogg', { ...options, language: 'zh' });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = call[1].body as FormData;
    expect(body.get('language')).toBe('zh');
  });

  it('does not append language when empty', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'auto' }),
    });

    await openaiProvider.transcribe(audio, 'audio/ogg', { ...options, language: '' });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = call[1].body as FormData;
    expect(body.get('language')).toBeNull();
  });

  describe('Azure OpenAI endpoints', () => {
    const azureBase =
      'https://my-res.cognitiveservices.azure.com/openai/deployments/whisper';

    it('uses api-key header (not Bearer) for Azure hosts', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: 'azure' }),
      });

      await openaiProvider.transcribe(audio, 'audio/ogg', { ...options, baseUrl: azureBase });

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].headers['api-key']).toBe('sk-test-key');
      expect(call[1].headers.Authorization).toBeUndefined();
    });

    it('appends default api-version query param for Azure hosts', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: 'azure' }),
      });

      await openaiProvider.transcribe(audio, 'audio/ogg', { ...options, baseUrl: azureBase });

      const url = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(url.searchParams.get('api-version')).toBe('2024-06-01');
    });

    it('uses the provided apiVersion when set', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: 'azure' }),
      });

      await openaiProvider.transcribe(audio, 'audio/ogg', {
        ...options,
        baseUrl: azureBase,
        apiVersion: '2025-01-01',
      });

      const url = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(url.searchParams.get('api-version')).toBe('2025-01-01');
    });

    it('does not double-append api-version already present in base URL', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: 'azure' }),
      });

      await openaiProvider.transcribe(audio, 'audio/ogg', {
        ...options,
        baseUrl: `${azureBase}?api-version=2023-09-01`,
        apiVersion: '2025-01-01',
      });

      const url = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(url.searchParams.getAll('api-version')).toEqual(['2023-09-01']);
    });

    it('matches classic .openai.azure.com hosts too', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: 'azure' }),
      });

      await openaiProvider.transcribe(audio, 'audio/ogg', {
        ...options,
        baseUrl: 'https://my-res.openai.azure.com/openai/deployments/whisper',
      });

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].headers['api-key']).toBe('sk-test-key');
      const url = new URL(call[0]);
      expect(url.searchParams.get('api-version')).toBe('2024-06-01');
    });

    it('does not double-append /audio/transcriptions when base URL already targets it', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: 'azure' }),
      });

      await openaiProvider.transcribe(audio, 'audio/ogg', {
        ...options,
        baseUrl: `${azureBase}/audio/transcriptions`,
      });

      const url = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(url.pathname).toBe('/openai/deployments/whisper/audio/transcriptions');
      expect(url.searchParams.get('api-version')).toBe('2024-06-01');
    });

    it('does not append /audio/transcriptions when base URL targets /audio/translations', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: 'azure' }),
      });

      await openaiProvider.transcribe(audio, 'audio/ogg', {
        ...options,
        baseUrl: `${azureBase}/audio/translations`,
      });

      const url = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(url.pathname).toBe('/openai/deployments/whisper/audio/translations');
    });
  });
});
