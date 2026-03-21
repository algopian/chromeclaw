import { buildHeadlessSystemPrompt, runAgent } from './agent-setup';
import { chatMessagesToPiMessages, makeConvertToLlm } from './message-adapter';
import { sanitizeHistory } from '../context/history-sanitization';
import { createTransformContext } from '../context/transform';
import { createLogger } from '../logging/logger-buffer';
import { runMemoryFlushIfNeeded } from '../memory/memory-flush';
import { activeAgentStorage, saveArtifact } from '@extension/storage';
import type { chatModelToPiModel } from './model-adapter';
import type {
  ChatMessagePart,
  LLMRequestMessage,
  LLMStreamChunk,
  LLMStreamEnd,
  LLMStepFinish,
  LLMStreamError,
  LLMStreamRetry,
  LLMTtsAudio,
  ModelProvider,
} from '@extension/shared';
import type { DbArtifact } from '@extension/storage';
import type { AssistantMessage } from '@mariozechner/pi-ai';

const streamLog = createLogger('stream');

/** Post a message to the port, returning false if the port is disconnected. */
const safeSend = (port: chrome.runtime.Port, msg: Record<string, unknown>): boolean => {
  try {
    port.postMessage(msg);
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes('disconnected port')) {
      return false;
    }
    throw err;
  }
};

const sendChunk = (port: chrome.runtime.Port, chunk: Omit<LLMStreamChunk, 'type'>): boolean =>
  safeSend(port, { type: 'LLM_STREAM_CHUNK', ...chunk });

const sendEnd = (port: chrome.runtime.Port, end: Omit<LLMStreamEnd, 'type'>): boolean =>
  safeSend(port, { type: 'LLM_STREAM_END', ...end });

const sendStepFinish = (port: chrome.runtime.Port, step: Omit<LLMStepFinish, 'type'>): boolean =>
  safeSend(port, { type: 'LLM_STEP_FINISH', ...step });

const sendError = (port: chrome.runtime.Port, chatId: string, error: string): boolean =>
  safeSend(port, { type: 'LLM_STREAM_ERROR', chatId, error });

/** Non-blocking TTS synthesis for browser chat UI auto-play (chunked streaming). */
const maybeSendTtsAudio = async (
  port: chrome.runtime.Port,
  chatId: string,
  responseText: string,
  modelConfig: Parameters<typeof chatModelToPiModel>[0],
): Promise<void> => {
  try {
    const { ttsConfigStorage } = await import('@extension/storage');
    const ttsConfig = await ttsConfigStorage.get();
    if (ttsConfig.engine === 'off' || !ttsConfig.chatUiAutoPlay) return;

    const { maybeApplyTtsStreaming } = await import('../tts');
    const { arrayBufferToBase64 } = await import('../tts/providers/kokoro-bridge');

    await maybeApplyTtsStreaming({
      text: responseText,
      config: ttsConfig,
      inboundHadAudio: false,
      modelConfig,
      onChunk: chunk => {
        const msg: LLMTtsAudio = {
          type: 'LLM_TTS_AUDIO',
          chatId,
          audioBase64: arrayBufferToBase64(chunk.audio),
          contentType: chunk.contentType,
          provider: chunk.provider,
          chunkIndex: chunk.chunkIndex,
          isLastChunk: false,
        };
        port.postMessage(msg);
      },
      onComplete: () => {
        const sentinel: LLMTtsAudio = {
          type: 'LLM_TTS_AUDIO',
          chatId,
          audioBase64: '',
          contentType: '',
          provider: '',
          isLastChunk: true,
        };
        port.postMessage(sentinel);
      },
    });
  } catch {
    // TTS failure is non-fatal — text response already delivered
  }
};

const handleLLMStream = async (
  port: chrome.runtime.Port,
  request: LLMRequestMessage,
): Promise<void> => {
  const { chatId, messages, model: modelConfig, assistantMessageId } = request;
  const assistantParts: ChatMessagePart[] = [];

  streamLog.info('Stream started', { chatId, model: modelConfig.id });
  streamLog.trace('Stream request detail', {
    chatId,
    modelId: modelConfig.id,
    provider: modelConfig.provider,
    messageCount: messages.length,
  });

  try {
    // Sanitize and convert messages to pi-mono format (UI-specific)
    const sanitizedMessages = sanitizeHistory(messages, modelConfig.provider as ModelProvider);
    const piMessages = chatMessagesToPiMessages(sanitizedMessages);

    const history = piMessages.slice(0, -1);
    const prompt = piMessages[piMessages.length - 1];

    if (!prompt) {
      sendError(port, chatId, 'No messages to send');
      return;
    }

    // Compaction pipeline (UI-specific)
    let currentAgentId: string | undefined;
    try {
      const id = await activeAgentStorage.get();
      currentAgentId = id || undefined;
    } catch {
      // activeAgentStorage may not be available in test context
    }

    // Build a fresh system prompt from workspace files/skills/tools each turn
    // so that writes to MEMORY.md (or any workspace file) are reflected immediately.
    const freshSystemPrompt = await buildHeadlessSystemPrompt(modelConfig, currentAgentId);
    const freshSystemPromptTokens = Math.ceil(freshSystemPrompt.length / 4);
    streamLog.trace('Fresh system prompt built', {
      chatId,
      systemPromptLength: freshSystemPrompt.length,
      systemPromptTokens: freshSystemPromptTokens,
      agentId: currentAgentId,
    });

    const { transformContext, getResult: getCompactionResult, setProviderLimit } =
      createTransformContext({
        chatId,
        modelConfig,
        systemPromptTokens: freshSystemPromptTokens,
        agentId: currentAgentId,
      });

    // Wrap transformContext to notify UI when compaction starts
    let compactionNotified = false;
    const notifyingTransformContext: typeof transformContext = async (msgs, signal) => {
      if (!compactionNotified) {
        compactionNotified = true;
        safeSend(port, {
          type: 'LLM_STREAM_RETRY',
          chatId,
          attempt: 0,
          maxAttempts: 1,
          reason: 'Compacting conversation context...',
          strategy: 'compaction',
        } satisfies LLMStreamRetry);
      }
      return transformContext(msgs, signal);
    };

    // Pre-turn memory flush agent-based
    await runMemoryFlushIfNeeded({
      chatId,
      modelConfig,
      systemPrompt: freshSystemPrompt,
      systemPromptTokens: freshSystemPromptTokens,
    });

    // Track per-step usage for UI and TTS
    let accInputTokens = 0;
    let accOutputTokens = 0;
    let lastInputTokens = 0;
    let lastOutputTokens = 0;
    let lastResponseText = '';
    let ttsEndPromise: Promise<void> | undefined;

    await runAgent({
      model: modelConfig,
      systemPrompt: freshSystemPrompt,
      prompt,
      messages: history,
      convertToLlm: makeConvertToLlm(modelConfig),
      transformContext: notifyingTransformContext,
      chatId,
      onProviderLimitDetected: setProviderLimit,
      onRetry: info => {
        // Reset accumulated parts on retry — the stream restarts fresh
        assistantParts.length = 0;
        safeSend(port, {
          type: 'LLM_STREAM_RETRY',
          chatId,
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          reason: info.reason,
          strategy: info.strategy,
        });
      },
      onTextDelta: delta => {
        // Accumulate text part (merge contiguous text deltas)
        const last = assistantParts[assistantParts.length - 1];
        if (last && last.type === 'text') {
          (last as { type: 'text'; text: string }).text += delta;
        } else {
          assistantParts.push({ type: 'text', text: delta });
        }
        sendChunk(port, { chatId, delta });
      },
      onReasoningDelta: delta => {
        // Accumulate reasoning part (merge contiguous reasoning deltas)
        const last = assistantParts[assistantParts.length - 1];
        if (last && last.type === 'reasoning') {
          (last as { type: 'reasoning'; text: string }).text += delta;
        } else {
          assistantParts.push({ type: 'reasoning', text: delta });
        }
        sendChunk(port, { chatId, reasoning: delta });
      },
      onToolCallEnd: tc => {
        streamLog.info('Tool call', { toolName: tc.name, toolCallId: tc.id });
        assistantParts.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.args,
          state: 'input-available',
        });
        sendChunk(port, { chatId, toolCall: tc, state: 'input-available' });
      },
      onToolResult: tr => {
        // Save document artifacts to IndexedDB
        if (!tr.isError && tr.details && tr.toolName === 'create_document') {
          const d = tr.details as { id: string; title?: string; kind?: string; content?: string };
          if (d.id && d.content) {
            const now = Date.now();
            saveArtifact({
              id: d.id,
              chatId,
              title: d.title ?? 'Untitled',
              kind: (d.kind ?? 'text') as DbArtifact['kind'],
              content: d.content,
              createdAt: now,
              updatedAt: now,
            }).catch(() => {}); // non-blocking
          }
        }
        // Accumulate: update matching tool-call part with result
        const tcPart = assistantParts.find(
          p => p.type === 'tool-call' && p.toolCallId === tr.toolCallId,
        );
        if (tcPart && tcPart.type === 'tool-call') {
          (tcPart as { result?: unknown; state?: string }).result = tr.result;
          (tcPart as { state?: string }).state = tr.isError ? 'output-error' : 'output-available';
        }
        // Append image file parts from tool result (e.g. screenshots)
        if (tr.images?.length) {
          for (let i = 0; i < tr.images.length; i++) {
            assistantParts.push({
              type: 'file',
              url: '',
              filename: `tool-image-${tr.toolCallId}-${i}.jpg`,
              mediaType: tr.images[i].mimeType,
              data: tr.images[i].data,
            });
          }
        }

        sendChunk(port, {
          chatId,
          toolResult: {
            id: tr.toolCallId,
            result: tr.result,
            files: tr.images?.map((img, i) => ({
              data: img.data,
              mimeType: img.mimeType,
              filename: `tool-image-${tr.toolCallId}-${i}.jpg`,
            })),
          },
          state: tr.isError ? 'output-error' : 'output-available',
        });
      },
      onTurnEnd: info => {
        const msg = info.message;
        if (msg.role === 'assistant') {
          const assistantMsg = msg as AssistantMessage;
          // Attach thinkingSignature to accumulated reasoning parts
          let reasoningIdx = 0;
          for (const c of assistantMsg.content) {
            if (c.type === 'thinking' && c.thinkingSignature) {
              while (reasoningIdx < assistantParts.length) {
                const part = assistantParts[reasoningIdx];
                if (part.type === 'reasoning') {
                  (part as { signature?: string }).signature = c.thinkingSignature;
                  reasoningIdx++;
                  break;
                }
                reasoningIdx++;
              }
            }
          }
          if (assistantMsg.usage) {
            lastInputTokens = assistantMsg.usage.input;
            lastOutputTokens = assistantMsg.usage.output;
          }
          for (const c of assistantMsg.content) {
            if (c.type === 'text' && c.text) lastResponseText = c.text;
          }
        }
        accInputTokens = info.usage.input;
        accOutputTokens = info.usage.output;

        sendStepFinish(port, {
          chatId,
          stepNumber: info.stepCount,
          usage: {
            promptTokens: lastInputTokens,
            completionTokens: lastOutputTokens,
            totalTokens: lastInputTokens + lastOutputTokens,
          },
        });
      },
      onAgentEnd: info => {
        const agentError = info.agent.state.error;
        // Timeout is a graceful end, not an error — fall through to normal completion
        if (agentError && !info.timedOut) {
          streamLog.warn('Agent error', { chatId, error: agentError, steps: info.stepCount });
          sendError(port, chatId, agentError);
          return;
        }

        // Derive finishReason from last assistant message's stopReason
        const lastAssistant = info.messages
          .filter((m): m is AssistantMessage => m.role === 'assistant')
          .pop();
        let finishReason = 'stop';
        if (info.timedOut) finishReason = 'timeout';
        else if (lastAssistant?.stopReason === 'length') finishReason = 'length';

        const compactionResult = getCompactionResult();
        streamLog.info('Stream complete', {
          chatId,
          steps: info.stepCount,
          finishReason,
          timedOut: info.timedOut,
        });
        streamLog.trace('Stream end detail', {
          chatId,
          accUsage: { input: accInputTokens, output: accOutputTokens },
          lastStepUsage: { input: lastInputTokens, output: lastOutputTokens },
          compaction: compactionResult,
          responseTextLength: lastResponseText.length,
        });

        // TTS auto-play: send chunks BEFORE sendEnd so port is still alive
        const sendEndPayload = {
          chatId,
          finishReason,
          usage: {
            promptTokens: accInputTokens,
            completionTokens: accOutputTokens,
            totalTokens: accInputTokens + accOutputTokens,
          },
          contextUsage: {
            promptTokens: lastInputTokens,
            completionTokens: lastOutputTokens,
            totalTokens: lastInputTokens + lastOutputTokens,
          },
          wasCompacted: compactionResult.wasCompacted,
          compactionMethod: compactionResult.compactionMethod as
            | 'summary'
            | 'sliding-window'
            | 'none'
            | undefined,
          compactionTokensBefore: compactionResult.tokensBefore,
          compactionTokensAfter: compactionResult.tokensAfter,
          compactionDurationMs: compactionResult.durationMs,
          persistedByBackground: true,
        };

        if (lastResponseText) {
          ttsEndPromise = maybeSendTtsAudio(port, chatId, lastResponseText, modelConfig)
            .then(() => {
              sendEnd(port, sendEndPayload);
            })
            .catch(() => {
              sendEnd(port, sendEndPayload);
            });
        } else {
          sendEnd(port, sendEndPayload);
        }
      },
    });

    // Await any pending TTS + sendEnd from the onAgentEnd handler
    if (ttsEndPromise) await ttsEndPromise;

    // Persist the assistant message from the background SW so it survives
    // agent switches / extension reloads that may kill the frontend callback chain.
    if (assistantParts.length > 0 && assistantMessageId) {
      try {
        const { addMessage, touchChat } = await import('@extension/storage');
        await addMessage({
          id: assistantMessageId,
          chatId,
          role: 'assistant',
          parts: assistantParts,
          createdAt: Date.now(),
          model: modelConfig.id,
        });
        await touchChat(chatId);
      } catch (persistErr) {
        streamLog.warn('Failed to persist assistant message from background', {
          chatId,
          error: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    streamLog.error('Stream error', { chatId, error: errorMsg });
    sendError(port, chatId, errorMsg);

    // Persist partial assistant message on error so it's not lost on reload
    if (assistantParts.length > 0 && assistantMessageId) {
      try {
        const { addMessage, touchChat } = await import('@extension/storage');
        await addMessage({
          id: assistantMessageId,
          chatId,
          role: 'assistant',
          parts: assistantParts,
          createdAt: Date.now(),
          model: modelConfig.id,
        });
        await touchChat(chatId);
      } catch {
        // Best-effort — already in error path
      }
    }
  }
};

export { handleLLMStream };
