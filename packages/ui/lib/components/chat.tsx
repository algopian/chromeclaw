import { ArtifactPanel } from './artifact-panel';
import { ChatHeader } from './chat-header';
import { ChatInput } from './chat-input';
import { Messages } from './messages';
import { ArtifactContext, initialArtifactData } from '../hooks/use-artifact';
import { getEffectiveContextLimit, useLLMStream, parseSlashCommand, executeSlashCommand, WEB_PROVIDER_OPTIONS } from '@extension/shared';
import { addMessage, deleteMessagesAfter, thinkingLevelStorage } from '@extension/storage';
import { toast } from 'sonner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UIArtifact } from '../artifact-types';
import type { Attachment, ChatMessage, ChatModel, SessionUsage, ThinkingLevel, SubagentProgressInfo } from '@extension/shared';

type AgentInfo = { id: string; name: string; emoji: string };

type ChatProps = {
  chatId: string;
  models: ChatModel[];
  selectedModel: ChatModel;
  onModelChange: (modelId: string) => void;
  onNewChat: () => void;
  onOpenSidebar?: () => void;
  chatTitle?: string;
  onStreamComplete?: (message: ChatMessage, usage?: SessionUsage) => void;
  onChatCreated?: (chatId: string, firstUserMessage: string) => void;
  initialMessages?: ChatMessage[];
  isFullPage?: boolean;
  agents?: AgentInfo[];
  activeAgentId?: string;
  onAgentChange?: (agentId: string) => void;
  activeSubagents?: SubagentProgressInfo[];
  onStopSubagent?: (runId: string) => void;
};

const Chat = ({
  chatId,
  models,
  selectedModel,
  onModelChange,
  onNewChat,
  onOpenSidebar,
  chatTitle,
  onStreamComplete,
  onChatCreated,
  initialMessages,
  isFullPage,
  agents,
  activeAgentId,
  onAgentChange,
  activeSubagents,
  onStopSubagent,
}: ChatProps) => {
  // Track accumulated token usage for context status badge
  const usageRef = useRef({
    inputTokens: 0, outputTokens: 0, totalTokens: 0, compactionCount: 0,
    lastCompactionMethod: undefined as string | undefined,
    lastCompactionTokensSaved: undefined as number | undefined,
  });
  const [contextUsage, setContextUsage] = useState(usageRef.current);

  // ── TTS chunk-aware audio queue ──
  const ttsQueueRef = useRef<string[]>([]);
  const ttsPlayingRef = useRef(false);

  const base64ToObjectUrl = (base64: string, mimeType: string): string => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  };

  const resetTtsQueue = useCallback(() => {
    for (const url of ttsQueueRef.current) URL.revokeObjectURL(url);
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
  }, []);

  const playNextTtsChunk = useCallback(() => {
    if (ttsPlayingRef.current || ttsQueueRef.current.length === 0) return;

    const url = ttsQueueRef.current.shift()!;
    ttsPlayingRef.current = true;

    const audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      ttsPlayingRef.current = false;
      playNextTtsChunk();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      ttsPlayingRef.current = false;
      playNextTtsChunk(); // skip to next chunk on error
    };
    audio.play().catch(() => {
      URL.revokeObjectURL(url);
      ttsPlayingRef.current = false;
      playNextTtsChunk();
    });
  }, []);

  const handleTtsAudio = useCallback(
    (audioBase64: string, contentType: string, chunkIndex?: number, isLastChunk?: boolean) => {
      // Sentinel (empty audio + isLastChunk) — nothing to play
      if (isLastChunk && !audioBase64) return;

      // Single-blob legacy path (no chunkIndex) — play directly
      if (chunkIndex === undefined) {
        const url = base64ToObjectUrl(audioBase64, contentType);
        const audio = new Audio(url);
        audio.play().catch(() => {});
        audio.onended = () => URL.revokeObjectURL(url);
        return;
      }

      // First chunk of a new response — clear stale queue
      if (chunkIndex === 0) resetTtsQueue();

      // Chunked streaming path — enqueue and start playback chain
      ttsQueueRef.current.push(base64ToObjectUrl(audioBase64, contentType));
      playNextTtsChunk();
    },
    [playNextTtsChunk, resetTtsQueue],
  );

  const handleStreamCompleteWithUsage = useCallback(
    async (message: ChatMessage, usage?: SessionUsage) => {
      if (usage) {
        // Use contextUsage (last step) for display — accurate for context window %
        // Falls back to usage (accumulated) for single-step calls where both are equal
        const ctx = usage.contextUsage ?? usage;
        const tokensSaved = usage.compactionTokensBefore && usage.compactionTokensAfter
          ? usage.compactionTokensBefore - usage.compactionTokensAfter
          : undefined;
        usageRef.current = {
          inputTokens: ctx.promptTokens,
          outputTokens: ctx.completionTokens,
          totalTokens: ctx.totalTokens,
          compactionCount: usageRef.current.compactionCount + (usage.wasCompacted ? 1 : 0),
          lastCompactionMethod: usage.wasCompacted ? usage.compactionMethod : usageRef.current.lastCompactionMethod,
          lastCompactionTokensSaved: usage.wasCompacted && tokensSaved != null ? tokensSaved : usageRef.current.lastCompactionTokensSaved,
        };
        setContextUsage({ ...usageRef.current });
      }
      // Pass full usage (accumulated) to parent for storage
      if (onStreamComplete) await onStreamComplete(message, usage);
    },
    [onStreamComplete],
  );

  const handleUserMessageCreated = useCallback(
    async (userMessage: ChatMessage) => {
      await addMessage({
        id: userMessage.id,
        chatId: userMessage.chatId,
        role: userMessage.role,
        parts: userMessage.parts,
        createdAt: userMessage.createdAt,
      });
    },
    [],
  );

  const [isCompacting, setIsCompacting] = useState(false);

  // ── Thinking level for web providers ──
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('fast');

  const supportedThinkingLevels = useMemo(() => {
    if (selectedModel.provider !== 'web' || !selectedModel.webProviderId) return [];
    const opt = WEB_PROVIDER_OPTIONS.find(o => o.value === selectedModel.webProviderId);
    return (opt?.supportedThinkingLevels ?? []) as ThinkingLevel[];
  }, [selectedModel.provider, selectedModel.webProviderId]);

  // Load persisted thinking level when the web provider changes
  useEffect(() => {
    if (!selectedModel.webProviderId || supportedThinkingLevels.length === 0) {
      setThinkingLevel('fast');
      return;
    }
    thinkingLevelStorage.get().then(prefs => {
      const saved = prefs[selectedModel.webProviderId!];
      if (saved && supportedThinkingLevels.includes(saved as ThinkingLevel)) {
        setThinkingLevel(saved as ThinkingLevel);
      } else {
        setThinkingLevel('fast');
      }
    });
  }, [selectedModel.webProviderId, supportedThinkingLevels]);

  const handleThinkingLevelChange = useCallback(
    (mode: ThinkingLevel) => {
      setThinkingLevel(mode);
      if (selectedModel.webProviderId) {
        thinkingLevelStorage.get().then(prefs => {
          thinkingLevelStorage.set({ ...prefs, [selectedModel.webProviderId!]: mode });
        });
      }
    },
    [selectedModel.webProviderId],
  );

  const { messages, setMessages, sendMessage, status, stop, input, setInput } = useLLMStream({
    chatId,
    model: selectedModel,
    thinkingLevel: supportedThinkingLevels.length > 0 ? thinkingLevel : undefined,
    onStreamComplete: handleStreamCompleteWithUsage,
    onChatCreated,
    onUserMessageCreated: handleUserMessageCreated,
    initialMessages,
    onTtsAudio: handleTtsAudio,
  });

  // Append subagent result messages directly to messages state
  // (bypasses the broken initialMessages → useState path)
  useEffect(() => {
    const handler = (message: Record<string, unknown>) => {
      if (message.type !== 'SUBAGENT_COMPLETE') return;
      if (message.chatId !== chatId) return;

      const runId = String(message.runId ?? '');
      const artifactId = String(message.artifactId ?? '');
      const systemMsg: ChatMessage = {
        id: `subagent-result-${runId}`,
        chatId,
        role: 'system',
        parts: [{ type: 'text', text: String(message.findings ?? '') }],
        createdAt: Date.now(),
        // Encode runId + artifactId + task into model field for SubagentResultCard rendering
        model: `__subagent:${runId}:${artifactId}:${String(message.task ?? '')}`,
      };
      setMessages(prev => [...prev, systemMsg]);
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [chatId, setMessages]);

  const contextStatus = useMemo(
    () => ({
      inputTokens: contextUsage.inputTokens,
      outputTokens: contextUsage.outputTokens,
      totalTokens: contextUsage.totalTokens,
      compactionCount: contextUsage.compactionCount,
      contextLimit: getEffectiveContextLimit(selectedModel.id, selectedModel.contextWindow),
      lastCompactionMethod: contextUsage.lastCompactionMethod,
      lastCompactionTokensSaved: contextUsage.lastCompactionTokensSaved,
    }),
    [contextUsage, selectedModel.id, selectedModel.contextWindow],
  );

  const handleEditSubmit = useCallback(
    async (messageId: string, content: string) => {
      // Truncate messages after the edited one, update the message, and re-send
      await deleteMessagesAfter(chatId, messageId);
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === messageId);
        if (idx < 0) return prev;
        const updated = {
          ...prev[idx],
          parts: [{ type: 'text' as const, text: content }],
        };
        return prev.slice(0, idx + 1).map(m => (m.id === messageId ? updated : m));
      });
      sendMessage(content);
    },
    [chatId, setMessages, sendMessage],
  );

  const [artifact, setArtifact] = useState<UIArtifact>(initialArtifactData);

  return (
    <ArtifactContext.Provider value={{ artifact, rawSetArtifact: setArtifact }}>
      <div className="bg-background flex h-dvh min-w-0 flex-col">
        <ChatHeader
          activeAgentId={activeAgentId}
          agents={agents}
          chatTitle={chatTitle}
          contextStatus={contextStatus}
          isFullPage={isFullPage}
          model={selectedModel}
          onAgentChange={onAgentChange}
          onNewChat={onNewChat}
          onOpenSidebar={onOpenSidebar}
        />

        <Messages
          activeSubagents={activeSubagents}
          chatId={chatId}
          messages={messages}
          onEditSubmit={handleEditSubmit}
          onSendMessage={(content: string) => sendMessage(content)}
          onStopSubagent={onStopSubagent}
          setMessages={setMessages}
          status={isCompacting ? 'connecting' : status}
        />

        <div className="bg-background sticky bottom-0 z-[1] mx-auto flex w-full max-w-4xl gap-2 border-t-0 px-2 pb-3 md:px-4 md:pb-4">
          <ChatInput
            input={input}
            models={models}
            onModelChange={onModelChange}
            onSubmit={(content: string, attachments?: Attachment[]) => {
              const parsed = parseSlashCommand(content);
              if (parsed && !attachments?.length) {
                executeSlashCommand(parsed.command, {
                  chatId,
                  messages,
                  model: selectedModel,
                  args: parsed.args,
                  appendSystemMessage: (id, text) =>
                    setMessages(prev => [
                      ...prev,
                      {
                        id,
                        chatId,
                        role: 'system' as const,
                        parts: [{ type: 'text' as const, text }],
                        createdAt: Date.now(),
                      },
                    ]),
                  replaceMessages: msgs => setMessages(msgs),
                  clearInput: () => setInput(''),
                  resetUsage: () => {
                    usageRef.current = {
                      inputTokens: 0,
                      outputTokens: 0,
                      totalTokens: 0,
                      compactionCount: 0,
                      lastCompactionMethod: undefined,
                      lastCompactionTokensSaved: undefined,
                    };
                    setContextUsage({ ...usageRef.current });
                  },
                  incrementCompactionCount: () => {
                    usageRef.current.compactionCount++;
                    setContextUsage({ ...usageRef.current });
                  },
                  setIsCompacting,
                }).catch(err => {
                  console.error('[slash-cmd] unhandled error:', err);
                  toast.error(err instanceof Error ? err.message : 'Command failed');
                });
                return;
              }
              sendMessage(content, attachments);
            }}
            selectedModelId={selectedModel.dbId ?? selectedModel.id}
            setInput={setInput}
            thinkingLevel={thinkingLevel}
            onThinkingLevelChange={handleThinkingLevelChange}
            supportedThinkingLevels={supportedThinkingLevels}
            status={isCompacting ? 'connecting' : status}
            stop={stop}
          />
        </div>
      </div>

      <ArtifactPanel />
    </ArtifactContext.Provider>
  );
};

export { Chat };
export type { ChatProps };
