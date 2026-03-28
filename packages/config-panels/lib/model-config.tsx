import { WEBGPU_MODELS_ENABLED } from '@extension/env';
import { t, useT } from '@extension/i18n';
import { WEB_PROVIDER_OPTIONS, useWebProviderAuth } from '@extension/shared';
import { customModelsStorage } from '@extension/storage';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@extension/ui';
import {
  BrainCircuitIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  DownloadIcon,
  Loader2Icon,
  LogInIcon,
  LogOutIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DbChatModel } from '@extension/storage';

type ModelFormData = Omit<DbChatModel, 'id'> & { id?: string };

const defaultModelIds: Record<string, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-2.0-flash',
  openrouter: 'openai/gpt-4o',
  custom: '',
  azure: '',
  'openai-codex': 'gpt-5.3-codex',
  web: '',
  local: 'onnx-community/Qwen3-0.6B-ONNX',
};

const emptyForm: ModelFormData = {
  name: '',
  modelId: '',
  provider: 'web',
  description: '',
  apiKey: '',
  baseUrl: '',
  supportsTools: true,
  supportsReasoning: true,
  api: undefined,
  toolTimeoutSeconds: undefined,
  contextWindow: undefined,
  azureApiVersion: undefined,
};

const apiOptions = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'openai-completions', label: 'Chat Completions (/v1/chat/completions)' },
  { value: 'openai-responses', label: 'Responses (/v1/responses)' },
  { value: 'openai-codex-responses', label: 'Codex Responses (/v1/responses)' },
];

const providers = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'openai-codex', label: 'OpenAI Codex (ChatGPT)' },
  { value: 'custom', label: 'OpenAI Compatible' },
  { value: 'web', label: 'Web (Browser Session Zero Token)' },
  ...(WEBGPU_MODELS_ENABLED ? [{ value: 'local', label: 'WebGPU (On-Device)' }] : []),
];

const TRANSFORMERS_CACHE_NAME = 'transformers-cache';

const validateModelForm = (form: ModelFormData): string | null => {
  if (!form.name.trim()) return t('model_nameRequired');
  if (!form.provider) return t('model_providerRequired');
  if (form.provider === 'local') return null; // No API key or base URL needed
  if (form.provider === 'web') {
    if (!form.webProviderId?.trim()) return 'Web provider is required';
    return null; // modelId is optional for web — auto-filled from provider defaults
  }
  if (!form.modelId.trim()) return t('firstRun_modelIdRequired');
  if (form.provider === 'openai-codex') {
    if (!form.apiKey?.trim()) return 'ChatGPT OAuth token is required';
    return null;
  }
  if (form.provider === 'azure') {
    if (!form.baseUrl?.trim()) return 'Azure endpoint URL is required';
    if (!form.apiKey?.trim()) return t('firstRun_apiKeyRequired');
    return form.baseUrl && !/^https?:\/\/.+/.test(form.baseUrl) ? t('model_baseUrlInvalid') : null;
  }
  if (!form.apiKey?.trim() && !form.baseUrl?.trim()) return t('firstRun_apiKeyRequired');
  if (form.baseUrl && !/^https?:\/\/.+/.test(form.baseUrl)) return t('model_baseUrlInvalid');
  return null;
};

/** Inspect the transformers-cache Cache API for cached local model files. */
const listCachedLocalModels = async (
  modelIds: string[],
): Promise<Map<string, { sizeBytes: number; fileCount: number }>> => {
  const result = new Map<string, { sizeBytes: number; fileCount: number }>();
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    const keys = await cache.keys();
    for (const request of keys) {
      for (const modelId of modelIds) {
        if (request.url.includes(modelId)) {
          const entry = result.get(modelId) ?? { sizeBytes: 0, fileCount: 0 };
          const response = await cache.match(request);
          const contentLength = response?.headers.get('Content-Length');
          if (contentLength) {
            entry.sizeBytes += parseInt(contentLength, 10);
          }
          entry.fileCount++;
          result.set(modelId, entry);
        }
      }
    }
  } catch {
    // Cache API may not be available
  }
  return result;
};

/** Delete all cached files for a specific local model. */
const deleteCachedLocalModel = async (modelId: string): Promise<void> => {
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    const keys = await cache.keys();
    for (const request of keys) {
      if (
        request.url.includes(encodeURIComponent(modelId)) ||
        request.url.includes(modelId.replace(/\//g, '%2F')) ||
        request.url.includes(modelId)
      ) {
        await cache.delete(request);
      }
    }
  } catch {
    // Cache API may not be available
  }
};

/** Format bytes to human-readable size. */
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};

const ModelConfig = () => {
  const t = useT();
  const [models, setModels] = useState<DbChatModel[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editForm, setEditForm] = useState<ModelFormData>(emptyForm);
  const [formError, setFormError] = useState('');
  const [testResult, setTestResult] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');

  // Local model download/cache state
  const [downloadProgress, setDownloadProgress] = useState<{
    downloadId: string;
    status: 'downloading' | 'complete' | 'error';
    percent: number;
    error?: string;
  } | null>(null);
  const [cachedLocalModels, setCachedLocalModels] = useState<
    Map<string, { sizeBytes: number; fileCount: number }>
  >(new Map());

  const refreshCachedLocalModels = useCallback(async (modelList?: DbChatModel[]) => {
    const list = modelList ?? (await customModelsStorage.get());
    const localModelIds = list.filter(m => m.provider === 'local').map(m => m.modelId);
    if (localModelIds.length > 0) {
      const cached = await listCachedLocalModels(localModelIds);
      setCachedLocalModels(cached);
    } else {
      setCachedLocalModels(new Map());
    }
  }, []);

  useEffect(() => {
    customModelsStorage.get().then(list => {
      setModels(list);
      refreshCachedLocalModels(list);
    });
    const unsub = customModelsStorage.subscribe(() => {
      customModelsStorage.get().then(list => {
        setModels(list);
        refreshCachedLocalModels(list);
      });
    });
    return unsub;
  }, [refreshCachedLocalModels]);

  const handleOpenAdd = useCallback(() => {
    setEditForm(emptyForm);
    setFormError('');
    setTestResult('idle');
    setDownloadProgress(null);
    setDialogOpen(true);
  }, []);

  const handleOpenEdit = useCallback((model: DbChatModel) => {
    setEditForm({ ...model, modelId: model.modelId || model.id });
    setFormError('');
    setTestResult('idle');
    setDownloadProgress(null);
    setDialogOpen(true);
  }, []);

  // ── Web provider auth state (must be before handleSave which references webAuthStatus) ──
  const {
    status: webAuthStatus,
    loginLoading: webLoginLoading,
    error: webAuthError,
    login: handleWebLogin,
    logout: handleWebLogout,
  } = useWebProviderAuth({
    provider: editForm.provider,
    webProviderId: editForm.webProviderId,
    recheckKey: dialogOpen,
  });

  const handleFormChange = useCallback((key: keyof ModelFormData, value: string | boolean) => {
    setEditForm(prev => {
      const next = { ...prev, [key]: value };
      // Auto-fill modelId when provider changes (only if current modelId matches the old default)
      if (key === 'provider' && typeof value === 'string') {
        const oldDefault = defaultModelIds[prev.provider] ?? '';
        if (!prev.modelId || prev.modelId === oldDefault) {
          next.modelId = defaultModelIds[value] ?? '';
        }
        // Clear api when switching to non-OpenAI-compatible providers
        if (!['openai', 'custom', 'openrouter', 'azure'].includes(value)) {
          next.api = undefined;
        }
        // Azure provider: set Responses API as default
        if (value === 'azure') {
          next.api = 'openai-responses';
        }
        // Codex provider: defaults
        if (value === 'openai-codex') {
          next.api = undefined; // Always openai-codex-responses, no user choice
          next.baseUrl = 'https://chatgpt.com/backend-api';
          next.supportsReasoning = true;
          next.supportsTools = true;
        }
        // Web provider: no API key, no base URL needed; auto-set default webProviderId
        if (value === 'web') {
          next.apiKey = '';
          next.baseUrl = '';
          next.supportsTools = true;
          next.supportsReasoning = true;
          if (!next.webProviderId) {
            next.webProviderId = 'gemini-web';
          }
          // Auto-fill modelId and name from web provider defaults
          const wp = WEB_PROVIDER_OPTIONS.find(w => w.value === next.webProviderId);
          if (wp) {
            next.modelId = wp.defaultModelId;
            if (!next.name) next.name = wp.defaultModelName;
          }
        }
        // Force local provider defaults
        if (value === 'local') {
          next.supportsTools = true;
          next.apiKey = '';
          next.baseUrl = '';
        }
      }
      // Auto-fill modelId and name when webProviderId changes
      if (key === 'webProviderId' && typeof value === 'string') {
        const wp = WEB_PROVIDER_OPTIONS.find(w => w.value === value);
        if (wp) {
          const prevWp = WEB_PROVIDER_OPTIONS.find(w => w.value === prev.webProviderId);
          if (!prev.modelId || prev.modelId === (prevWp?.defaultModelId ?? '')) {
            next.modelId = wp.defaultModelId;
          }
          if (!prev.name || prev.name === (prevWp?.defaultModelName ?? '')) {
            next.name = wp.defaultModelName;
          }
        }
      }
      return next;
    });
    setFormError('');
  }, []);

  const handleSave = useCallback(async () => {
    const validationError = validateModelForm(editForm);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    if (editForm.provider === 'web' && webAuthStatus !== 'logged-in') {
      setFormError('You must log in to the web provider before saving.');
      return;
    }

    const webProviderDefaults =
      editForm.provider === 'web' && editForm.webProviderId
        ? WEB_PROVIDER_OPTIONS.find(w => w.value === editForm.webProviderId)
        : undefined;
    const model: DbChatModel = {
      id: editForm.id ?? nanoid(),
      modelId: editForm.modelId || webProviderDefaults?.defaultModelId || '',
      name: editForm.name || webProviderDefaults?.defaultModelName || '',
      provider: editForm.provider,
      routingMode: 'direct',
      description: editForm.description,
      api: editForm.api || undefined,
      apiKey: editForm.provider === 'local' ? undefined : editForm.apiKey || undefined,
      baseUrl: editForm.provider === 'local' ? '' : editForm.baseUrl,
      supportsTools: editForm.supportsTools,
      supportsReasoning: editForm.supportsReasoning,
      toolTimeoutSeconds: editForm.toolTimeoutSeconds
        ? Math.max(Number(editForm.toolTimeoutSeconds), 10)
        : undefined,
      contextWindow: editForm.contextWindow
        ? Math.max(Number(editForm.contextWindow), 1024)
        : undefined,
      azureApiVersion:
        editForm.provider === 'azure' && editForm.azureApiVersion
          ? editForm.azureApiVersion.trim()
          : undefined,
      webProviderId:
        editForm.provider === 'web' && editForm.webProviderId ? editForm.webProviderId : undefined,
    };

    const updated = editForm.id
      ? models.map(m => (m.id === editForm.id ? model : m))
      : [...models, model];

    await customModelsStorage.set(updated);
    setModels(updated);
    setDialogOpen(false);
  }, [editForm, models, webAuthStatus]);

  const handleDelete = useCallback(
    async (id: string) => {
      const updated = models.filter(m => m.id !== id);
      await customModelsStorage.set(updated);
      setModels(updated);
    },
    [models],
  );

  const handleTestConnection = useCallback(async () => {
    setTestResult('loading');
    setFormError('');
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TEST_CONNECTION',
        modelConfig: {
          id: editForm.id || 'test',
          name: editForm.name,
          provider: editForm.provider,
          modelId: editForm.modelId,
          apiKey: editForm.apiKey,
          baseUrl: editForm.baseUrl,
          api: editForm.api,
          webProviderId: editForm.webProviderId,
        },
      });
      if (response?.error) {
        setTestResult('error');
        setFormError(response.error);
      } else {
        setTestResult('success');
      }
    } catch (err) {
      setTestResult('error');
      setFormError(err instanceof Error ? err.message : t('model_connectionFailed'));
    }
  }, [editForm, t]);

  // Ref to track the active download listener for cleanup on unmount/re-download
  const downloadListenerRef = useRef<((msg: Record<string, unknown>) => void) | null>(null);

  // Cleanup download listener on unmount
  useEffect(
    () => () => {
      if (downloadListenerRef.current) {
        chrome.runtime.onMessage.removeListener(downloadListenerRef.current);
        downloadListenerRef.current = null;
      }
    },
    [],
  );

  const handleDownloadLocalModel = useCallback(
    async (modelId: string) => {
      // Remove any previous download listener before starting a new download
      if (downloadListenerRef.current) {
        chrome.runtime.onMessage.removeListener(downloadListenerRef.current);
        downloadListenerRef.current = null;
      }

      const downloadId = crypto.randomUUID();
      setDownloadProgress({ downloadId, status: 'downloading', percent: 0 });

      const listener = (message: Record<string, unknown>) => {
        if (message.downloadId !== downloadId) return;
        if (message.type === 'LOCAL_LLM_DOWNLOAD_PROGRESS') {
          const status = message.status as string;
          const percent = (message.percent as number) ?? 0;
          if (status === 'complete') {
            setDownloadProgress({ downloadId, status: 'complete', percent: 100 });
            chrome.runtime.onMessage.removeListener(listener);
            downloadListenerRef.current = null;
            refreshCachedLocalModels();
          } else if (status === 'error') {
            setDownloadProgress({
              downloadId,
              status: 'error',
              percent: 0,
              error: message.error as string,
            });
            chrome.runtime.onMessage.removeListener(listener);
            downloadListenerRef.current = null;
          } else {
            setDownloadProgress({ downloadId, status: 'downloading', percent });
          }
        }
      };
      downloadListenerRef.current = listener;
      chrome.runtime.onMessage.addListener(listener);

      await chrome.runtime.sendMessage({
        type: 'LOCAL_LLM_DOWNLOAD_MODEL',
        modelId,
        downloadId,
      });
    },
    [refreshCachedLocalModels],
  );

  const handleDeleteCachedModel = useCallback(
    async (modelId: string) => {
      await deleteCachedLocalModel(modelId);
      await refreshCachedLocalModels();
    },
    [refreshCachedLocalModels],
  );

  // Relay web auth errors to the form error state
  useEffect(() => {
    if (webAuthError) setFormError(webAuthError);
  }, [webAuthError]);

  const isLocal = editForm.provider === 'local';
  const isCodex = editForm.provider === 'openai-codex';
  const isWeb = editForm.provider === 'web';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BrainCircuitIcon className="size-5" />
          {t('model_title')}
        </CardTitle>
        <CardDescription>{t('model_description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">{t('model_customModels')}</h3>
            <Button onClick={handleOpenAdd} size="sm" variant="outline">
              <PlusIcon className="mr-1 size-4" />
              {t('model_addModel')}
            </Button>
          </div>

          {models.length === 0 && (
            <p className="text-muted-foreground py-4 text-center text-sm">{t('model_noModels')}</p>
          )}

          <div className="divide-y rounded-md border">
            {models.map(model => {
              const cached =
                model.provider === 'local' ? cachedLocalModels.get(model.modelId) : null;
              return (
                <div className="flex items-center gap-3 px-3 py-2.5" key={model.id}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{model.name}</span>
                      {(model.supportsTools || model.supportsReasoning || model.apiKey) && (
                        <div className="flex gap-1.5">
                          {model.supportsTools && (
                            <WrenchIcon className="text-muted-foreground size-3" />
                          )}
                          {model.supportsReasoning && (
                            <BrainCircuitIcon className="text-muted-foreground size-3" />
                          )}
                          {model.apiKey && (
                            <KeyRoundIcon className="text-muted-foreground size-3" />
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-muted-foreground truncate text-xs">
                        {model.modelId || model.provider}
                      </p>
                      {model.provider === 'local' &&
                        (cached ? (
                          <Badge className="text-[10px]" variant="secondary">
                            {t('model_downloaded')} ({formatBytes(cached.sizeBytes)})
                          </Badge>
                        ) : (
                          <Badge className="text-[10px]" variant="outline">
                            {t('model_notDownloaded')}
                          </Badge>
                        ))}
                    </div>
                  </div>
                  <Badge className="shrink-0" variant="outline">
                    {model.provider}
                  </Badge>
                  <div className="flex shrink-0 gap-1">
                    {model.provider === 'local' && !cached && (
                      <Button
                        onClick={() => handleDownloadLocalModel(model.modelId)}
                        size="icon-sm"
                        title={t('model_downloadModel')}
                        variant="ghost">
                        <DownloadIcon className="size-4" />
                      </Button>
                    )}
                    {model.provider === 'local' && cached && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="icon-sm"
                            title={t('model_deleteCachedModel')}
                            variant="ghost">
                            <Trash2Icon className="text-muted-foreground size-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t('model_deleteCache')}</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will remove the downloaded model files (
                              {formatBytes(cached.sizeBytes)}) from the browser cache. You can
                              re-download it later.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('common_cancel')}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDeleteCachedModel(model.modelId)}>
                              {t('common_delete')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                    <Button onClick={() => handleOpenEdit(model)} size="icon-sm" variant="ghost">
                      <PencilIcon className="size-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="icon-sm" variant="ghost">
                          <Trash2Icon className="size-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t('model_deleteModel')}</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will remove &quot;{model.name}&quot; from your custom models.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('common_cancel')}</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleDelete(model.id)}>
                            {t('common_delete')}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <Dialog onOpenChange={open => { if (!webLoginLoading) setDialogOpen(open); }} open={dialogOpen}>
          <DialogContent
              onInteractOutside={e => { if (webLoginLoading) e.preventDefault(); }}
              onFocusOutside={e => { if (webLoginLoading) e.preventDefault(); }}
              className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{editForm.id ? t('model_editModel') : t('model_addModel')}</DialogTitle>
              <DialogDescription>
                {isLocal ? t('model_localDescription') : t('model_remoteDescription')}
              </DialogDescription>
            </DialogHeader>

            {formError && (
              <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
                {formError}
              </div>
            )}

            <div className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="model-provider">{t('firstRun_provider')}</Label>
                <Select
                  onValueChange={v => handleFormChange('provider', v)}
                  value={editForm.provider}>
                  <SelectTrigger id="model-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map(p => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.value === 'web'
                          ? t('provider_web')
                          : p.value === 'custom'
                            ? t('provider_openaiCompatible')
                            : p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {isWeb && (
                <div className="grid gap-2">
                  <Label htmlFor="web-provider-id">
                    {t('firstRun_webProvider')}
                    <span className="text-muted-foreground ml-1 font-normal">{t('firstRun_webProviderHint')}</span>
                  </Label>
                  <Select
                    onValueChange={v => handleFormChange('webProviderId', v)}
                    value={editForm.webProviderId ?? ''}>
                    <SelectTrigger id="web-provider-id">
                      <SelectValue placeholder={t('firstRun_selectWebProvider')} />
                    </SelectTrigger>
                    <SelectContent>
                      {WEB_PROVIDER_OPTIONS.map(wp => (
                        <SelectItem key={wp.value} value={wp.value}>
                          {wp.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-2 pt-1">
                    {webAuthStatus === 'checking' && (
                      <Badge variant="outline" className="gap-1">
                        <Loader2Icon className="size-3 animate-spin" />
                        {t('firstRun_webChecking')}
                      </Badge>
                    )}
                    {webAuthStatus === 'logged-in' && (
                      <Badge variant="outline" className="gap-1 border-green-500 text-green-600">
                        <CheckCircleIcon className="size-3" />
                        {t('firstRun_webLoggedIn')}
                      </Badge>
                    )}
                    {(webAuthStatus === 'not-logged-in' || webAuthStatus === 'unknown') && (
                      <Badge variant="outline" className="gap-1 border-orange-500 text-orange-600">
                        <XCircleIcon className="size-3" />
                        {t('firstRun_webNotLoggedIn')}
                      </Badge>
                    )}
                    {webAuthStatus === 'logged-in' ? (
                      <Button onClick={handleWebLogout} size="sm" variant="outline">
                        <LogOutIcon className="mr-1 size-3" />
                        {t('firstRun_webLogout')}
                      </Button>
                    ) : (
                      <Button
                        disabled={webLoginLoading || !editForm.webProviderId}
                        onClick={handleWebLogin}
                        size="sm"
                        variant="outline">
                        {webLoginLoading ? (
                          <Loader2Icon className="mr-1 size-3 animate-spin" />
                        ) : (
                          <LogInIcon className="mr-1 size-3" />
                        )}
                        {webLoginLoading ? t('firstRun_webWaiting') : t('firstRun_webLogin')}
                      </Button>
                    )}
                  </div>
                  {webLoginLoading && (
                    <p className="text-muted-foreground text-xs">
                      {t('firstRun_webLoginInstruction')}
                    </p>
                  )}
                </div>
              )}

              <div className="grid gap-2">
                <Label htmlFor="model-name">{t('model_name')}</Label>
                <Input
                  id="model-name"
                  onChange={e => handleFormChange('name', e.target.value)}
                  placeholder={isLocal ? 'Qwen3 0.6B (Local)' : 'GPT-4o'}
                  value={editForm.name}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="model-id">
                  {isLocal ? t('model_huggingFaceModelId') : t('firstRun_modelId')}
                  {isWeb && <span className="text-muted-foreground ml-1 font-normal">{t('firstRun_optional')}</span>}
                </Label>
                <Input
                  id="model-id"
                  onChange={e => handleFormChange('modelId', e.target.value)}
                  placeholder={
                    isLocal
                      ? 'HuggingFaceTB/SmolLM2-360M-Instruct'
                      : isWeb
                        ? WEB_PROVIDER_OPTIONS.find(w => w.value === editForm.webProviderId)?.defaultModelId ?? t('firstRun_autoDetected')
                        : 'gpt-4o'
                  }
                  value={editForm.modelId}
                />
                <p className="text-muted-foreground text-xs">
                  {isLocal
                    ? 'The HuggingFace model ID (e.g. HuggingFaceTB/SmolLM2-360M-Instruct)'
                    : isWeb
                      ? t('firstRun_autoDetectedHint')
                      : 'The model identifier sent to the provider (e.g. gpt-4o, claude-sonnet-4-5)'}
                </p>
              </div>

              {!isLocal && !isWeb && (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="model-apikey">
                      {isCodex
                        ? 'OAuth Token'
                        : editForm.baseUrl
                          ? t('firstRun_apiKeyOptional')
                          : t('firstRun_apiKey')}
                    </Label>
                    <Input
                      id="model-apikey"
                      onChange={e => handleFormChange('apiKey', e.target.value)}
                      placeholder={isCodex ? 'ChatGPT OAuth access token' : 'sk-...'}
                      type="password"
                      value={editForm.apiKey ?? ''}
                    />
                    {isCodex && (
                      <p className="text-muted-foreground text-xs">
                        Requires a ChatGPT OAuth token (JWT). This is the access_token from a
                        ChatGPT session, not a standard OpenAI API key.
                      </p>
                    )}
                  </div>

                  {!isCodex && (
                    <div className="grid gap-2">
                      <Label htmlFor="model-baseurl">
                        {editForm.provider === 'azure' ? 'Azure Endpoint' : t('firstRun_baseUrl')}
                      </Label>
                      <Input
                        id="model-baseurl"
                        onChange={e => handleFormChange('baseUrl', e.target.value)}
                        placeholder={
                          editForm.provider === 'azure'
                            ? 'https://{resource}.openai.azure.com/openai'
                            : 'https://api.openai.com/v1'
                        }
                        type="url"
                        value={editForm.baseUrl ?? ''}
                      />
                    </div>
                  )}

                  {editForm.provider === 'azure' && (
                    <div className="grid gap-2">
                      <Label htmlFor="model-azure-api-version">API Version</Label>
                      <Input
                        id="model-azure-api-version"
                        onChange={e => handleFormChange('azureApiVersion', e.target.value)}
                        placeholder="2025-04-01-preview"
                        value={editForm.azureApiVersion ?? ''}
                      />
                      <p className="text-muted-foreground text-xs">
                        Azure OpenAI API version. Defaults to 2025-04-01-preview if empty.
                      </p>
                    </div>
                  )}

                  {['openai', 'custom', 'openrouter', 'azure'].includes(editForm.provider) && (
                    <div className="grid gap-2">
                      <Label htmlFor="model-api">{t('model_apiFormat')}</Label>
                      <Select
                        onValueChange={v => handleFormChange('api', v === 'auto' ? '' : v)}
                        value={editForm.api || 'auto'}>
                        <SelectTrigger id="model-api">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {apiOptions.map(o => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-muted-foreground text-xs">
                        Codex models (e.g. gpt-5.3-codex) require the Responses or Codex Responses
                        API format
                      </p>
                    </div>
                  )}
                </>
              )}

              <div className="grid gap-2">
                <Label htmlFor="model-description">{t('model_descriptionOptional')}</Label>
                <Input
                  id="model-description"
                  onChange={e => handleFormChange('description', e.target.value)}
                  placeholder={
                    isLocal
                      ? 'Small on-device model for private chat'
                      : 'Fast and capable general-purpose model'
                  }
                  value={editForm.description ?? ''}
                />
              </div>

              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm" htmlFor="supports-tools">
                  <input
                    checked={editForm.supportsTools ?? false}
                    className="accent-primary size-4"
                    id="supports-tools"
                    onChange={e => handleFormChange('supportsTools', e.target.checked)}
                    type="checkbox"
                  />
                  {t('model_supportsTools')}
                </label>
                <label className="flex items-center gap-2 text-sm" htmlFor="supports-reasoning">
                  <input
                    checked={editForm.supportsReasoning ?? false}
                    className="accent-primary size-4"
                    id="supports-reasoning"
                    onChange={e => handleFormChange('supportsReasoning', e.target.checked)}
                    type="checkbox"
                  />
                  {t('model_supportsReasoning')}
                </label>
              </div>

              <Collapsible className="group">
                <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-sm">
                  <ChevronDownIcon className="size-3.5 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                  {t('model_advanced')}
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-4 pt-3">
                  {!isLocal && (
                    <div className="grid gap-2">
                      <Label htmlFor="tool-timeout">{t('model_toolTimeout')}</Label>
                      <Input
                        id="tool-timeout"
                        min={10}
                        onChange={e => handleFormChange('toolTimeoutSeconds', e.target.value)}
                        placeholder="600"
                        type="number"
                        value={editForm.toolTimeoutSeconds ?? ''}
                      />
                      <p className="text-muted-foreground text-xs">{t('model_toolTimeoutHint')}</p>
                    </div>
                  )}

                  <div className="grid gap-2">
                    <Label htmlFor="context-window">{t('model_contextWindow')}</Label>
                    <Input
                      id="context-window"
                      min={1024}
                      onChange={e => handleFormChange('contextWindow', e.target.value)}
                      placeholder={t('model_contextWindowPlaceholder')}
                      type="number"
                      value={editForm.contextWindow ?? ''}
                    />
                    <p className="text-muted-foreground text-xs">{t('model_contextWindowHint')}</p>
                  </div>
                </CollapsibleContent>
              </Collapsible>

              {isLocal && downloadProgress && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span>
                      {downloadProgress.status === 'downloading'
                        ? t('model_downloading')
                        : downloadProgress.status === 'complete'
                          ? t('model_downloadComplete')
                          : t('model_downloadFailed')}
                    </span>
                    {downloadProgress.status === 'downloading' && (
                      <span className="text-muted-foreground">{downloadProgress.percent}%</span>
                    )}
                  </div>
                  <div className="bg-secondary h-2 w-full overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full transition-all duration-300"
                      style={{ width: `${downloadProgress.percent}%` }}
                    />
                  </div>
                  {downloadProgress.error && (
                    <p className="text-destructive text-xs">{downloadProgress.error}</p>
                  )}
                </div>
              )}
            </div>

            <DialogFooter className="gap-2">
              {isLocal ? (
                <Button
                  disabled={downloadProgress?.status === 'downloading' || !editForm.modelId.trim()}
                  onClick={() => handleDownloadLocalModel(editForm.modelId)}
                  variant="outline">
                  {downloadProgress?.status === 'downloading' && (
                    <Loader2Icon className="mr-2 size-4 animate-spin" />
                  )}
                  {downloadProgress?.status === 'complete' && (
                    <CheckCircleIcon className="mr-2 size-4 text-green-600" />
                  )}
                  {downloadProgress?.status === 'error' && (
                    <XCircleIcon className="mr-2 size-4 text-red-600" />
                  )}
                  {!downloadProgress && <DownloadIcon className="mr-2 size-4" />}
                  {t('model_downloadModel')}
                </Button>
              ) : (
                <Button
                  disabled={testResult === 'loading'}
                  onClick={handleTestConnection}
                  variant="outline">
                  {testResult === 'loading' && <Loader2Icon className="mr-2 size-4 animate-spin" />}
                  {testResult === 'success' && (
                    <CheckCircleIcon className="mr-2 size-4 text-green-600" />
                  )}
                  {testResult === 'error' && <XCircleIcon className="mr-2 size-4 text-red-600" />}
                  {t('model_testConnection')}
                </Button>
              )}
              <Button onClick={handleSave}>{t('common_save')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
};

export { ModelConfig, validateModelForm };
