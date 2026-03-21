import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui';
import { useT } from '@extension/i18n';
import { toolRegistryMeta, parseSkillFrontmatter, WEB_PROVIDER_OPTIONS } from '@extension/shared';
import {
  customModelsStorage,
  toolConfigStorage,
  defaultWebSearchConfig,
  getDefaultAgent,
  createAgent,
  updateAgent,
  seedPredefinedWorkspaceFiles,
  copyGlobalSkillsToAgent,
  listSkillFiles,
  updateWorkspaceFile,
} from '@extension/storage';
import {
  CheckIcon,
  ChevronLeftIcon,
  KeyIcon,
  Loader2Icon,
  RocketIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SearchIcon,
  LinkIcon,
  FileTextIcon,
  MonitorIcon,
  HardDriveIcon,
  BrainIcon,
  CalendarClockIcon,
  MessagesSquareIcon,
  UsersIcon,
  WorkflowIcon,
  TelescopeIcon,
  CodeIcon,
  BugIcon,
  HardDriveDownloadIcon,
  MailIcon,
  CalendarIcon,
  ZapIcon,
} from 'lucide-react';
import { IS_FIREFOX } from '@extension/env';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from '@extension/i18n';
import type { ReactNode } from 'react';

type FirstRunSetupProps = {
  onComplete: () => void;
};

const providers = [
  { value: 'web', label: 'Web (Browser Session Zero Token)', defaultModel: '', defaultBase: '' },
  { value: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o', defaultBase: '' },
  {
    value: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    defaultBase: '',
  },
  { value: 'google', label: 'Google', defaultModel: 'gemini-2.0-flash', defaultBase: '' },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'openai/gpt-4o',
    defaultBase: 'https://openrouter.ai/api/v1',
  },
  { value: 'custom', label: 'OpenAI Compatible', defaultModel: '', defaultBase: '' },
];

const TOTAL_STEPS = IS_FIREFOX ? 6 : 5;
const STEP_LABELS = IS_FIREFOX
  ? (['firstRun_stepModel', 'firstRun_stepPermissions', 'firstRun_stepChannels', 'firstRun_stepAgent', 'firstRun_stepTools', 'firstRun_stepSkills'] as const)
  : (['firstRun_stepModel', 'firstRun_stepChannels', 'firstRun_stepAgent', 'firstRun_stepTools', 'firstRun_stepSkills'] as const);

/** Groups to exclude from the onboarding tool picker (require OAuth or feature flags). */
const EXCLUDED_TOOL_GROUPS = new Set(['gmail', 'calendar', 'drive']);

const iconMap: Record<string, ReactNode> = {
  SearchIcon: <SearchIcon className="size-4" />,
  LinkIcon: <LinkIcon className="size-4" />,
  FileTextIcon: <FileTextIcon className="size-4" />,
  MonitorIcon: <MonitorIcon className="size-4" />,
  HardDriveIcon: <HardDriveIcon className="size-4" />,
  BrainIcon: <BrainIcon className="size-4" />,
  CalendarClockIcon: <CalendarClockIcon className="size-4" />,
  MessagesSquareIcon: <MessagesSquareIcon className="size-4" />,
  UsersIcon: <UsersIcon className="size-4" />,
  WorkflowIcon: <WorkflowIcon className="size-4" />,
  TelescopeIcon: <TelescopeIcon className="size-4" />,
  CodeIcon: <CodeIcon className="size-4" />,
  BugIcon: <BugIcon className="size-4" />,
  HardDriveDownloadIcon: <HardDriveDownloadIcon className="size-4" />,
  MailIcon: <MailIcon className="size-4" />,
  CalendarIcon: <CalendarIcon className="size-4" />,
};

/* ---------- ensureDefaultAgent ---------- */

const ensureDefaultAgent = async () => {
  const agent = await getDefaultAgent();
  if (!agent) {
    await createAgent({
      id: 'main',
      name: 'Main Agent',
      identity: { emoji: '\u{1F916}' },
      isDefault: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await seedPredefinedWorkspaceFiles('main');
    await copyGlobalSkillsToAgent('main');
  } else {
    const existing = await listSkillFiles(agent.id);
    if (existing.length === 0) {
      await seedPredefinedWorkspaceFiles(agent.id);
      await copyGlobalSkillsToAgent(agent.id);
    }
  }
};

/* ---------- StepIndicator ---------- */

const StepIndicator = ({ current, t }: { current: number; t: TFunction }) => (
  <div className="flex items-center justify-center gap-3 pb-2">
    {STEP_LABELS.map((labelKey, i) => {
      const stepNum = i + 1;
      const completed = stepNum < current;
      const active = stepNum === current;
      return (
        <div key={labelKey} className="flex flex-col items-center gap-1">
          <div
            className={`flex size-6 items-center justify-center rounded-full text-xs font-medium transition-colors ${
              completed
                ? 'bg-primary text-primary-foreground'
                : active
                  ? 'bg-primary text-primary-foreground'
                  : 'border-muted-foreground/40 text-muted-foreground border'
            }`}>
            {completed ? <CheckIcon className="size-3.5" /> : stepNum}
          </div>
          <span
            className={`text-[10px] ${active ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
            {t(labelKey)}
          </span>
        </div>
      );
    })}
  </div>
);

/* ---------- Step 1: Model Setup ---------- */

const Step1ModelSetup = ({ onNext, t }: { onNext: () => void; t: TFunction }) => {
  const [provider, setProvider] = useState('web');
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [supportsTools, setSupportsTools] = useState(true);
  const [supportsReasoning, setSupportsReasoning] = useState(true);
  const [webProviderId, setWebProviderId] = useState('gemini-web');

  const handleProviderChange = useCallback((value: string) => {
    setProvider(value);
    const p = providers.find(p => p.value === value);
    if (p) {
      setModelId(p.defaultModel);
      setBaseUrl(p.defaultBase);
    }
    // Auto-set default web provider when switching to web
    if (value === 'web' && !webProviderId) {
      setWebProviderId('gemini-web');
      const wp = WEB_PROVIDER_OPTIONS.find(w => w.value === 'gemini-web');
      if (wp) setModelId(wp.defaultModelId);
    }
    setError('');
  }, [webProviderId]);

  const handleNext = useCallback(async () => {
    const isWeb = provider === 'web';
    if (!isWeb && !apiKey.trim() && !baseUrl.trim()) {
      setError(t('firstRun_apiKeyRequired'));
      return;
    }
    if (isWeb && !webProviderId) {
      setError('Please select a web provider');
      return;
    }
    if (!isWeb && !modelId.trim()) {
      setError(t('firstRun_modelIdRequired'));
      return;
    }

    setSaving(true);
    setError('');

    try {
      const p = providers.find(p => p.value === provider);
      const wpMatch = WEB_PROVIDER_OPTIONS.find(w => w.value === webProviderId);
      const resolvedModelId = modelId || (isWeb ? wpMatch?.defaultModelId : undefined) || '';
      const defaultName = isWeb ? wpMatch?.defaultModelName : undefined;
      const resolvedName = p?.label
        ? `${p.label} ${resolvedModelId || defaultName || ''}`.trim()
        : resolvedModelId || defaultName || '';
      await customModelsStorage.set([
        {
          id: nanoid(),
          modelId: resolvedModelId,
          name: resolvedName,
          provider,
          routingMode: 'direct',
          apiKey: apiKey || undefined,
          baseUrl: baseUrl || undefined,
          supportsTools,
          supportsReasoning,
          ...(isWeb ? { webProviderId } : {}),
        },
      ]);
      onNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('firstRun_saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [
    apiKey,
    modelId,
    provider,
    baseUrl,
    supportsTools,
    supportsReasoning,
    webProviderId,
    onNext,
    t,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !saving) {
        handleNext();
      }
    },
    [handleNext, saving],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="text-center">
        <CardTitle className="flex items-center justify-center gap-2 text-xl">
          <RocketIcon className="size-5" />
          {t('firstRun_welcome')}
        </CardTitle>
        <CardDescription>{t('firstRun_addApiKey')}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="grid gap-2">
          <Label htmlFor="setup-provider">{t('firstRun_provider')}</Label>
          <Select onValueChange={handleProviderChange} value={provider}>
            <SelectTrigger id="setup-provider">
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

        {provider === 'web' ? (
          <div className="grid gap-2">
            <Label htmlFor="setup-web-provider">Web Provider</Label>
            <Select
              onValueChange={v => {
                setWebProviderId(v);
                const wp = WEB_PROVIDER_OPTIONS.find(w => w.value === v);
                if (wp) setModelId(wp.defaultModelId);
                setError('');
              }}
              value={webProviderId}>
              <SelectTrigger id="setup-web-provider">
                <SelectValue placeholder="Select a web provider" />
              </SelectTrigger>
              <SelectContent>
                {WEB_PROVIDER_OPTIONS.map(wp => (
                  <SelectItem key={wp.value} value={wp.value}>
                    {wp.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Uses your browser session — no API key needed. Log in to the provider website first.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-2">
              <Label htmlFor="setup-apikey">
                {baseUrl ? t('firstRun_apiKeyOptional') : t('firstRun_apiKey')}
              </Label>
              <div className="relative">
                <KeyIcon className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
                <Input
                  className="pl-9"
                  data-testid="setup-api-key"
                  id="setup-apikey"
                  onChange={e => {
                    setApiKey(e.target.value);
                    setError('');
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder="sk-..."
                  type="password"
                  value={apiKey}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="setup-baseurl">{t('firstRun_baseUrl')}</Label>
              <Input
                data-testid="setup-base-url"
                id="setup-baseurl"
                onChange={e => {
                  setBaseUrl(e.target.value);
                  setError('');
                }}
                onKeyDown={handleKeyDown}
                placeholder="https://api.example.com/v1"
                type="url"
                value={baseUrl}
              />
              <p className="text-muted-foreground text-xs">{t('firstRun_baseUrlHint')}</p>
            </div>
          </>
        )}

        <div className="grid gap-2">
          <Label htmlFor="setup-model">
            {t('firstRun_modelId')}
            {provider === 'web' && <span className="text-muted-foreground ml-1 font-normal">(optional)</span>}
          </Label>
          <Input
            data-testid="setup-model-id"
            id="setup-model"
            onChange={e => {
              setModelId(e.target.value);
              setError('');
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              provider === 'web'
                ? WEB_PROVIDER_OPTIONS.find(w => w.value === webProviderId)?.defaultModelId ?? 'Auto-detected'
                : 'gpt-4o'
            }
            value={modelId}
          />
          {provider === 'web' && (
            <p className="text-muted-foreground text-xs">
              Auto-detected from web provider. Override only if needed.
            </p>
          )}
        </div>

        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm" htmlFor="setup-supports-tools">
            <input
              checked={supportsTools}
              className="accent-primary size-4"
              id="setup-supports-tools"
              onChange={e => setSupportsTools(e.target.checked)}
              type="checkbox"
            />
            {t('model_supportsTools')}
          </label>
          <label className="flex items-center gap-2 text-sm" htmlFor="setup-supports-reasoning">
            <input
              checked={supportsReasoning}
              className="accent-primary size-4"
              id="setup-supports-reasoning"
              onChange={e => setSupportsReasoning(e.target.checked)}
              type="checkbox"
            />
            {t('model_supportsReasoning')}
          </label>
        </div>

        <Button
          className="mt-auto w-full"
          data-testid="setup-start-button"
          disabled={saving}
          onClick={handleNext}>
          {saving && <Loader2Icon className="mr-2 size-4 animate-spin" />}
          {t('firstRun_next')}
        </Button>
      </CardContent>
    </div>
  );
};

/* ---------- Firefox Permissions Step ---------- */

const StepFirefoxPermissions = ({
  onNext,
  onBack,
  t,
}: {
  onNext: () => void;
  onBack: () => void;
  t: TFunction;
}) => {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [denied, setDenied] = useState(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    chrome.permissions
      .contains({ origins: ['<all_urls>'] })
      .then(has => setGranted(has))
      .catch(() => setGranted(false));
  }, []);

  const handleGrant = useCallback(async () => {
    setRequesting(true);
    setDenied(false);
    try {
      const result = await chrome.permissions.request({ origins: ['<all_urls>'] });
      setGranted(result);
      if (!result) setDenied(true);
    } catch {
      setDenied(true);
    } finally {
      setRequesting(false);
    }
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="text-center">
        <CardTitle className="flex items-center justify-center gap-2 text-xl">
          <ShieldCheckIcon className="size-5" />
          {t('firstRun_permissionsTitle')}
        </CardTitle>
        <CardDescription>{t('firstRun_permissionsDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        {granted === null ? (
          <div className="flex items-center justify-center py-6">
            <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : granted ? (
          <div className="flex items-center gap-2 rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-600 dark:text-green-400">
            <CheckIcon className="size-4" />
            {t('firstRun_permissionsGranted')}
          </div>
        ) : (
          <>
            <Button
              className="w-full"
              disabled={requesting}
              onClick={handleGrant}>
              {requesting && <Loader2Icon className="mr-2 size-4 animate-spin" />}
              <ShieldCheckIcon className="mr-2 size-4" />
              {t('firstRun_permissionsGrant')}
            </Button>
            {denied && (
              <p className="text-sm text-yellow-600 dark:text-yellow-400">
                {t('firstRun_permissionsDenied')}
              </p>
            )}
          </>
        )}

        <div className="mt-auto flex items-center justify-between">
          <Button
            data-testid="setup-back-button"
            onClick={onBack}
            variant="link">
            <ChevronLeftIcon className="mr-1 size-4" />
            {t('firstRun_back')}
          </Button>
          <Button
            data-testid="setup-next-button"
            onClick={onNext}>
            {t('firstRun_next')}
          </Button>
        </div>
      </CardContent>
    </div>
  );
};

/* ---------- Step 2: Channel Setup ---------- */

const Step2ChannelSetup = ({
  onNext,
  onBack,
  t,
}: {
  onNext: () => void;
  onBack: () => void;
  t: TFunction;
}) => {
  const [botToken, setBotToken] = useState('');
  const [allowedUsers, setAllowedUsers] = useState('');
  const [validating, setValidating] = useState(false);
  const [validated, setValidated] = useState(false);
  const [botUsername, setBotUsername] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [enableChannel, setEnableChannel] = useState(true);

  const handleValidate = useCallback(async () => {
    if (!botToken.trim()) return;
    setValidating(true);
    setError('');
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'CHANNEL_VALIDATE_AUTH',
        channelId: 'telegram',
        credentials: { botToken: botToken.trim() },
      })) as { valid: boolean; identity?: string; error?: string };

      if (response.valid) {
        setValidated(true);
        setBotUsername(response.identity ?? '');
      } else {
        setError(response.error ?? t('telegram_invalidToken'));
      }
    } catch {
      setError(t('telegram_validationFailed'));
    } finally {
      setValidating(false);
    }
  }, [botToken, t]);

  const handleNext = useCallback(async () => {
    if (!botToken.trim()) {
      onNext();
      return;
    }
    setSaving(true);
    setError('');
    try {
      const userIds = allowedUsers
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      await chrome.runtime.sendMessage({
        type: 'CHANNEL_SAVE_CONFIG',
        channelId: 'telegram',
        config: {
          credentials: { botToken: botToken.trim(), botUsername: botUsername.replace('@', '') },
          allowedSenderIds: userIds,
        },
      });
      if (enableChannel) {
        await chrome.runtime.sendMessage({
          type: 'CHANNEL_TOGGLE',
          channelId: 'telegram',
          enabled: true,
        });
      }
      onNext();
    } catch {
      setError(t('telegram_saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [botToken, allowedUsers, botUsername, enableChannel, onNext, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{t('firstRun_step2Title')}</CardTitle>
        <CardDescription>{t('firstRun_step2Description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="grid gap-2">
          <Label htmlFor="setup-bot-token">{t('firstRun_telegramBotToken')}</Label>
          <div className="flex gap-2">
            <Input
              className="flex-1"
              data-testid="setup-bot-token"
              id="setup-bot-token"
              onChange={e => {
                setBotToken(e.target.value);
                setValidated(false);
                setError('');
              }}
              placeholder="123456:ABC-DEF..."
              type="password"
              value={botToken}
            />
            <Button
              disabled={!botToken.trim() || validating}
              onClick={handleValidate}
              size="sm"
              variant="outline">
              {validating && <Loader2Icon className="mr-1 size-3.5 animate-spin" />}
              {t('firstRun_telegramValidate')}
            </Button>
          </div>
          {validated && botUsername && (
            <p className="text-sm text-green-600 dark:text-green-400">
              {t('firstRun_telegramValidated')}: {botUsername}
            </p>
          )}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="setup-allowed-users">{t('firstRun_telegramAllowedUsers')}</Label>
          <Input
            data-testid="setup-allowed-users"
            id="setup-allowed-users"
            onChange={e => setAllowedUsers(e.target.value)}
            placeholder="123456789, 987654321"
            value={allowedUsers}
          />
        </div>

        <label className="flex items-center gap-2 text-sm" htmlFor="setup-enable-channel">
          <input
            checked={enableChannel}
            className="accent-primary size-4"
            disabled={!validated || !allowedUsers.trim()}
            id="setup-enable-channel"
            onChange={e => setEnableChannel(e.target.checked)}
            type="checkbox"
          />
          {t('telegram_enableBot')}
        </label>

        <p className="text-muted-foreground text-xs">{t('firstRun_whatsappNote')}</p>

        <div className="mt-auto flex items-center justify-between">
          <Button data-testid="setup-back-button" onClick={onBack} variant="link">
            <ChevronLeftIcon className="mr-1 size-4" />
            {t('firstRun_back')}
          </Button>
          <Button data-testid="setup-next-button" disabled={saving} onClick={handleNext}>
            {saving && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {t('firstRun_next')}
          </Button>
        </div>
      </CardContent>
    </div>
  );
};

/* ---------- Step 3: Agent Setup ---------- */

const Step3AgentSetup = ({
  onNext,
  onBack,
  t,
}: {
  onNext: () => void;
  onBack: () => void;
  t: TFunction;
}) => {
  const [agentName, setAgentName] = useState('Main Agent');
  const [agentEmoji, setAgentEmoji] = useState('\u{1F916}');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleNext = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      let agent = await getDefaultAgent();
      if (!agent) {
        agent = {
          id: 'main',
          name: agentName.trim() || 'Main Agent',
          identity: { emoji: agentEmoji || '\u{1F916}' },
          isDefault: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await createAgent(agent);
        await seedPredefinedWorkspaceFiles('main');
        await copyGlobalSkillsToAgent('main');
      } else {
        await updateAgent(agent.id, {
          name: agentName.trim() || agent.name,
          identity: { ...agent.identity, emoji: agentEmoji || agent.identity.emoji },
        });
      }
      onNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('firstRun_saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [agentName, agentEmoji, onNext, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{t('firstRun_step3Title')}</CardTitle>
        <CardDescription>{t('firstRun_step3Description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="grid gap-2">
          <Label htmlFor="setup-agent-name">{t('firstRun_agentName')}</Label>
          <Input
            data-testid="setup-agent-name"
            id="setup-agent-name"
            onChange={e => setAgentName(e.target.value)}
            placeholder="Main Agent"
            value={agentName}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="setup-agent-emoji">{t('firstRun_agentEmoji')}</Label>
          <Input
            className="w-20 text-center text-xl"
            data-testid="setup-agent-emoji"
            id="setup-agent-emoji"
            maxLength={2}
            onChange={e => setAgentEmoji(e.target.value)}
            value={agentEmoji}
          />
        </div>

        <div className="mt-auto flex items-center justify-between">
          <Button data-testid="setup-back-button" onClick={onBack} variant="link">
            <ChevronLeftIcon className="mr-1 size-4" />
            {t('firstRun_back')}
          </Button>
          <Button data-testid="setup-next-button" disabled={saving} onClick={handleNext}>
            {saving && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {t('firstRun_next')}
          </Button>
        </div>
      </CardContent>
    </div>
  );
};

/* ---------- Step 4: Tools Setup ---------- */

const Step4ToolsSetup = ({
  onNext,
  onBack,
  t,
}: {
  onNext: () => void;
  onBack: () => void;
  t: TFunction;
}) => {
  const groups = useMemo(
    () => toolRegistryMeta.filter(g => !EXCLUDED_TOOL_GROUPS.has(g.groupKey)),
    [],
  );

  const [enabledTools, setEnabledTools] = useState<Record<string, boolean>>(() => {
    const defaults: Record<string, boolean> = {};
    for (const group of groups) {
      for (const tool of group.tools) {
        defaults[tool.name] = tool.defaultEnabled;
      }
    }
    return defaults;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleGroup = useCallback((groupTools: readonly { name: string }[], enabled: boolean) => {
    setEnabledTools(prev => {
      const next = { ...prev };
      for (const tool of groupTools) {
        next[tool.name] = enabled;
      }
      return next;
    });
  }, []);

  const handleNext = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      await toolConfigStorage.set({
        enabledTools,
        webSearchConfig: defaultWebSearchConfig,
      });
      onNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('firstRun_saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [enabledTools, onNext, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{t('firstRun_step4Title')}</CardTitle>
        <CardDescription>{t('firstRun_step4Description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="max-h-[300px] space-y-1 overflow-y-auto pr-1">
          {groups.map(group => {
            const allEnabled = group.tools.every(t => enabledTools[t.name]);
            return (
              <label
                key={group.groupKey}
                className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 rounded-md px-2 py-2">
                <input
                  checked={allEnabled}
                  className="accent-primary size-4"
                  onChange={e => toggleGroup(group.tools, e.target.checked)}
                  type="checkbox"
                />
                <span className="text-muted-foreground">{iconMap[group.iconName]}</span>
                <span className="text-sm font-medium">{group.label}</span>
                {group.tools.length > 1 && (
                  <span className="text-muted-foreground text-xs">
                    ({group.tools.length} tools)
                  </span>
                )}
              </label>
            );
          })}
        </div>

        <div className="mt-auto flex items-center justify-between">
          <Button data-testid="setup-back-button" onClick={onBack} variant="link">
            <ChevronLeftIcon className="mr-1 size-4" />
            {t('firstRun_back')}
          </Button>
          <Button data-testid="setup-next-button" disabled={saving} onClick={handleNext}>
            {saving && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {t('firstRun_next')}
          </Button>
        </div>
      </CardContent>
    </div>
  );
};

/* ---------- Step 5: Skills Setup ---------- */

interface SkillEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

const Step5SkillsSetup = ({
  onComplete,
  onBack,
  t,
}: {
  onComplete: () => void;
  onBack: () => void;
  t: TFunction;
}) => {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        await ensureDefaultAgent();

        const files = await listSkillFiles('main');
        const entries: SkillEntry[] = [];
        for (const file of files) {
          const meta = parseSkillFrontmatter(file.content);
          if (meta) {
            entries.push({
              id: file.id,
              name: meta.name,
              description: meta.description,
              enabled: file.enabled ?? false,
            });
          }
        }
        setSkills(entries);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('firstRun_saveFailed'));
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [t]);

  const toggleSkill = useCallback((id: string, enabled: boolean) => {
    setSkills(prev => prev.map(s => (s.id === id ? { ...s, enabled } : s)));
  }, []);

  const handleGetStarted = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      await Promise.all(skills.map(s => updateWorkspaceFile(s.id, { enabled: s.enabled })));
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('firstRun_saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [skills, onComplete, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{t('firstRun_step5Title')}</CardTitle>
        <CardDescription>{t('firstRun_step5Description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : skills.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">{t('firstRun_noSkills')}</p>
        ) : (
          <div className="space-y-1">
            {skills.map(skill => (
              <label
                key={skill.id}
                className="hover:bg-muted/50 flex cursor-pointer items-start gap-3 rounded-md px-2 py-2">
                <input
                  checked={skill.enabled}
                  className="accent-primary mt-0.5 size-4"
                  onChange={e => toggleSkill(skill.id, e.target.checked)}
                  type="checkbox"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <ZapIcon className="text-muted-foreground size-3.5" />
                    <span className="text-sm font-medium">{skill.name}</span>
                  </div>
                  <p className="text-muted-foreground text-xs leading-snug">{skill.description}</p>
                </div>
              </label>
            ))}
          </div>
        )}

        <div className="mt-auto flex items-center justify-between">
          <Button data-testid="setup-back-button" onClick={onBack} variant="link">
            <ChevronLeftIcon className="mr-1 size-4" />
            {t('firstRun_back')}
          </Button>
          <Button
            data-testid="setup-get-started-button"
            disabled={saving || loading}
            onClick={handleGetStarted}>
            {saving && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {t('firstRun_getStarted')}
          </Button>
        </div>
      </CardContent>
    </div>
  );
};

/* ---------- Main Wizard ---------- */

/** Offset for step numbers, accounting for the Firefox permissions step. */
const STEP_OFFSET = IS_FIREFOX ? 1 : 0;

const FirstRunSetup = ({ onComplete }: FirstRunSetupProps) => {
  const t = useT();
  const [step, setStep] = useState(1);
  const offset = STEP_OFFSET;

  const handleSkipSetup = useCallback(async () => {
    await ensureDefaultAgent();
    onComplete();
  }, [onComplete]);

  return (
    <div className="bg-background flex h-dvh items-center justify-center p-4">
      <Card className="flex h-[640px] w-full max-w-md flex-col">
        <div className="px-6 pt-6">
          <StepIndicator current={step} t={t} />
        </div>

        <div key={step} className="animate-in fade-in flex flex-1 flex-col duration-200">
          {step === 1 && <Step1ModelSetup onNext={() => setStep(2)} t={t} />}
          {IS_FIREFOX && step === 2 && (
            <StepFirefoxPermissions onBack={() => setStep(1)} onNext={() => setStep(3)} t={t} />
          )}
          {step === 2 + offset && (
            <Step2ChannelSetup onBack={() => setStep(1 + offset)} onNext={() => setStep(3 + offset)} t={t} />
          )}
          {step === 3 + offset && (
            <Step3AgentSetup onBack={() => setStep(2 + offset)} onNext={() => setStep(4 + offset)} t={t} />
          )}
          {step === 4 + offset && (
            <Step4ToolsSetup onBack={() => setStep(3 + offset)} onNext={() => setStep(5 + offset)} t={t} />
          )}
          {step === 5 + offset && <Step5SkillsSetup onBack={() => setStep(4 + offset)} onComplete={onComplete} t={t} />}
        </div>

        <div className="flex items-center justify-between px-6 pb-6 pt-2">
          <button
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
            onClick={() => chrome.runtime.openOptionsPage()}
            type="button">
            <SettingsIcon className="size-3" />
            {t('firstRun_advancedSetup')}
          </button>
          {step > 1 && (
            <button
              className="text-muted-foreground hover:text-foreground text-xs"
              data-testid="setup-skip-setup"
              onClick={handleSkipSetup}
              type="button">
              {t('firstRun_skipSetup')}
            </button>
          )}
        </div>
      </Card>
    </div>
  );
};

export { FirstRunSetup };
export type { FirstRunSetupProps };
