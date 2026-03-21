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
import {
  Chat,
  ChatSidebar,
  FirstRunSetup,
  Toaster,
  ErrorDisplay,
  LoadingSpinner,
  useSubagentProgress,
} from '@extension/ui';
import { LocaleProvider, t } from '@extension/i18n';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  Chat as ChatType,
  ChatMessage,
  ChatMessagePart,
  ChatModel,
  SessionUsage,
} from '@extension/shared';
import type { LocaleCode } from '@extension/i18n';

const SidePanel = () => {
  const [chatId, setChatId] = useState('');
  const [chatTitle, setChatTitle] = useState<string | undefined>();
  const [initialMessages, setInitialMessages] = useState<ChatMessage[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const firstRunRef = useRef(true);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [locale, setLocale] = useState<LocaleCode>('auto');

  const [chatKey, setChatKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
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

  // Apply theme on mount and subscribe to live changes from Options page
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
        // Restore persisted selection if valid, otherwise fall back to first model
        const restoredId =
          savedModelId && mapped.some(m => m.id === savedModelId)
            ? savedModelId
            : (mapped[0]?.id ?? '');
        setSelectedModelId(restoredId);
        setModelsLoaded(true);
      },
    );
  }, []);

  // Load models on mount
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

  const handleAgentChange = useCallback(
    async (newAgentId: string) => {
      if (newAgentId === activeAgentId) return;

      // Journal the departing chat
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

      // Switch active agent
      await activeAgentStorage.set(newAgentId);
      setActiveAgentId(newAgentId);

      // Seed workspace files for new agent (background reads fresh per-turn)
      await seedPredefinedWorkspaceFiles(newAgentId);

      // Restore or start new chat for the new agent
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
      setChatKey(k => k + 1);

      // Reload models (selection may have changed)
      loadModels();
    },
    [activeAgentId, triggerJournal, loadModels],
  );

  const handleNewChat = useCallback(() => {
    triggerJournal(currentChatIdRef.current);
    const newId = nanoid();
    setChatId(newId);
    setChatTitle(undefined);
    setInitialMessages([]);
    setChatKey(k => k + 1);
    lastActiveSessionStorage.set(newId);
  }, [triggerJournal]);

  const handleSelectChat = useCallback(
    async (chat: ChatType) => {
      triggerJournal(currentChatIdRef.current);
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
      setChatKey(k => k + 1);
      lastActiveSessionStorage.set(chat.id);
    },
    [triggerJournal],
  );

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

  // Reload messages for a given chat (shared by channel and subagent handlers)
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

  // ── Channel Stream Listener ────────────────────
  // R3: Does NOT auto-switch if user is on a different chat — shows a toast instead.
  // R10: Uses a sequence counter to discard stale async DB reads.
  const channelSeqRef = useRef(0);

  const loadAndSwitchToChat = useCallback((streamChatId: string, title?: string) => {
    const seq = ++channelSeqRef.current;
    getMessagesByChatId(streamChatId).then(dbMsgs => {
      if (channelSeqRef.current !== seq) return; // R10: stale read
      const mapped = dbMsgs.map(m => ({
        id: m.id,
        chatId: m.chatId,
        role: m.role,
        parts: m.parts as ChatMessagePart[],
        createdAt: m.createdAt,
        model: m.model,
      })) as ChatMessage[];

      setChatId(streamChatId);
      setChatTitle(title);
      setInitialMessages(mapped);
      setChatKey(k => k + 1);
      lastActiveSessionStorage.set(streamChatId);
    });
  }, []);

  const stopSubagent = useCallback((runId: string) => {
    chrome.runtime.sendMessage({ type: 'SUBAGENT_STOP', runId }).catch(() => {});
  }, []);

  // Track subagent progress via shared hook
  const activeSubagents = useSubagentProgress(chatId, {
    onCurrentChatComplete: reloadMessages,
    onOtherChatComplete: (targetChatId, task) => {
      toast.info(t('toast_subagentFinished', String(task)), {
        action: {
          label: t('toast_view'),
          onClick: () => loadAndSwitchToChat(targetChatId),
        },
        duration: 10000,
      });
    },
  });

  useEffect(() => {
    const handler = (message: Record<string, unknown>) => {
      const type = message.type as string;
      const msgChatId = message.chatId as string;
      if (!msgChatId) return;

      // Cron scheduled task injected a message into a chat
      if (type === 'CRON_CHAT_INJECT') {
        const taskName = message.taskName as string | undefined;
        setChatId(prev => {
          if (prev === msgChatId) {
            reloadMessages(msgChatId);
          } else {
            toast.info(taskName ? t('toast_scheduledTask', taskName) : t('toast_scheduledTaskFired'), {
              action: {
                label: t('toast_view'),
                onClick: () => loadAndSwitchToChat(msgChatId),
              },
              duration: 10000,
            });
          }
          return prev;
        });
        return;
      }

      if (!type?.startsWith('CHANNEL_STREAM_')) return;

      if (type === 'CHANNEL_STREAM_START') {
        const title = message.title as string | undefined;

        // R3: Only auto-switch if user is already on this chat or has no active chat
        setChatId(prev => {
          if (prev === msgChatId) {
            // Already on this chat — just reload messages
            loadAndSwitchToChat(msgChatId, title);
          } else {
            // Different chat — show a non-intrusive toast with a "View" action
            toast.info(t('toast_newTelegramMessage'), {
              action: {
                label: t('toast_view'),
                onClick: () => loadAndSwitchToChat(msgChatId, title),
              },
              duration: 10000,
            });
          }
          return prev;
        });
      }

      if (type === 'CHANNEL_STREAM_END') {
        // Reload messages if we're on this chat (assistant response now saved in DB)
        setChatId(prev => {
          if (prev === msgChatId) reloadMessages(msgChatId);
          return prev;
        });
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [reloadMessages, loadAndSwitchToChat]);

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
      <ChatSidebar
        agentId={activeAgentId}
        currentChatId={chatId}
        isOpen={sidebarOpen}
        mode="overlay"
        onClearAll={() => {
          handleNewChat();
          setSidebarOpen(false);
          lastActiveSessionStorage.set('');
          toast.success(t('toast_allSessionsCleared'));
        }}
        onClose={() => setSidebarOpen(false)}
        onNewChat={handleNewChat}
        onSelectChat={handleSelectChat}
      />
      <Chat
        activeAgentId={activeAgentId}
        activeSubagents={activeSubagents}
        agents={agents}
        chatId={chatId}
        chatTitle={chatTitle}
        initialMessages={initialMessages}
        key={chatKey}
        models={models}
        onAgentChange={handleAgentChange}
        onChatCreated={handleChatCreated}
        onModelChange={handleModelChange}
        onNewChat={handleNewChat}
        onOpenSidebar={() => setSidebarOpen(true)}
        onStopSubagent={stopSubagent}
        onStreamComplete={handleStreamComplete}
        selectedModel={selectedModel}
      />
      <Toaster />
    </LocaleProvider>
  );
};

export default withErrorBoundary(withSuspense(SidePanel, <LoadingSpinner />), ErrorDisplay);
