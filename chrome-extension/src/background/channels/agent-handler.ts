import { updateChannelConfig } from './config';
import {
  sendChatAction,
  sendHtmlMessage,
  editMessageText,
  getFile,
  downloadFile,
  setMessageReaction,
  removeMessageReaction,
  sendVoiceMessage,
  sendAudioMessage,
  formatTelegramHtml,
  MAX_TG_MESSAGE_LENGTH,
} from './telegram/bot-api';
import { sendAudioViaOffscreen } from './whatsapp/adapter';
import { dbModelToChatModel, runAgent } from '../agents/agent-setup';
import { chatMessagesToPiMessages, convertToLlm, makeConvertToLlm } from '../agents/message-adapter';
import { sanitizeHistory } from '../context/history-sanitization';
import { createTransformContext } from '../context/transform';
import { createLogger } from '../logging/logger-buffer';
import { resolveTranscription } from '../media-understanding';
import { getToolConfig, getImplementedToolNames } from '../tools';
import { maybeApplyTtsBatchedStream } from '../tts';
import { createKeepAliveManager } from '../utils/keep-alive';
import { buildSystemPrompt, resolveToolPromptHints, resolveToolListings } from '@extension/shared';
import { IS_FIREFOX } from '@extension/env';
import {
  createChat,
  addMessage,
  getMessagesByChatId,
  findChatByChannelChatId,
  touchChat,
  updateSessionTokens,
  customModelsStorage,
  selectedModelStorage,
  activeAgentStorage,
  getAgent,
  getEnabledWorkspaceFiles,
  getEnabledSkills,
  ttsConfigStorage,
} from '@extension/storage';
import { nanoid } from 'nanoid';
import type { ChannelAdapter, ChannelConfig, ChannelInboundMessage } from './types';
import type { AssistantMessage } from '../agents';
import type { ChatMessage, ChatModel } from '@extension/shared';
import type { DbChat } from '@extension/storage';

// ── Keep-alive: prevent SW termination during channel LLM streams ──

const channelLog = createLogger('channel');

const channelKeepAlive = createKeepAliveManager('channel-keep-alive');
// Clear any orphaned alarm from a previous SW crash
channelKeepAlive.clearOrphan();

const acquireChannelKeepAlive = (): void => {
  channelKeepAlive.acquire();
};

const releaseChannelKeepAlive = (): void => {
  channelKeepAlive.release();
};

const TYPING_INTERVAL_MS = 4000;
const DRAFT_EDIT_INTERVAL_MS = 500;
const DRAFT_INITIAL_THRESHOLD = 20;

// ── R5: Per-chat mutex to prevent concurrent handling of messages for the same chat ──
const chatLocks = new Map<string, Promise<void>>();
const withChatLock = (chatId: string, fn: () => Promise<void>): Promise<void> => {
  const prev = chatLocks.get(chatId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const silenced = next.then(
    () => {},
    () => {},
  );
  chatLocks.set(chatId, silenced);
  // Clean up after completion to avoid unbounded map growth
  silenced.finally(() => {
    if (chatLocks.get(chatId) === silenced) {
      chatLocks.delete(chatId);
    }
  });
  return next;
};

// ── Broadcast helpers ─────────────────────────

const broadcast = (msg: Record<string, unknown>): void => {
  chrome.runtime.sendMessage(msg).catch(() => {});
};

/** Resolve the ChatModel to use for a channel message */
const resolveModel = async (config: ChannelConfig): Promise<ChatModel | null> => {
  const models = await customModelsStorage.get();
  if (!models || models.length === 0) return null;

  if (config.modelId) {
    const override = models.find(m => m.id === config.modelId);
    if (override) return dbModelToChatModel(override);
  }

  const selectedId = await selectedModelStorage.get();
  if (selectedId) {
    const selected = models.find(m => m.id === selectedId || m.modelId === selectedId);
    if (selected) return dbModelToChatModel(selected);
  }

  return dbModelToChatModel(models[0]);
};

// ── Draft Streaming State Machine ──────────────

interface DraftState {
  sentMessageId: number | undefined;
  lastSentText: string;
  lastSentAt: number;
  /** Offset into stepText where the current sentMessageId's content starts */
  currentMsgStartOffset: number;
  /** Whether any draft message was ever sent (survives reset between tool steps) */
  everSent: boolean;
}

const createDraftState = (): DraftState => ({
  sentMessageId: undefined,
  lastSentText: '',
  lastSentAt: 0,
  currentMsgStartOffset: 0,
  everSent: false,
});

/** R5: Handle with per-chat lock to prevent concurrent processing */
const handleChannelMessage = (
  msg: ChannelInboundMessage,
  adapter: ChannelAdapter,
  config: ChannelConfig,
): Promise<void> =>
  withChatLock(msg.channelChatId, () => handleChannelMessageInner(msg, adapter, config));

/** Inner handler — runs inside per-chat lock */
const handleChannelMessageInner = async (
  msg: ChannelInboundMessage,
  adapter: ChannelAdapter,
  config: ChannelConfig,
): Promise<void> => {
  acquireChannelKeepAlive();
  try {
    channelLog.debug('Channel message received', {
      channel: adapter.id,
      senderId: msg.senderId,
      bodyPreview: msg.body.slice(0, 50),
      hasMedia: !!msg.mediaFileId,
    });
    channelLog.trace('Inbound message payload', { msg });

    const isTelegram = adapter.id === 'telegram';
    const isWhatsApp = adapter.id === 'whatsapp';
    const botToken = isTelegram ? config.credentials.botToken : undefined;
    const inboundMessageId = msg.channelMessageId ? Number(msg.channelMessageId) : undefined;

    try {
      // 0. React to the message to indicate receipt
      if (isTelegram && botToken && inboundMessageId) {
        try {
          await setMessageReaction(botToken, msg.channelChatId, inboundMessageId, '👀');
        } catch {
          // Reactions may not be supported in all chats
        }
      }

      // 1. Resolve model
      const model = await resolveModel(config);
      channelLog.trace('Resolved model', {
        modelId: model?.id,
        modelName: model?.name,
        provider: model?.provider,
      });
      if (!model) {
        channelLog.warn('No model configured, skipping channel message');
        await adapter.sendMessage({
          to: msg.channelChatId,
          text: 'No AI model is configured. Please set up a model in ChromeClaw settings.',
        });
        return;
      }

      // 2. Find or create chat
      const chat = await findOrCreateChat(msg, adapter);
      channelLog.debug('Channel session resolved', {
        chatId: chat.id,
        agentId: chat.agentId,
        isNew: !chat.updatedAt || chat.updatedAt === chat.createdAt,
      });

      // 3. Start typing indicator
      let typingInterval: ReturnType<typeof setInterval> | undefined;
      if (isTelegram && botToken) {
        await sendChatAction(botToken, msg.channelChatId).catch(() => {});
        typingInterval = setInterval(() => {
          if (botToken) {
            sendChatAction(botToken, msg.channelChatId).catch(() => {});
          }
        }, TYPING_INTERVAL_MS);
      } else if (isWhatsApp) {
        chrome.runtime
          .sendMessage({ type: 'WA_SET_TYPING', jid: msg.channelChatId, isTyping: true })
          .catch(() => {});
        typingInterval = setInterval(() => {
          chrome.runtime
            .sendMessage({ type: 'WA_SET_TYPING', jid: msg.channelChatId, isTyping: true })
            .catch(() => {});
        }, TYPING_INTERVAL_MS);
      }

      try {
        // 4. Handle voice transcription if needed
        let userText = msg.body;
        if (msg.mediaFileId && botToken) {
          channelLog.info('Voice message detected, transcribing', {
            fileId: msg.mediaFileId,
            mimeType: msg.mediaMimeType,
          });
          try {
            const fileInfo = await getFile(botToken, msg.mediaFileId);
            const audioBuffer = await downloadFile(botToken, fileInfo.filePath);
            const transcript = await resolveTranscription(
              audioBuffer,
              msg.mediaMimeType ?? 'audio/ogg',
            );
            userText = transcript;
            channelLog.info('Voice transcribed', { transcriptPreview: transcript.slice(0, 80) });
          } catch (err) {
            channelLog.error('Voice transcription failed', { error: String(err) });
            await adapter.sendMessage({
              to: msg.channelChatId,
              text: 'Sorry, I could not transcribe your voice message. Please try sending text instead.',
            });
            return;
          }
        }

        // 5. Save user message
        const userMessage: ChatMessage = {
          id: nanoid(),
          chatId: chat.id,
          role: 'user',
          parts: [{ type: 'text', text: userText }],
          createdAt: msg.timestamp || Date.now(),
        };
        await addMessage(userMessage);
        await touchChat(chat.id);

        // R15: Update lastActivityAt so watchdog doesn't downgrade during LLM streaming
        await updateChannelConfig(config.channelId, { lastActivityAt: Date.now() });

        // 5b. Show notification
        try {
          const senderDisplay = adapter.formatSenderDisplay(msg);
          chrome.notifications.create(`channel-${msg.channelMessageId ?? nanoid()}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon-128.png'),
            title: `${adapter.label}: ${senderDisplay}`,
            message: userText.slice(0, 200),
            priority: 1,
          });
        } catch {
          // Notifications may not be available in all contexts
        }

        // 5c. Broadcast to UI: new channel message arrived
        broadcast({
          type: 'CHANNEL_STREAM_START',
          chatId: chat.id,
          channelId: adapter.id,
          title: chat.title,
          userMessage,
        });

        // 6. Load conversation history and sanitize for provider
        const history = await getMessagesByChatId(chat.id);
        const sanitized = sanitizeHistory(history as unknown as ChatMessage[], model.provider);
        const piMessages = chatMessagesToPiMessages(sanitized);

        // 7. Build system prompt (channels always use default agent's workspace in v1)
        const workspaceFiles = await getEnabledWorkspaceFiles('main');
        const skills = await getEnabledSkills('main');
        const toolConfig = await getToolConfig();
        const mainAgent = await getAgent('main');

        const ttsConfig = await ttsConfigStorage.get();
        const ttsEnabled = ttsConfig.engine !== 'off' && ttsConfig.autoMode !== 'off';

        const availableTools = getImplementedToolNames();
        const channelExtraContext = `You are responding via ${adapter.label}. Keep responses concise and well-formatted for mobile reading. Avoid very long responses unless the user explicitly asks for detail.`;
        const { text: systemPrompt } = buildSystemPrompt({
          mode: 'full',
          tools: resolveToolListings(
            toolConfig.enabledTools,
            mainAgent?.customTools,
            availableTools,
          ),
          toolPromptHints: resolveToolPromptHints(
            toolConfig.enabledTools,
            mainAgent?.customTools,
            availableTools,
          ),
          hasTts: ttsEnabled,
          workspaceFiles: workspaceFiles.map(f => ({
            name: f.name,
            content: f.content,
            owner: f.owner,
          })),
          skills: skills.map(s => ({
            name: s.metadata.name,
            description: s.metadata.description,
            path: s.file.name,
          })),
          runtimeMeta: {
            modelName: model.name,
            currentDate: new Date().toISOString().split('T')[0],
            browser: IS_FIREFOX ? 'firefox' : 'chrome',
          },
          extraContext: channelExtraContext,
        });

        // 8. Build transformContext for compaction (previously missing for channels)
        const systemPromptTokens = Math.ceil(systemPrompt.length / 4);
        const { transformContext } = createTransformContext({
          chatId: chat.id,
          modelConfig: model,
          systemPromptTokens,
        });

        // 9. Separate history from the last user message (which is the prompt)
        const promptMessage = [...piMessages].reverse().find(m => m.role === 'user');
        if (!promptMessage) {
          channelLog.error('No user message found in conversation history');
          await adapter.sendMessage({
            to: msg.channelChatId,
            text: 'Internal error: no user message found in conversation.',
          });
          return;
        }
        const promptIndex = piMessages.lastIndexOf(promptMessage);
        const historyMessages = piMessages.slice(0, promptIndex);

        channelLog.trace('LLM request', {
          model: model.id,
          timeoutSeconds: model.toolTimeoutSeconds ?? 300,
        });

        // 10. Draft streaming state (Telegram only)
        let currentStepText = '';
        const draft = isTelegram && botToken ? createDraftState() : null;
        let draftPromise = Promise.resolve();

        /** Flush pending draft edits + send final text for the current turn.
         *  Callers must ensure prior draftPromise chain has resolved before calling. */
        const flushDraft = async (): Promise<void> => {
          if (!draft || !botToken) return;

          if (draft.sentMessageId && currentStepText !== draft.lastSentText) {
            // Final edit for current turn's message
            const editableText = currentStepText.slice(draft.currentMsgStartOffset);
            const html = formatTelegramHtml(editableText);
            await editMessageText(botToken, msg.channelChatId, draft.sentMessageId, html).catch(
              (err: unknown) => channelLog.warn('Draft flush edit failed', { error: String(err) }),
            );
          } else if (!draft.sentMessageId && currentStepText.length > 0) {
            // Turn produced text too short for draft threshold — send it now
            const html = formatTelegramHtml(currentStepText);
            await sendHtmlMessage(botToken, msg.channelChatId, html).catch((err: unknown) =>
              channelLog.warn('Draft flush send failed', { error: String(err) }),
            );
            draft.everSent = true;
          }
        };

        // 11. Run agent with channel-specific callbacks
        const result = await runAgent({
          model,
          systemPrompt,
          prompt: promptMessage,
          messages: historyMessages,
          convertToLlm: makeConvertToLlm(model),
          transformContext,
          chatId: chat.id,
          onTextDelta: delta => {
            currentStepText += delta;
            broadcast({ type: 'CHANNEL_STREAM_CHUNK', chatId: chat.id, delta });

            // Draft streaming: send/edit message in Telegram as text accumulates
            if (draft && botToken) {
              draftPromise = draftPromise.then(() =>
                updateDraft(draft, currentStepText, botToken, msg.channelChatId).then(() => {
                  if (draft.sentMessageId && typingInterval) {
                    clearInterval(typingInterval);
                    typingInterval = undefined;
                  }
                }),
              );
            }
          },
          onReasoningDelta: delta => {
            broadcast({ type: 'CHANNEL_STREAM_CHUNK', chatId: chat.id, reasoning: delta });
          },
          onToolCallEnd: tc => {
            broadcast({
              type: 'CHANNEL_STREAM_CHUNK',
              chatId: chat.id,
              toolCall: tc,
              state: 'input-available',
            });
          },
          onToolResult: tr => {
            broadcast({
              type: 'CHANNEL_STREAM_CHUNK',
              chatId: chat.id,
              toolResult: {
                id: tr.toolCallId,
                result: tr.isError ? { error: tr.result } : tr.result,
              },
              state: tr.isError ? 'output-error' : 'output-available',
            });
          },
          onTurnEnd: () => {
            // Flush pending draft before resetting state for next turn
            if (draft && currentStepText) {
              draftPromise = draftPromise.then(() => flushDraft());
            }
            // Reset for next turn after flush completes
            draftPromise = draftPromise.then(() => {
              if (draft) {
                draft.sentMessageId = undefined;
                draft.lastSentText = '';
                draft.lastSentAt = 0;
                draft.currentMsgStartOffset = 0;
              }
              currentStepText = '';
            });
          },
        });

        // 12. Flush any remaining draft text
        channelLog.debug('Flushing draft', { chatId: chat.id });
        await draftPromise;
        await flushDraft();

        channelLog.trace('LLM response', {
          text: result.responseText,
          totalParts: result.parts.length,
          usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
        });

        // 13. Save assistant message with ALL parts
        const assistantMessage: ChatMessage = {
          id: nanoid(),
          chatId: chat.id,
          role: 'assistant',
          parts: result.parts,
          createdAt: Date.now(),
          model: model.id,
        };
        await addMessage(assistantMessage);
        channelLog.debug('Assistant message saved', {
          chatId: chat.id,
          partsCount: result.parts.length,
        });

        // 14. Update token usage
        const totalUsage = {
          promptTokens: result.usage.inputTokens,
          completionTokens: result.usage.outputTokens,
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
        };
        if (totalUsage.totalTokens > 0) {
          await updateSessionTokens(chat.id, totalUsage);
        }

        await touchChat(chat.id);

        // 15. Broadcast stream end to UI
        broadcast({
          type: 'CHANNEL_STREAM_END',
          chatId: chat.id,
          usage: totalUsage,
        });

        // 16. Send response to channel (if draft streaming didn't already handle it)
        if (!draft || !draft.everSent) {
          // Reconstruct full text from all parts (responseText only has the last turn)
          const fullText =
            result.parts
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && !!p.text)
              .map(p => p.text)
              .join('\n\n') || result.responseText;
          const sendResult = await adapter.sendMessage({
            to: msg.channelChatId,
            text: fullText,
          });
          if (!sendResult.ok) {
            channelLog.error('Failed to send channel response', { error: sendResult.error });
          }
        }

        // 17. TTS voice reply — batched streaming (first-chunk-fast, non-fatal)
        const shouldTts = (isTelegram && botToken) || isWhatsApp;
        if (shouldTts) {
          try {
            const inboundHadAudio = !!msg.mediaFileId;
            const ttsChatId = msg.channelChatId;

            const sendTtsChunk = async (
              chunk: {
                audio: ArrayBuffer;
                contentType: string;
                voiceCompatible: boolean;
                provider: string;
              },
              label: string,
            ) => {
              if (isTelegram && botToken) {
                if (chunk.voiceCompatible) {
                  await sendVoiceMessage(botToken, ttsChatId, chunk.audio);
                } else {
                  await sendAudioMessage(botToken, ttsChatId, chunk.audio, {
                    contentType: chunk.contentType,
                    filename: `reply.${chunk.contentType === 'audio/wav' ? 'wav' : 'audio'}`,
                  });
                }
              } else if (isWhatsApp) {
                await sendAudioViaOffscreen(ttsChatId, chunk.audio, chunk.voiceCompatible);
              }
              channelLog.info(`TTS ${label} sent`, {
                channel: adapter.id,
                provider: chunk.provider,
                audioSize: chunk.audio.byteLength,
                voiceCompatible: chunk.voiceCompatible,
              });
            };

            await maybeApplyTtsBatchedStream({
              text: result.responseText,
              config: ttsConfig,
              inboundHadAudio,
              modelConfig: model,
              onFirstChunk: chunk => sendTtsChunk(chunk, 'first chunk'),
              onRemainder: chunk => sendTtsChunk(chunk, 'remainder'),
            });
          } catch (ttsErr) {
            // TTS failure is non-fatal — text reply was already sent
            channelLog.warn('TTS voice reply failed (non-fatal)', { error: String(ttsErr) });
          }
        }

        // 18. Remove the receipt reaction
        if (isTelegram && botToken && inboundMessageId) {
          try {
            await removeMessageReaction(botToken, msg.channelChatId, inboundMessageId);
          } catch {
            // Reaction removal may not be supported
          }
        }

        channelLog.info('Channel response sent', { channel: adapter.id, chatId: chat.id });
      } finally {
        // Always clear typing interval
        if (typingInterval) {
          clearInterval(typingInterval);
        }
        // Clear WhatsApp composing indicator
        if (isWhatsApp) {
          chrome.runtime
            .sendMessage({ type: 'WA_SET_TYPING', jid: msg.channelChatId, isTyping: false })
            .catch(() => {});
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      channelLog.error('Channel agent handler error', { error: errorMsg });

      try {
        await adapter.sendMessage({
          to: msg.channelChatId,
          text: 'Sorry, I encountered an error processing your message. Please try again later.',
        });
      } catch {
        // Sending error message failed too
      }

      // Remove the receipt reaction on error path too
      if (isTelegram && botToken && inboundMessageId) {
        await removeMessageReaction(botToken, msg.channelChatId, inboundMessageId).catch(() => {});
      }
    }
  } finally {
    releaseChannelKeepAlive();
  }
};

// ── Draft Streaming Helpers ─────────────────────

/** Update the draft message in Telegram: send initial or edit existing */
const updateDraft = async (
  draft: DraftState,
  stepText: string,
  botToken: string,
  chatId: string,
): Promise<void> => {
  const now = Date.now();

  if (!draft.sentMessageId) {
    // WAITING state: send initial message once we have enough text
    if (stepText.length >= DRAFT_INITIAL_THRESHOLD) {
      const html = formatTelegramHtml(stepText);
      try {
        const messageId = await sendHtmlMessage(botToken, chatId, html);
        if (messageId) {
          draft.sentMessageId = messageId;
          draft.lastSentText = stepText;
          draft.lastSentAt = now;
          draft.currentMsgStartOffset = 0;
          draft.everSent = true;
        }
      } catch (err) {
        channelLog.warn('Draft send failed', { error: String(err) });
      }
    }
    return;
  }

  // STREAMING state: edit existing message on interval
  if (now - draft.lastSentAt < DRAFT_EDIT_INTERVAL_MS) return;
  if (stepText === draft.lastSentText) return;

  // Handle overflow: if current message portion exceeds max length, send a new message
  const currentMsgText = stepText.slice(draft.currentMsgStartOffset);
  if (currentMsgText.length > MAX_TG_MESSAGE_LENGTH) {
    const overflowText = stepText.slice(draft.currentMsgStartOffset + MAX_TG_MESSAGE_LENGTH);
    if (overflowText.length >= DRAFT_INITIAL_THRESHOLD) {
      const html = formatTelegramHtml(overflowText);
      try {
        const messageId = await sendHtmlMessage(botToken, chatId, html);
        if (messageId) {
          draft.sentMessageId = messageId;
          draft.lastSentText = stepText;
          draft.lastSentAt = now;
          draft.currentMsgStartOffset = stepText.length - overflowText.length;
        }
      } catch (err) {
        channelLog.warn('Draft overflow send failed', { error: String(err) });
      }
    }
    return;
  }

  // Normal edit — only send the portion for the current message
  const editHtml = formatTelegramHtml(currentMsgText);
  try {
    await editMessageText(botToken, chatId, draft.sentMessageId, editHtml);
    draft.lastSentText = stepText;
    draft.lastSentAt = now;
  } catch (err) {
    // "message is not modified" is expected if text hasn't changed enough
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!errMsg.includes('not modified')) {
      channelLog.warn('Draft edit failed', { error: errMsg });
    }
  }
};

/** Find an existing chat for this channel conversation, or create a new one */
const findOrCreateChat = async (
  msg: ChannelInboundMessage,
  adapter: ChannelAdapter,
): Promise<DbChat> => {
  const existing = await findChatByChannelChatId(adapter.id, msg.channelChatId);
  if (existing) return existing;

  const currentAgentId = (await activeAgentStorage.get()) || 'main';
  const senderDisplay = adapter.formatSenderDisplay(msg);
  const now = Date.now();
  const chat: DbChat = {
    id: nanoid(),
    title: `${adapter.label}: ${senderDisplay}`,
    createdAt: now,
    updatedAt: now,
    source: adapter.id,
    agentId: currentAgentId,
    channelMeta: {
      channelId: adapter.id,
      chatId: msg.channelChatId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      senderUsername: msg.senderUsername,
    },
  };

  await createChat(chat);
  channelLog.info('Created channel chat', {
    chatId: chat.id,
    channel: adapter.id,
    agentId: currentAgentId,
  });
  return chat;
};

export { handleChannelMessage, resolveModel };
