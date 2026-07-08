import { useT } from '@extension/i18n';
import { useWebAuth } from '@extension/shared';
import { defaultSttConfig, sttConfigStorage } from '@extension/storage';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@extension/ui';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  HardDriveIcon,
  InfoIcon,
  LoaderIcon,
  LogInIcon,
  LogOutIcon,
  MicIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebAuthDefinition } from '@extension/shared';
import type { SttConfig } from '@extension/storage';

const engineOptions = [
  { value: 'off', label: 'Off' },
  { value: 'transformers', label: 'Whisper (Local)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini-web', label: 'Gemini (browser, no API key)' },
] as const;

const engineDescriptions: Record<string, string> = {
  off: 'Audio transcription is disabled',
  openai: "Uses OpenAI's Whisper API for high-accuracy cloud transcription",
  transformers: 'Runs a transformer model locally via ONNX — no data leaves your browser',
  'gemini-web':
    'Transcribes using your logged-in Gemini web session — no API key required. Requires an active gemini.google.com login. May stop working without notice.',
};

/** Auth definitions for speech engines backed by a browser session. */
const speechWebAuthDefinitions: Record<string, WebAuthDefinition> = {
  'gemini-web': {
    id: 'gemini-web',
    cookieDomain: '.google.com',
    sessionIndicators: ['__Secure-1PSID', 'SAPISID'],
    loginUrl: 'https://gemini.google.com',
  },
};

const localModelOptions = [
  { value: 'tiny', label: 'Tiny (multilingual)', size: '74 MB' },
  { value: 'tiny.en', label: 'Tiny (English)', size: '74 MB' },
  { value: 'base', label: 'Base (multilingual)', size: '141 MB' },
  { value: 'base.en', label: 'Base (English)', size: '141 MB' },
  { value: 'small', label: 'Small (multilingual)', size: '465 MB' },
  { value: 'small.en', label: 'Small (English)', size: '465 MB' },
] as const;

const languageOptions = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ru', label: 'Russian' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'it', label: 'Italian' },
  { value: 'nl', label: 'Dutch' },
  { value: 'tr', label: 'Turkish' },
  { value: 'pl', label: 'Polish' },
  { value: 'vi', label: 'Vietnamese' },
  { value: 'th', label: 'Thai' },
  { value: 'id', label: 'Indonesian' },
  { value: 'uk', label: 'Ukrainian' },
] as const;

const TRANSFORMERS_CACHE_NAME = 'transformers-cache';

interface DownloadProgress {
  downloadId: string | null;
  status: 'idle' | 'downloading' | 'complete' | 'error';
  percent: number;
  error?: string;
}

interface CachedModel {
  model: string;
  label: string;
  sizeBytes: number;
  fileCount: number;
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Query the Cache API for downloaded Whisper models. */
const listCachedModels = async (): Promise<CachedModel[]> => {
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    const keys = await cache.keys();

    const modelSizes = new Map<string, { sizeBytes: number; fileCount: number }>();

    for (const request of keys) {
      const match = request.url.match(/Xenova\/whisper-([^/]+)/);
      if (!match) continue;

      const model = match[1];
      const response = await cache.match(request);
      const size = response ? parseInt(response.headers.get('Content-Length') ?? '0', 10) : 0;

      const existing = modelSizes.get(model) ?? { sizeBytes: 0, fileCount: 0 };
      existing.sizeBytes += size;
      existing.fileCount += 1;
      modelSizes.set(model, existing);
    }

    const result: CachedModel[] = [];
    for (const [model, info] of modelSizes) {
      const opt = localModelOptions.find(o => o.value === model);
      result.push({
        model,
        label: opt?.label ?? model,
        sizeBytes: info.sizeBytes,
        fileCount: info.fileCount,
      });
    }

    return result;
  } catch {
    return [];
  }
};

/** Delete all cached files for a specific Whisper model. */
const deleteCachedModel = async (model: string): Promise<void> => {
  const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
  const keys = await cache.keys();
  const modelId = `Xenova/whisper-${model}`;

  for (const request of keys) {
    if (request.url.includes(modelId)) {
      await cache.delete(request);
    }
  }
};

const SpeechToTextConfig = () => {
  const t = useT();
  const [config, setConfig] = useState<SttConfig | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>({
    downloadId: null,
    status: 'idle',
    percent: 0,
  });
  const [cachedModels, setCachedModels] = useState<CachedModel[]>([]);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'importing' | 'complete' | 'error'>(
    'idle',
  );
  const [uploadError, setUploadError] = useState<string | undefined>();
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Auth hook for speech-web engines (e.g. gemini-web)
  const webAuthDef = config ? speechWebAuthDefinitions[config.engine] : undefined;
  const {
    status: authStatus,
    loginLoading,
    error: authError,
    login,
    logout,
  } = useWebAuth({
    definition: webAuthDef,
    recheckKey: config?.engine,
  });
  const showWebAuthSection = config?.engine === 'gemini-web';

  const refreshCachedModels = useCallback(async () => {
    const models = await listCachedModels();
    setCachedModels(models);
  }, []);

  useEffect(() => {
    sttConfigStorage
      .get()
      .then(setConfig)
      .catch(() => setConfig({ ...defaultSttConfig }));
    refreshCachedModels();
  }, [refreshCachedModels]);

  // Refresh cache list when a download completes
  useEffect(() => {
    if (downloadProgress.status === 'complete') {
      refreshCachedModels();
    }
  }, [downloadProgress.status, refreshCachedModels]);

  // Listen for download progress messages
  useEffect(() => {
    const listener = (message: Record<string, unknown>) => {
      if (
        message.type === 'STT_DOWNLOAD_PROGRESS' &&
        typeof message.downloadId === 'string' &&
        message.downloadId === downloadProgress.downloadId
      ) {
        setDownloadProgress(prev => ({
          ...prev,
          status: message.status as DownloadProgress['status'],
          percent: (message.percent as number) ?? prev.percent,
          error: message.error as string | undefined,
        }));
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [downloadProgress.downloadId]);

  const handleEngineChange = useCallback((engine: SttConfig['engine']) => {
    setConfig(prev => {
      if (!prev) return null;
      const next = { ...prev, engine };
      sttConfigStorage.set(next);
      return next;
    });
    setDownloadProgress({ downloadId: null, status: 'idle', percent: 0 });
  }, []);

  const handleOpenAIFieldChange = useCallback((field: keyof SttConfig['openai'], value: string) => {
    setConfig(prev => {
      if (!prev) return null;
      const next = { ...prev, openai: { ...prev.openai, [field]: value } };
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        sttConfigStorage.set(next);
      }, 500);
      return next;
    });
  }, []);

  const handleLanguageChange = useCallback((value: string) => {
    setConfig(prev => {
      if (!prev) return null;
      const next = { ...prev, language: value };
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        sttConfigStorage.set(next);
      }, 500);
      return next;
    });
  }, []);

  const handleLocalModelChange = useCallback((model: string) => {
    setConfig(prev => {
      if (!prev) return null;
      const next = { ...prev, localModel: model };
      sttConfigStorage.set(next);
      return next;
    });
    setDownloadProgress({ downloadId: null, status: 'idle', percent: 0 });
  }, []);

  const handleDownloadModel = useCallback(async () => {
    if (!config) return;
    const model = config.localModel || 'tiny';

    setDownloadProgress({ downloadId: null, status: 'downloading', percent: 0 });

    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'STT_DOWNLOAD_MODEL',
        engine: 'transformers',
        model,
      })) as { downloadId?: string; error?: string };

      if (response?.downloadId) {
        setDownloadProgress(prev => ({ ...prev, downloadId: response.downloadId! }));
      } else {
        setDownloadProgress({
          downloadId: null,
          status: 'error',
          percent: 0,
          error: response?.error ?? 'Failed to start download',
        });
      }
    } catch (err) {
      setDownloadProgress({
        downloadId: null,
        status: 'error',
        percent: 0,
        error: err instanceof Error ? err.message : 'Failed to start download',
      });
    }
  }, [config]);

  const handleDeleteModel = useCallback(
    async (model: string) => {
      setDeletingModel(model);
      try {
        await deleteCachedModel(model);
        await refreshCachedModels();
      } finally {
        setDeletingModel(null);
      }
    },
    [refreshCachedModels],
  );

  const handleImportFolder = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!config) return;
      const files = event.target.files;
      if (!files || files.length === 0) return;

      const fileList = Array.from(files);
      const hasConfigJson = fileList.some(f => f.name === 'config.json');
      const hasOnnx = fileList.some(f => f.name.endsWith('.onnx'));

      if (!hasConfigJson || !hasOnnx) {
        setUploadStatus('error');
        setUploadError('Folder must contain config.json and at least one .onnx file');
        if (folderInputRef.current) folderInputRef.current.value = '';
        return;
      }

      setUploadStatus('importing');
      setUploadError(undefined);

      try {
        const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
        const model = config.localModel || 'tiny';

        for (const file of fileList) {
          const parts = file.webkitRelativePath.split('/');
          const relativePath = parts.slice(1).join('/');
          if (!relativePath) continue;

          const url = `https://huggingface.co/Xenova/whisper-${model}/resolve/main/${relativePath}`;
          const blob = new Blob([await file.arrayBuffer()], {
            type: file.type || 'application/octet-stream',
          });
          await cache.put(
            url,
            new Response(blob, { headers: { 'Content-Length': String(file.size) } }),
          );
        }

        await refreshCachedModels();
        setUploadStatus('complete');
      } catch (err) {
        setUploadStatus('error');
        setUploadError(err instanceof Error ? err.message : 'Import failed');
      } finally {
        if (folderInputRef.current) folderInputRef.current.value = '';
      }
    },
    [config, refreshCachedModels],
  );

  if (!config) return null;

  const isEnabled = config.engine !== 'off';
  const showOpenAIFields = config.engine === 'openai';
  const showLocalModelFields = config.engine === 'transformers';
  const selectedModelCached = cachedModels.some(m => m.model === (config.localModel || 'tiny'));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MicIcon className="size-5" />
          Speech-to-Text
        </CardTitle>
        <CardDescription>Configure speech-to-text and media processing</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="stt-engine">Engine</Label>
            <Select
              onValueChange={v => handleEngineChange(v as SttConfig['engine'])}
              value={config.engine}>
              <SelectTrigger id="stt-engine">
                <SelectValue placeholder="Select engine" />
              </SelectTrigger>
              <SelectContent>
                {engineOptions.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{engineDescriptions[config.engine]}</p>
          </div>

          {showWebAuthSection && (
            <div className="grid gap-2 pl-8">
              <div className="flex items-center gap-3">
                <span className="text-sm">
                  {authStatus === 'checking' && (
                    <span className="text-muted-foreground flex items-center gap-1.5">
                      <LoaderIcon className="size-3.5 animate-spin" />
                      {t('stt_web_status_checking')}
                    </span>
                  )}
                  {authStatus === 'logged-in' && (
                    <span className="flex items-center gap-1.5 text-green-600">
                      <CheckCircle2Icon className="size-3.5" />
                      {t('stt_web_status_logged_in')}
                    </span>
                  )}
                  {authStatus === 'expired' && (
                    <span className="flex items-center gap-1.5 text-amber-600">
                      <AlertCircleIcon className="size-3.5" />
                      {t('stt_web_status_expired')}
                    </span>
                  )}
                  {authStatus === 'not-logged-in' && (
                    <span className="text-muted-foreground flex items-center gap-1.5">
                      <AlertCircleIcon className="size-3.5" />
                      {t('stt_web_status_not_logged_in')}
                    </span>
                  )}
                </span>

                {(authStatus === 'not-logged-in' || authStatus === 'expired') && (
                  <Button disabled={loginLoading} onClick={login} size="sm" variant="outline">
                    {loginLoading ? (
                      <LoaderIcon className="mr-1.5 size-3.5 animate-spin" />
                    ) : (
                      <LogInIcon className="mr-1.5 size-3.5" />
                    )}
                    {loginLoading ? 'Signing in\u2026' : t('stt_web_login')}
                  </Button>
                )}

                {authStatus === 'logged-in' && (
                  <Button onClick={logout} size="sm" variant="ghost">
                    <LogOutIcon className="mr-1.5 size-3.5" />
                    {t('stt_web_logout')}
                  </Button>
                )}
              </div>

              {authError && (
                <p className="flex items-center gap-1.5 text-xs text-red-600">
                  <AlertCircleIcon className="size-3" />
                  {authError}
                </p>
              )}
            </div>
          )}

          {isEnabled && <h3 className="text-sm font-medium">Audio Transcription</h3>}

          {showOpenAIFields && (
            <div className="grid gap-3 pl-8">
              <div className="grid gap-2">
                <Label htmlFor="stt-api-key">API Key</Label>
                <Input
                  id="stt-api-key"
                  onChange={e => handleOpenAIFieldChange('apiKey', e.target.value)}
                  placeholder="sk-..."
                  type="password"
                  value={config.openai.apiKey}
                />
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <InfoIcon className="size-3" />
                  Optional — auto-detects from OpenAI model config
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="stt-model">Model</Label>
                <Input
                  id="stt-model"
                  onChange={e => handleOpenAIFieldChange('model', e.target.value)}
                  placeholder="whisper-1"
                  value={config.openai.model}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="stt-base-url">Base URL</Label>
                <Input
                  id="stt-base-url"
                  onChange={e => handleOpenAIFieldChange('baseUrl', e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  type="url"
                  value={config.openai.baseUrl}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="stt-api-version">API Version</Label>
                <Input
                  id="stt-api-version"
                  onChange={e => handleOpenAIFieldChange('apiVersion', e.target.value)}
                  placeholder="2024-06-01"
                  value={config.openai.apiVersion ?? ''}
                />
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <InfoIcon className="size-3" />
                  Required for Azure OpenAI endpoints; ignored by standard OpenAI
                </p>
              </div>
            </div>
          )}

          {showLocalModelFields && (
            <div className="grid gap-3 pl-8">
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <ExternalLinkIcon className="size-3" />
                Source:{' '}
                <a
                  className="hover:text-foreground underline underline-offset-2"
                  href={`https://huggingface.co/Xenova/whisper-${config.localModel || 'tiny'}`}
                  rel="noopener noreferrer"
                  target="_blank">
                  huggingface.co/Xenova/whisper-{config.localModel || 'tiny'}
                </a>
              </p>

              <div className="grid gap-2">
                <Label htmlFor="stt-local-model">Whisper Model</Label>
                <Select onValueChange={handleLocalModelChange} value={config.localModel || 'tiny'}>
                  <SelectTrigger id="stt-local-model">
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    {localModelOptions.map(opt => {
                      const cached = cachedModels.some(m => m.model === opt.value);
                      return (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label} ({opt.size}){cached ? ' \u2713' : ''}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  disabled={downloadProgress.status === 'downloading'}
                  id="stt-download-model"
                  onClick={handleDownloadModel}
                  size="sm"
                  variant="outline">
                  {downloadProgress.status === 'downloading' ? (
                    <LoaderIcon className="mr-1.5 size-4 animate-spin" />
                  ) : selectedModelCached ? (
                    <CheckCircle2Icon className="mr-1.5 size-4" />
                  ) : (
                    <DownloadIcon className="mr-1.5 size-4" />
                  )}
                  {downloadProgress.status === 'downloading'
                    ? 'Downloading...'
                    : selectedModelCached
                      ? 'Re-download'
                      : 'Download Model'}
                </Button>

                <Button
                  disabled={uploadStatus === 'importing'}
                  onClick={() => folderInputRef.current?.click()}
                  size="sm"
                  variant="outline">
                  {uploadStatus === 'importing' ? (
                    <LoaderIcon className="mr-1.5 size-4 animate-spin" />
                  ) : (
                    <FolderOpenIcon className="mr-1.5 size-4" />
                  )}
                  {uploadStatus === 'importing' ? 'Importing...' : 'Import from folder'}
                </Button>

                <input
                  className="hidden"
                  onChange={handleImportFolder}
                  ref={folderInputRef}
                  type="file"
                  {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                />

                {downloadProgress.status === 'complete' && (
                  <span className="flex items-center gap-1 text-xs text-green-600">
                    <CheckCircle2Icon className="size-4" />
                    Ready
                  </span>
                )}

                {downloadProgress.status === 'error' && (
                  <span className="flex items-center gap-1 text-xs text-red-600">
                    <AlertCircleIcon className="size-4" />
                    {downloadProgress.error || 'Download failed'}
                  </span>
                )}

                {uploadStatus === 'complete' && (
                  <span className="flex items-center gap-1 text-xs text-green-600">
                    <CheckCircle2Icon className="size-4" />
                    Imported
                  </span>
                )}

                {uploadStatus === 'error' && (
                  <span className="flex items-center gap-1 text-xs text-red-600">
                    <AlertCircleIcon className="size-4" />
                    {uploadError || 'Import failed'}
                  </span>
                )}
              </div>

              {downloadProgress.status === 'downloading' && (
                <Progress className="h-2" value={downloadProgress.percent} />
              )}

              <p className="text-muted-foreground text-xs">
                Models download on first use. Pre-download to avoid waiting.
              </p>

              {cachedModels.length > 0 && (
                <div className="mt-2 space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <HardDriveIcon className="size-3.5" />
                    Downloaded Models
                  </Label>
                  <div className="divide-border divide-y rounded-md border">
                    {cachedModels.map(m => (
                      <div
                        className="flex items-center justify-between px-3 py-2 text-sm"
                        key={m.model}>
                        <div>
                          <span className="font-medium">{m.label}</span>
                          <span className="text-muted-foreground ml-2 text-xs">
                            {formatBytes(m.sizeBytes)}
                          </span>
                        </div>
                        <Button
                          className="text-destructive hover:text-destructive h-7 px-2"
                          disabled={deletingModel === m.model}
                          onClick={() => handleDeleteModel(m.model)}
                          size="sm"
                          variant="ghost">
                          {deletingModel === m.model ? (
                            <LoaderIcon className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2Icon className="size-3.5" />
                          )}
                        </Button>
                      </div>
                    ))}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Total: {formatBytes(cachedModels.reduce((sum, m) => sum + m.sizeBytes, 0))}
                  </p>
                </div>
              )}
            </div>
          )}

          {isEnabled && (
            <div className="grid gap-2">
              <Label htmlFor="stt-language">Language</Label>
              <Input
                id="stt-language"
                list="stt-language-options"
                onChange={e => handleLanguageChange(e.target.value)}
                placeholder="en"
                value={config.language}
              />
              <datalist id="stt-language-options">
                {languageOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </datalist>
              <p className="text-muted-foreground text-xs">
                ISO 639-1 code. Pick from the list or type a language code.
              </p>
            </div>
          )}

          {/* Future: <Separator /> + Image Understanding section */}
          {/* Future: <Separator /> + Video Understanding section */}
        </div>
      </CardContent>
    </Card>
  );
};

export { SpeechToTextConfig };
