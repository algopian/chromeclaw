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
import { WebAuthRow } from './web-auth-row';
import { IS_FIREFOX } from '@extension/env';
import { useT } from '@extension/i18n';
import {
  toolRegistryMeta,
  parseSkillFrontmatter,
  WEB_PROVIDER_OPTIONS,
  useWebProviderAuth,
  useWebAuth,
  parseAgentBackup,
  PROVIDER_DEFAULT_BASE_URLS,
} from '@extension/shared';
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
  deleteWorkspaceFile,
  createWorkspaceFile,
  listWorkspaceFiles,
  sttConfigStorage,
  defaultSttConfig,
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
  HardDriveUploadIcon,
  MailIcon,
  CalendarIcon,
  ZapIcon,
  MicIcon,
} from 'lucide-react';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from '@extension/i18n';
import type { WebAuthDefinition } from '@extension/shared';
import type { DbWorkspaceFile, SttConfig } from '@extension/storage';
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
    defaultModel: 'claude-sonnet-4-5',
    defaultBase: '',
  },
  { value: 'google', label: 'Google', defaultModel: 'gemini-2.0-flash', defaultBase: '' },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'openai/gpt-4o',
    defaultBase: PROVIDER_DEFAULT_BASE_URLS.openrouter,
  },
  {
    value: 'requesty',
    label: 'Requesty',
    defaultModel: 'openai/gpt-4o-mini',
    defaultBase: PROVIDER_DEFAULT_BASE_URLS.requesty,
  },
  { value: 'custom', label: 'OpenAI Compatible', defaultModel: '', defaultBase: '' },
];

const TOTAL_STEPS = IS_FIREFOX ? 7 : 6;
const STEP_LABELS = IS_FIREFOX
  ? ([
      'firstRun_stepModel',
      'firstRun_stepPermissions',
      'firstRun_stepAgent',
      'firstRun_stepChannels',
      'firstRun_stepTools',
      'firstRun_stepSkills',
      'firstRun_stepSpeech',
    ] as const)
  : ([
      'firstRun_stepModel',
      'firstRun_stepAgent',
      'firstRun_stepChannels',
      'firstRun_stepTools',
      'firstRun_stepSkills',
      'firstRun_stepSpeech',
    ] as const);

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

  const {
    status: webAuthStatus,
    loginLoading: webLoginLoading,
    error: webAuthError,
    login: handleWebLogin,
    logout: handleWebLogout,
  } = useWebProviderAuth({ provider, webProviderId });

  // Relay web auth errors to the existing error state
  useEffect(() => {
    if (webAuthError) setError(webAuthError);
  }, [webAuthError]);

  const handleProviderChange = useCallback(
    (value: string) => {
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
    },
    [webProviderId],
  );

  const handleNext = useCallback(async () => {
    const isWeb = provider === 'web';
    if (!isWeb && !apiKey.trim() && !baseUrl.trim()) {
      setError(t('firstRun_apiKeyRequired'));
      return;
    }
    if (isWeb && !webProviderId) {
      setError(t('firstRun_webProviderRequired'));
      return;
    }
    if (isWeb && webAuthStatus !== 'logged-in') {
      setError(t('firstRun_webLoginRequired'));
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
      const displayLabel = isWeb && webProviderId ? webProviderId : p?.label;
      const resolvedName = displayLabel
        ? `${displayLabel} / ${resolvedModelId || defaultName || ''}`.trim()
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
    webAuthStatus,
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
            <Label htmlFor="setup-web-provider">
              {t('firstRun_webProvider')}
              <span className="text-muted-foreground ml-1 font-normal">
                {t('firstRun_webProviderHint')}
              </span>
            </Label>
            <Select
              onValueChange={v => {
                setWebProviderId(v);
                const wp = WEB_PROVIDER_OPTIONS.find(w => w.value === v);
                if (wp) setModelId(wp.defaultModelId);
                setError('');
              }}
              value={webProviderId}>
              <SelectTrigger id="setup-web-provider">
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
            <WebAuthRow
              className="grid gap-2"
              status={webAuthStatus === 'unknown' ? 'not-logged-in' : webAuthStatus}
              loginLoading={webLoginLoading}
              loginDisabled={!webProviderId}
              error={null}
              login={handleWebLogin}
              logout={handleWebLogout}
              labels={{
                checking: t('firstRun_webChecking'),
                loggedIn: t('firstRun_webLoggedIn'),
                expired: t('firstRun_webNotLoggedIn'),
                notLoggedIn: t('firstRun_webNotLoggedIn'),
                login: t('firstRun_webLogin'),
                signingIn: t('firstRun_webWaiting'),
                logout: t('firstRun_webLogout'),
              }}
            />
            {webLoginLoading && (
              <p className="text-muted-foreground text-xs">{t('firstRun_webLoginInstruction')}</p>
            )}
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
            {provider === 'web' && (
              <span className="text-muted-foreground ml-1 font-normal">
                {t('firstRun_optional')}
              </span>
            )}
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
                ? (WEB_PROVIDER_OPTIONS.find(w => w.value === webProviderId)?.defaultModelId ??
                  t('firstRun_autoDetected'))
                : 'gpt-4o'
            }
            value={modelId}
          />
          {provider === 'web' && (
            <p className="text-muted-foreground text-xs">{t('firstRun_autoDetectedHint')}</p>
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
            <Button className="w-full" disabled={requesting} onClick={handleGrant}>
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
          <Button data-testid="setup-back-button" onClick={onBack} variant="link">
            <ChevronLeftIcon className="mr-1 size-4" />
            {t('firstRun_back')}
          </Button>
          <Button data-testid="setup-next-button" onClick={onNext}>
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

const AGENT_TEMPLATES = [
  { id: 'claw', name: 'Claw', emoji: '\u{1F99E}', keyPrefix: 'agent_tpl_claw' },
  { id: 'sage', name: 'Sage', emoji: '\u{1F9ED}', keyPrefix: 'agent_tpl_sage' },
  { id: 'slate', name: 'Slate', emoji: '\u25FC\uFE0F', keyPrefix: 'agent_tpl_slate' },
] as const;

const Step3AgentSetup = ({
  onNext,
  onBack,
  t,
}: {
  onNext: () => void;
  onBack: () => void;
  t: TFunction;
}) => {
  const tplKey = (prefix: string, field: string) =>
    t(`${prefix}_${field}` as Parameters<typeof t>[0]);

  const [selectedTemplate, setSelectedTemplate] = useState<string>(AGENT_TEMPLATES[0].id);
  const [agentName, setAgentName] = useState<string>(AGENT_TEMPLATES[0].name);
  const [agentEmoji, setAgentEmoji] = useState<string>(AGENT_TEMPLATES[0].emoji);
  const [creature, setCreature] = useState<string>(
    tplKey(AGENT_TEMPLATES[0].keyPrefix, 'creature'),
  );
  const [vibe, setVibe] = useState<string>(tplKey(AGENT_TEMPLATES[0].keyPrefix, 'vibe'));
  const [strengths, setStrengths] = useState<string>(
    tplKey(AGENT_TEMPLATES[0].keyPrefix, 'strengths'),
  );
  const [boundaries, setBoundaries] = useState<string>(
    tplKey(AGENT_TEMPLATES[0].keyPrefix, 'boundaries'),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const restoreInputRef = useRef<HTMLInputElement>(null);

  const selectTemplate = useCallback(
    (tpl: (typeof AGENT_TEMPLATES)[number]) => {
      setSelectedTemplate(tpl.id);
      setAgentName(tpl.name);
      setAgentEmoji(tpl.emoji);
      setCreature(tplKey(tpl.keyPrefix, 'creature'));
      setVibe(tplKey(tpl.keyPrefix, 'vibe'));
      setStrengths(tplKey(tpl.keyPrefix, 'strengths'));
      setBoundaries(tplKey(tpl.keyPrefix, 'boundaries'));
    },
    [t],
  );

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

      // Write identity to IDENTITY.md workspace file using user-editable values
      const identityContent = `# IDENTITY.md - Who Am I?

- **Name:** ${agentName.trim()}
- **Creature:** ${creature}
- **Vibe:** ${vibe}
- **Emoji:** ${agentEmoji}

## Profile
- **Strengths:** ${strengths}
- **Boundaries:** ${boundaries}
`;
      const files = await listWorkspaceFiles('main');
      const identityFile = files.find(f => f.name === 'IDENTITY.md');
      if (identityFile) {
        await updateWorkspaceFile(identityFile.id, { content: identityContent });
      }

      onNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('firstRun_saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [agentName, agentEmoji, creature, vibe, strengths, boundaries, onNext, t]);

  const handleRestore = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;

      setSaving(true);
      setError('');
      try {
        const backup = await parseAgentBackup(file);

        // Ensure default agent exists
        let agent = await getDefaultAgent();
        if (!agent) {
          agent = {
            id: 'main',
            name: backup.meta.name,
            identity: backup.meta.identity ?? { emoji: '\u{1F916}' },
            isDefault: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await createAgent(agent);
          await seedPredefinedWorkspaceFiles('main');
          await copyGlobalSkillsToAgent('main');
        }

        // Update agent config from backup
        await updateAgent(agent.id, {
          name: backup.meta.name,
          identity: backup.meta.identity,
          model: backup.meta.model,
          toolConfig: backup.meta.toolConfig,
          customTools: backup.meta.customTools,
          compactionConfig: backup.meta.compactionConfig,
        });

        // Replace workspace files
        const existingFiles = await listWorkspaceFiles(agent.id);
        for (const f of existingFiles) {
          if (!f.predefined) await deleteWorkspaceFile(f.id);
        }
        const predefinedFiles = existingFiles.filter(f => f.predefined);
        for (const bf of backup.files) {
          const existing = predefinedFiles.find(f => f.name === bf.name);
          if (existing) {
            await updateWorkspaceFile(existing.id, { content: bf.content });
          } else {
            const now = Date.now();
            const wsFile: DbWorkspaceFile = {
              id: nanoid(),
              name: bf.name,
              content: bf.content,
              enabled: true,
              owner: 'user',
              predefined: false,
              createdAt: now,
              updatedAt: now,
              agentId: agent.id,
            };
            await createWorkspaceFile(wsFile);
          }
        }

        // Update form fields from backup
        setAgentName(backup.meta.name);
        setAgentEmoji(backup.meta.identity?.emoji ?? '\u{1F916}');
        // Extract fields from IDENTITY.md if present
        const identityFile = backup.files.find(f => f.name === 'IDENTITY.md');
        if (identityFile) {
          const extract = (field: string): string => {
            const regex = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, 'i');
            const match = identityFile.content.match(regex);
            return match?.[1]?.trim() ?? '';
          };
          setCreature(extract('Creature'));
          setVibe(extract('Vibe'));
          setStrengths(extract('Strengths'));
          setBoundaries(extract('Boundaries'));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('firstRun_restoreFailed'));
      } finally {
        setSaving(false);
      }
    },
    [t],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{t('firstRun_step3Title')}</CardTitle>
        <CardDescription>{t('firstRun_step3Description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="grid gap-2">
          <Label>{t('firstRun_agentTemplate')}</Label>
          <Select
            value={selectedTemplate}
            onValueChange={v => {
              const tpl = AGENT_TEMPLATES.find(tp => tp.id === v);
              if (tpl) selectTemplate(tpl);
            }}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGENT_TEMPLATES.map(tpl => (
                <SelectItem key={tpl.id} value={tpl.id}>
                  {tpl.emoji} {tpl.name} — {t(`${tpl.keyPrefix}_vibe` as Parameters<typeof t>[0])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-[1fr_80px] gap-2">
          <div className="grid gap-1">
            <Label htmlFor="setup-agent-name">{t('firstRun_agentName')}</Label>
            <Input
              data-testid="setup-agent-name"
              id="setup-agent-name"
              onChange={e => setAgentName(e.target.value)}
              placeholder={t('firstRun_defaultAgentName')}
              value={agentName}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="setup-agent-emoji">{t('firstRun_agentEmoji')}</Label>
            <Input
              className="text-center text-xl"
              data-testid="setup-agent-emoji"
              id="setup-agent-emoji"
              maxLength={2}
              onChange={e => setAgentEmoji(e.target.value)}
              value={agentEmoji}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1">
            <Label htmlFor="setup-agent-creature">{t('firstRun_agentCreature')}</Label>
            <Input
              id="setup-agent-creature"
              onChange={e => setCreature(e.target.value)}
              value={creature}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="setup-agent-vibe">{t('firstRun_agentVibe')}</Label>
            <Input id="setup-agent-vibe" onChange={e => setVibe(e.target.value)} value={vibe} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1">
            <Label htmlFor="setup-agent-strengths">{t('firstRun_agentStrengths')}</Label>
            <Input
              id="setup-agent-strengths"
              onChange={e => setStrengths(e.target.value)}
              value={strengths}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="setup-agent-boundaries">{t('firstRun_agentBoundaries')}</Label>
            <Input
              id="setup-agent-boundaries"
              onChange={e => setBoundaries(e.target.value)}
              value={boundaries}
            />
          </div>
        </div>

        <div className="mt-auto flex items-center justify-between">
          <Button data-testid="setup-back-button" onClick={onBack} variant="link">
            <ChevronLeftIcon className="mr-1 size-4" />
            {t('firstRun_back')}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              disabled={saving}
              onClick={() => restoreInputRef.current?.click()}
              variant="outline">
              <HardDriveUploadIcon className="mr-1 size-4" />
              {t('agents_restoreAgent')}
            </Button>
            <Button data-testid="setup-next-button" disabled={saving} onClick={handleNext}>
              {saving && <Loader2Icon className="mr-2 size-4 animate-spin" />}
              {t('firstRun_next')}
            </Button>
          </div>
        </div>

        <input
          accept=".zip"
          className="hidden"
          ref={restoreInputRef}
          onChange={handleRestore}
          type="file"
        />
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
    () =>
      toolRegistryMeta
        .filter(g => !EXCLUDED_TOOL_GROUPS.has(g.groupKey))
        .filter(g => !IS_FIREFOX || !g.tools.every(t => t.chromeOnly)),
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
                    ({group.tools.length} {t('firstRun_tools')})
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
  onNext,
  onBack,
  t,
}: {
  onNext: () => void;
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
      onNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('firstRun_saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [skills, onNext, t]);

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
            {t('firstRun_next')}
          </Button>
        </div>
      </CardContent>
    </div>
  );
};

/* ---------- Step6SpeechSetup ---------- */

/** Auth definition for the gemini-web speech engine (browser session). */
const GEMINI_WEB_SPEECH_AUTH: WebAuthDefinition = {
  id: 'gemini-web',
  cookieDomain: '.google.com',
  sessionIndicators: ['__Secure-1PSID', 'SAPISID'],
  loginUrl: 'https://gemini.google.com',
};

const SPEECH_ENGINE_OPTIONS: { value: SttConfig['engine']; label: string; description: string }[] =
  [
    { value: 'off', label: 'Off', description: 'Audio transcription is disabled' },
    {
      value: 'sensevoice',
      label: 'SenseVoice (Local)',
      description:
        'Runs locally via WASM — no data leaves your browser. Downloads a ~239 MB model on first use.',
    },
    {
      value: 'transformers',
      label: 'Whisper (Local)',
      description: 'Runs a transformer model locally via ONNX — no data leaves your browser.',
    },
    {
      value: 'openai',
      label: 'OpenAI',
      description: "Uses OpenAI's Whisper API for high-accuracy cloud transcription.",
    },
    {
      value: 'gemini-web',
      label: 'Gemini (browser, no API key)',
      description: 'Transcribes using your logged-in Gemini web session — no API key required.',
    },
  ];

const Step6SpeechSetup = ({
  onComplete,
  onBack,
  t,
}: {
  onComplete: () => void;
  onBack: () => void;
  t: TFunction;
}) => {
  const [engine, setEngine] = useState<SttConfig['engine']>(defaultSttConfig.engine);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const {
    status: authStatus,
    loginLoading,
    error: authError,
    login,
    logout,
  } = useWebAuth({
    definition: engine === 'gemini-web' ? GEMINI_WEB_SPEECH_AUTH : undefined,
    recheckKey: engine,
  });

  useEffect(() => {
    const load = async () => {
      try {
        const config = await sttConfigStorage.get();
        setEngine(config.engine);
      } catch {
        // keep default
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleGetStarted = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      const config = await sttConfigStorage.get();
      await sttConfigStorage.set({ ...config, engine });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('firstRun_saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [engine, onComplete, t]);

  const selected = SPEECH_ENGINE_OPTIONS.find(o => o.value === engine);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{t('firstRun_speechTitle')}</CardTitle>
        <CardDescription>{t('firstRun_speechDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <Label className="flex items-center gap-1.5">
            <MicIcon className="text-muted-foreground size-3.5" />
            {t('firstRun_stepSpeech')}
          </Label>
          <Select
            disabled={loading}
            onValueChange={value => setEngine(value as SttConfig['engine'])}
            value={engine}>
            <SelectTrigger data-testid="setup-speech-engine">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SPEECH_ENGINE_OPTIONS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected && (
            <p className="text-muted-foreground text-xs leading-snug">{selected.description}</p>
          )}
          {engine === 'gemini-web' && (
            <WebAuthRow
              className="grid gap-2 pt-1"
              status={authStatus}
              loginLoading={loginLoading}
              error={authError}
              login={login}
              logout={logout}
              labels={{
                checking: t('stt_web_status_checking'),
                loggedIn: t('stt_web_status_logged_in'),
                expired: t('stt_web_status_expired'),
                notLoggedIn: t('stt_web_status_not_logged_in'),
                login: t('stt_web_login'),
                signingIn: 'Signing in\u2026',
                logout: t('stt_web_logout'),
              }}
            />
          )}
        </div>

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
            <Step3AgentSetup
              onBack={() => setStep(1 + offset)}
              onNext={() => setStep(3 + offset)}
              t={t}
            />
          )}
          {step === 3 + offset && (
            <Step2ChannelSetup
              onBack={() => setStep(2 + offset)}
              onNext={() => setStep(4 + offset)}
              t={t}
            />
          )}
          {step === 4 + offset && (
            <Step4ToolsSetup
              onBack={() => setStep(3 + offset)}
              onNext={() => setStep(5 + offset)}
              t={t}
            />
          )}
          {step === 5 + offset && (
            <Step5SkillsSetup
              onBack={() => setStep(4 + offset)}
              onNext={() => setStep(6 + offset)}
              t={t}
            />
          )}
          {step === 6 + offset && (
            <Step6SpeechSetup onBack={() => setStep(5 + offset)} onComplete={onComplete} t={t} />
          )}
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
