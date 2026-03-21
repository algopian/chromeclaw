import { withErrorBoundary, withSuspense } from '@extension/shared';
import {
  customModelsStorage,
  lastActiveSessionStorage,
  selectedModelStorage,
  settingsStorage,
  activeAgentStorage,
  toolConfigStorage,
  addMessage,
  createChat,
  getChat,
  getMessagesByChatId,
  getMostRecentChat,
  pruneOldSessions,
  touchChat,
  updateSessionTokens,
  seedPredefinedWorkspaceFiles,
  listAgents,
  updateAgent,
  getAgent,
} from '@extension/storage';
import { ConfigPanelContent } from '@extension/config-panels';
import {
  Chat,
  FirstRunSetup,
  SIDEBAR_DEFAULT_WIDTH,
  ScrollArea,
  Toaster,
  ErrorDisplay,
  LoadingSpinner,
  cn,
  useSubagentProgress,
} from '@extension/ui';
import { LocaleProvider, t } from '@extension/i18n';
import { FullPageSidebar } from './full-page-sidebar';
import type { SidebarTab } from './full-page-sidebar';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  ChatMessage,
  ChatMessagePart,
  ChatModel,
  SessionUsage,
} from '@extension/shared';
import type { LocaleCode } from '@extension/i18n';

const FullPageChat = () => {
  const [chatId, setChatId] = useState('');
  const [chatTitle, setChatTitle] = useState<string | undefined>();
  const [initialMessages, setInitialMessages] = useState<ChatMessage[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const firstRunRef = useRef(true);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [locale, setLocale] = useState<LocaleCode>('auto');

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = localStorage.getItem('chromeclaw-sidebar-width');
      return stored ? Number(stored) : SIDEBAR_DEFAULT_WIDTH;
    } catch {
      return SIDEBAR_DEFAULT_WIDTH;
    }
  });
  const [activeView, setActiveView] = useState<SidebarTab>('chat');
  const [agents, setAgents] = useState<{ id: string; name: string; emoji: string }[]>([]);
  const [activeAgentId, setActiveAgentId] = useState('main');
  const activeAgentIdRef = useRef(activeAgentId);
  activeAgentIdRef.current = activeAgentId;

  // Track current chat ID for session journaling on departure
  const currentChatIdRef = useRef(chatId);
  useEffect(() => {
    currentChatIdRef.current = chatId;
  }, [chatId]);

  const triggerJournal = useCallback(
    (departingChatId: string) => {
      if (!departingChatId) return;
      chrome.runtime.sendMessage(
        { type: 'SESSION_JOURNAL', chatId: departingChatId, agentId: activeAgentId },
        () => {
          if (chrome.runtime.lastError) {
            /* SW inactive, OK */
          }
        },
      );
    },
    [activeAgentId],
  );

  // Load agents and seed workspace files on mount
  useEffect(() => {
    const init = async () => {
      const currentAgentId = (await activeAgentStorage.get()) || 'main';
      setActiveAgentId(currentAgentId);
      const agentList = await listAgents();
      setAgents(agentList.map(a => ({ id: a.id, name: a.name, emoji: a.identity?.emoji ?? '' })));

      await seedPredefinedWorkspaceFiles(currentAgentId);
    };
    init().catch(console.error);
  }, []);

  // Subscribe to activeAgentStorage for cross-page live updates
  useEffect(() => {
    const unsub = activeAgentStorage.subscribe(() => {
      activeAgentStorage.get().then(newId => {
        if (newId && newId !== activeAgentIdRef.current) {
          setActiveAgentId(newId);
        }
      });
    });
    return unsub;
  }, []);

  // Restore last active session on mount
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const storedId = await lastActiveSessionStorage.get();
        if (storedId) {
          const chat = await getChat(storedId);
          if (chat) {
            const msgs = await getMessagesByChatId(chat.id);
            const mapped = msgs.map(m => ({
              id: m.id,
              chatId: m.chatId,
              role: m.role,
              parts: m.parts as ChatMessagePart[],
              createdAt: m.createdAt,
              model: m.model,
            })) as ChatMessage[];
            setChatId(chat.id);
            setChatTitle(chat.title);
            setInitialMessages(mapped);
            setSessionLoading(false);
            return;
          }
        }
        // Fallback: most recent chat
        const recent = await getMostRecentChat();
        if (recent) {
          const msgs = await getMessagesByChatId(recent.id);
          const mapped = msgs.map(m => ({
            id: m.id,
            chatId: m.chatId,
            role: m.role,
            parts: m.parts as ChatMessagePart[],
            createdAt: m.createdAt,
            model: m.model,
          })) as ChatMessage[];
          setChatId(recent.id);
          setChatTitle(recent.title);
          setInitialMessages(mapped);
          await lastActiveSessionStorage.set(recent.id);
        } else {
          // First time user — fresh session
          setChatId(nanoid());
        }
      } catch {
        setChatId(nanoid());
      } finally {
        setSessionLoading(false);
      }
    };
    restoreSession();
  }, []);

  // Prune old sessions on mount (non-blocking, delayed)
  useEffect(() => {
    const t = setTimeout(() => pruneOldSessions().catch(console.error), 10_000);
    return () => clearTimeout(t);
  }, []);

  // Apply theme on mount and subscribe to live changes
  useEffect(() => {
    const applyTheme = (theme: string) => {
      const root = document.documentElement;
      if (theme === 'dark') {
        root.classList.add('dark');
      } else if (theme === 'light') {
        root.classList.remove('dark');
      } else {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        root.classList.toggle('dark', prefersDark);
      }
    };

    settingsStorage.get().then(s => {
      applyTheme(s.theme);
      setLocale((s.locale ?? 'auto') as LocaleCode);
    });

    const unsub = settingsStorage.subscribe(() => {
      settingsStorage.get().then(s => {
        applyTheme(s.theme);
        setLocale((s.locale ?? 'auto') as LocaleCode);
      });
    });
    return unsub;
  }, []);

  const loadModels = useCallback(() => {
    Promise.all([customModelsStorage.get(), selectedModelStorage.get()]).then(
      ([stored, savedModelId]) => {
        const mapped = stored.map(m => ({
          id: m.modelId || m.id,
          name: m.name,
          provider: m.provider,
          description: m.description,
          supportsTools: m.supportsTools,
          supportsReasoning: m.supportsReasoning,
          routingMode: 'direct' as const,
          apiKey: m.apiKey,
          baseUrl: m.baseUrl,
          toolTimeoutSeconds: m.toolTimeoutSeconds,
          contextWindow: m.contextWindow,
          api: m.api,
          azureApiVersion: m.azureApiVersion,
          webProviderId: m.webProviderId,
        })) as ChatModel[];

        setModels(mapped);
        if (mapped.length > 0) firstRunRef.current = false;
        const restoredId =
          savedModelId && mapped.some(m => m.id === savedModelId)
            ? savedModelId
            : (mapped[0]?.id ?? '');
        setSelectedModelId(restoredId);
        setModelsLoaded(true);
      },
    );
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  // Subscribe to model storage changes so UI stays in sync with options page
  useEffect(() => {
    const unsub1 = selectedModelStorage.subscribe(() => loadModels());
    const unsub2 = customModelsStorage.subscribe(() => {
      if (!firstRunRef.current) loadModels();
    });
    return () => { unsub1(); unsub2(); };
  }, [loadModels]);

  // Network error detection
  useEffect(() => {
    const handleOffline = () => toast.error(t('toast_offline'));
    const handleOnline = () => toast.success(t('toast_online'));
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  // Reload messages for a given chat (shared by cron and subagent handlers)
  const reloadMessages = useCallback((targetChatId: string) => {
    getMessagesByChatId(targetChatId).then(dbMsgs => {
      const mapped = dbMsgs.map(m => ({
        id: m.id,
        chatId: m.chatId,
        role: m.role,
        parts: m.parts as ChatMessagePart[],
        createdAt: m.createdAt,
        model: m.model,
      })) as ChatMessage[];
      setInitialMessages(mapped);
    });
  }, []);

  // Listen for cron chat inject messages to reactively update the UI
  useEffect(() => {
    const handler = (message: Record<string, unknown>) => {
      const type = message.type as string;
      const injectChatId = message.chatId as string;
      if (!injectChatId || type !== 'CRON_CHAT_INJECT') return;

      setChatId(prev => {
        if (prev === injectChatId) {
          reloadMessages(injectChatId);
        } else {
          const taskName = message.taskName as string | undefined;
          toast.info(taskName ? t('toast_scheduledTask', taskName) : t('toast_scheduledTaskFired'), {
            duration: 10000,
          });
        }
        return prev;
      });
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [reloadMessages]);

  const stopSubagent = useCallback((runId: string) => {
    chrome.runtime.sendMessage({ type: 'SUBAGENT_STOP', runId }).catch(() => {});
  }, []);

  // Track subagent progress via shared hook
  const activeSubagents = useSubagentProgress(chatId, {
    onCurrentChatComplete: reloadMessages,
    onOtherChatComplete: (_chatId, task) => {
      toast.info(t('toast_subagentFinished', String(task)), { duration: 10000 });
    },
  });

  const handleSidebarWidthChange = useCallback((newWidth: number) => {
    setSidebarWidth(newWidth);
    try {
      localStorage.setItem('chromeclaw-sidebar-width', String(newWidth));
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  const handleAgentChange = useCallback(
    async (newAgentId: string) => {
      if (newAgentId === activeAgentId) return;

      triggerJournal(currentChatIdRef.current);

      // Save current agent's config
      const [currentModelId, currentToolConfig] = await Promise.all([
        selectedModelStorage.get(),
        (await import('@extension/storage')).toolConfigStorage.get(),
      ]);
      await updateAgent(activeAgentId, {
        ...(currentModelId ? { model: { primary: currentModelId } } : {}),
        toolConfig: currentToolConfig,
      });

      // Load new agent's config
      const newAgent = await getAgent(newAgentId);
      if (newAgent?.model?.primary) await selectedModelStorage.set(newAgent.model.primary);
      if (newAgent?.toolConfig) {
        const { toolConfigStorage } = await import('@extension/storage');
        await toolConfigStorage.set(newAgent.toolConfig);
      }

      await activeAgentStorage.set(newAgentId);
      setActiveAgentId(newAgentId);

      await seedPredefinedWorkspaceFiles(newAgentId);

      const recent = await getMostRecentChat(newAgentId);
      if (recent) {
        const msgs = await getMessagesByChatId(recent.id);
        const mapped = msgs.map(m => ({
          id: m.id,
          chatId: m.chatId,
          role: m.role,
          parts: m.parts as ChatMessagePart[],
          createdAt: m.createdAt,
          model: m.model,
        })) as ChatMessage[];
        setChatId(recent.id);
        setChatTitle(recent.title);
        setInitialMessages(mapped);
      } else {
        const newId = nanoid();
        setChatId(newId);
        setChatTitle(undefined);
        setInitialMessages([]);
      }

      loadModels();
    },
    [activeAgentId, triggerJournal, loadModels],
  );

  const handleOpenSession = useCallback(
    async (targetChatId: string) => {
      triggerJournal(currentChatIdRef.current);
      await lastActiveSessionStorage.set(targetChatId);
      const chat = await getChat(targetChatId);
      if (chat) {
        const msgs = await getMessagesByChatId(chat.id);
        const mapped = msgs.map(m => ({
          id: m.id,
          chatId: m.chatId,
          role: m.role,
          parts: m.parts as ChatMessagePart[],
          createdAt: m.createdAt,
          model: m.model,
        })) as ChatMessage[];
        setChatId(chat.id);
        setChatTitle(chat.title);
        setInitialMessages(mapped);
      }
      setActiveView('chat');
    },
    [triggerJournal],
  );

  const handleNewChat = useCallback(() => {
    triggerJournal(currentChatIdRef.current);
    const newId = nanoid();
    setChatId(newId);
    setChatTitle(undefined);
    setInitialMessages([]);
    lastActiveSessionStorage.set(newId);
  }, [triggerJournal]);

  const handleModelChange = useCallback((modelId: string) => {
    setSelectedModelId(modelId);
    selectedModelStorage.set(modelId);
  }, []);

  const handleStreamComplete = useCallback(
    async (assistantMessage: ChatMessage, usage?: SessionUsage) => {
      // Skip addMessage + touchChat when background SW already persisted the message
      if (!usage?.persistedByBackground) {
        await addMessage({
          id: assistantMessage.id,
          chatId: assistantMessage.chatId,
          role: assistantMessage.role,
          parts: assistantMessage.parts,
          createdAt: assistantMessage.createdAt,
          model: assistantMessage.model,
        });
        await touchChat(assistantMessage.chatId);
      }
      if (usage) await updateSessionTokens(assistantMessage.chatId, usage);
    },
    [],
  );

  const handleChatCreated = useCallback(
    async (newChatId: string, firstUserMessage: string) => {
      const title = firstUserMessage.slice(0, 100) || t('session_newSession');
      const now = Date.now();
      await createChat({
        id: newChatId,
        title,
        createdAt: now,
        updatedAt: now,
        model: selectedModelId,
        agentId: activeAgentId,
      });
      setChatTitle(title);
      lastActiveSessionStorage.set(newChatId);
      // User message is persisted by Chat's onUserMessageCreated handler
    },
    [selectedModelId, activeAgentId],
  );

  const handleFirstRunComplete = useCallback(() => {
    firstRunRef.current = false;
    loadModels();
  }, [loadModels]);

  const selectedModel = models.find(m => m.id === selectedModelId) ?? models[0];

  // Loading state
  if (!modelsLoaded || sessionLoading) {
    return (
      <LocaleProvider locale={locale}>
        <div className="bg-background flex h-dvh items-center justify-center">
          <LoadingSpinner />
        </div>
      </LocaleProvider>
    );
  }

  // Show first-run setup when no models configured
  if (models.length === 0) {
    return (
      <LocaleProvider locale={locale}>
        <FirstRunSetup onComplete={handleFirstRunComplete} />
        <Toaster />
      </LocaleProvider>
    );
  }

  if (!selectedModel) {
    return (
      <LocaleProvider locale={locale}>
        <div className="bg-background flex h-dvh items-center justify-center">
          <LoadingSpinner />
        </div>
      </LocaleProvider>
    );
  }

  return (
    <LocaleProvider locale={locale}>
      <div className="flex h-dvh">
        <FullPageSidebar
          isOpen={sidebarOpen}
          width={sidebarWidth}
          onWidthChange={handleSidebarWidthChange}
          activeTab={activeView}
          onTabChange={setActiveView}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {activeView === 'chat' && (
            <Chat
              activeAgentId={activeAgentId}
              activeSubagents={activeSubagents}
              agents={agents}
              chatId={chatId}
              chatTitle={chatTitle}
              initialMessages={initialMessages}
              isFullPage
              key={chatId}
              models={models}
              onAgentChange={handleAgentChange}
              onChatCreated={handleChatCreated}
              onModelChange={handleModelChange}
              onNewChat={handleNewChat}
              onOpenSidebar={() => setSidebarOpen(prev => !prev)}
              onStopSubagent={stopSubagent}
              onStreamComplete={handleStreamComplete}
              selectedModel={selectedModel}
            />
          )}
          {activeView !== 'chat' && (
            <ScrollArea className="flex-1">
              <div
                className={cn(
                  'mx-auto space-y-6 px-4 py-6',
                  activeView === 'agents' ? 'max-w-5xl' : 'max-w-2xl',
                )}>
                <ConfigPanelContent activeTab={activeView} onOpenSession={handleOpenSession} />
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
      <Toaster />
    </LocaleProvider>
  );
};

export default withErrorBoundary(withSuspense(FullPageChat, <LoadingSpinner />), ErrorDisplay);
