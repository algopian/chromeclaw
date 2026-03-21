/**
 * transformContext wrapper for Agent constructor.
 * Wraps the existing compaction pipeline as a pi-mono transformContext hook.
 */

import { compactMessages, compactMessagesWithSummary, estimateMessageTokens } from './compaction';
import { enforceToolResultBudget } from './tool-result-context-guard';
import { chatMessagesToPiMessages } from '../agents/message-adapter';
import { createLogger } from '../logging/logger-buffer';
import { updateCompactionSummary, incrementCompactionCount, updateCompactionMetadata, getChat, getAgent, getEnabledWorkspaceFiles } from '@extension/storage';
import { extractCriticalRules } from './summarizer';
import type { AgentMessage, ImageContent } from '../agents';
import type { ChatModel, ChatMessage, ChatMessagePart } from '@extension/shared';

const compactLog = createLogger('stream');

interface TransformContextOpts {
  chatId: string;
  modelConfig: ChatModel;
  systemPromptTokens: number;
  agentId?: string;
}

/**
 * Result metadata from the last transform (used to communicate compaction status
 * back to the caller via closure).
 */
interface TransformResult {
  wasCompacted: boolean;
  compactionMethod?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  durationMs?: number;
}

/**
 * Creates a transformContext function for the Agent constructor.
 * Also returns a ref to the transform result so the caller can check
 * whether compaction occurred after the run.
 */
const createTransformContext = (
  opts: TransformContextOpts,
): {
  transformContext: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getResult: () => TransformResult;
  /** Lower the effective context window (e.g. when a proxy reports a smaller limit than the model). */
  setProviderLimit: (limit: number) => void;
} => {
  const result: TransformResult = { wasCompacted: false };
  let providerLimit: number | undefined;

  // Max summary compaction attempts per stream.
  // After this limit, fall back to sliding-window only (no LLM summarization) to prevent
  // infinite compaction loops where each summary loses task context.
  let summaryCompactionAttempts = 0;
  const MAX_SUMMARY_COMPACTION_ATTEMPTS = 3;

  const transformContext = async (
    messages: AgentMessage[],
    _signal?: AbortSignal,
  ): Promise<AgentMessage[]> => {
    // Convert AgentMessage[] → ChatMessage[] for the existing compaction API
    const chatMessages = agentMessagesToChatMessages(messages, opts.chatId);

    // Load chat record for compaction context
    const chatRecord = await getChat(opts.chatId);
    const existingSummary = chatRecord?.compactionSummary;

    // Use the lower of model contextWindow and detected provider limit
    const effectiveContextWindow =
      providerLimit && opts.modelConfig.contextWindow
        ? Math.min(providerLimit, opts.modelConfig.contextWindow)
        : providerLimit ?? opts.modelConfig.contextWindow;

    compactLog.trace('transformContext: effective limits', {
      providerLimit,
      modelContextWindow: opts.modelConfig.contextWindow,
      effectiveContextWindow,
    });

    // Load workspace files and extract critical rules for compaction
    const workspaceFiles = opts.agentId ? await getEnabledWorkspaceFiles(opts.agentId) : [];
    const criticalRules = extractCriticalRules(workspaceFiles);

    // Load agent's compaction config (if any)
    const agentConfig = opts.agentId ? await getAgent(opts.agentId) : undefined;
    const compactionConfig = agentConfig?.compactionConfig;

    // Pre-compaction: enforce tool result budget to prevent massive results from reaching compaction
    const guardedMessages = enforceToolResultBudget(chatMessages, opts.modelConfig.id, effectiveContextWindow);

    // Estimate tokens before compaction
    const tokensBefore = guardedMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

    // Run compaction — use sliding-window only after exhausting summary attempts
    // (3-tier overflow recovery pattern)
    const useSlidingWindowOnly = summaryCompactionAttempts >= MAX_SUMMARY_COMPACTION_ATTEMPTS;

    if (useSlidingWindowOnly) {
      compactLog.trace('transformContext: summary compaction limit reached, using sliding-window only', {
        summaryCompactionAttempts,
        maxAttempts: MAX_SUMMARY_COMPACTION_ATTEMPTS,
      });
    }

    const {
      messages: compactedMessages,
      wasCompacted,
      compactionMethod,
      summary,
      durationMs: compactionDurationMs,
    } = useSlidingWindowOnly
      ? compactMessages(guardedMessages, opts.modelConfig.id, opts.systemPromptTokens, effectiveContextWindow)
      : await compactMessagesWithSummary(guardedMessages, opts.modelConfig.id, opts.modelConfig, {
          systemPromptTokens: opts.systemPromptTokens,
          existingSummary,
          contextWindowOverride: effectiveContextWindow,
          criticalRules,
          compactionConfig,
        });

    // Track summary compaction attempts
    if (wasCompacted && compactionMethod === 'summary') {
      summaryCompactionAttempts++;
    }

    compactLog.debug('Compaction', { method: compactionMethod, wasCompacted });

    // Persist summary and increment compaction count
    if (summary) {
      updateCompactionSummary(opts.chatId, summary).catch(console.error);
    }
    const tokensAfter = wasCompacted
      ? compactedMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
      : undefined;

    if (wasCompacted) {
      incrementCompactionCount(opts.chatId).catch(console.error);

      // Persist compaction metadata for observability
      updateCompactionMetadata(opts.chatId, {
        compactionTokensBefore: tokensBefore,
        compactionTokensAfter: tokensAfter!,
        compactionMethod: compactionMethod as 'summary' | 'sliding-window' | 'adaptive' | 'none',
      }).catch(console.error);
    }

    // Update result for caller
    result.wasCompacted = wasCompacted;
    result.compactionMethod = compactionMethod;
    result.tokensBefore = tokensBefore;
    result.tokensAfter = tokensAfter;
    result.durationMs = compactionDurationMs;

    // Convert back to AgentMessage[] (pi-mono Message[])
    return chatMessagesToPiMessages(compactedMessages);
  };

  return {
    transformContext,
    getResult: () => result,
    setProviderLimit: (limit: number) => { providerLimit = limit; },
  };
};

/**
 * Convert AgentMessage[] (pi-mono) → ChatMessage[] (extension) for compaction.
 * This is the reverse of chatMessagesToPiMessages.
 */
const agentMessagesToChatMessages = (messages: AgentMessage[], chatId: string): ChatMessage[] => {
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const parts: ChatMessagePart[] = [];

      if (typeof msg.content === 'string') {
        parts.push({ type: 'text', text: msg.content });
      } else {
        for (const c of msg.content) {
          if (c.type === 'text') {
            parts.push({ type: 'text', text: c.text });
          } else if (c.type === 'image') {
            parts.push({
              type: 'file',
              url: c.data,
              filename: 'image',
              mediaType: c.mimeType,
              data: c.data,
            });
          }
        }
      }

      result.push({
        id: `msg-${msg.timestamp}`,
        chatId,
        role: 'user',
        parts,
        createdAt: msg.timestamp,
      });
    } else if (msg.role === 'assistant') {
      const parts: ChatMessagePart[] = [];

      for (const c of msg.content) {
        if (c.type === 'text') {
          parts.push({ type: 'text', text: c.text });
        } else if (c.type === 'thinking') {
          parts.push({
            type: 'reasoning',
            text: c.thinking,
            ...(c.thinkingSignature ? { signature: c.thinkingSignature } : {}),
          });
        } else if (c.type === 'toolCall') {
          parts.push({
            type: 'tool-call',
            toolCallId: c.id,
            toolName: c.name,
            args: c.arguments,
            state: 'output-available',
          });
        }
      }

      result.push({
        id: `msg-${msg.timestamp}`,
        chatId,
        role: 'assistant',
        parts,
        createdAt: msg.timestamp,
        model: msg.model,
      });
    } else if (msg.role === 'toolResult') {
      // Tool results get merged back into the preceding assistant message's parts
      // Find the last assistant message and append the tool result
      const lastAssistant = [...result].reverse().find(m => m.role === 'assistant');
      if (lastAssistant) {
        const resultText = msg.content
          .filter(c => c.type === 'text')
          .map(c => (c as { text: string }).text)
          .join('');
        let resultValue: unknown;
        try {
          resultValue = JSON.parse(resultText);
        } catch {
          resultValue = resultText;
        }
        lastAssistant.parts.push({
          type: 'tool-result',
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          result: resultValue,
          state: msg.isError ? 'output-error' : 'output-available',
        });

        // Convert ImageContent blocks to file parts for persistence + UI rendering
        const imageContent = msg.content.filter((c): c is ImageContent => c.type === 'image');
        for (let i = 0; i < imageContent.length; i++) {
          lastAssistant.parts.push({
            type: 'file',
            url: '',
            filename: `tool-image-${msg.toolCallId}-${i}.jpg`,
            mediaType: imageContent[i]!.mimeType,
            data: imageContent[i]!.data,
          });
        }
      }
    }
  }

  return result;
};

export { createTransformContext };
export type { TransformContextOpts, TransformResult };
