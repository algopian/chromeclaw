/**
 * Converts extension ChatMessage[] to/from pi-mono Message[].
 */

import { sanitizeTranscript } from '../context/transcript-sanitization';
import type { ChatMessage, ChatMessagePart, ChatModel } from '@extension/shared';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Message } from '@mariozechner/pi-ai';

/**
 * Convert extension ChatMessage[] to pi-mono Message[] for loading into Agent.
 */
export const chatMessagesToPiMessages = (messages: ChatMessage[]): Message[] => {
  const result: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // System messages are handled via Agent's systemPrompt, skip in message history
      continue;
    }

    if (msg.role === 'user') {
      const fileParts = msg.parts.filter(
        (p): p is Extract<ChatMessagePart, { type: 'file' }> => p.type === 'file',
      );

      const textContent = msg.parts
        .filter((p): p is Extract<ChatMessagePart, { type: 'text' }> => p.type === 'text')
        .map(p => p.text)
        .join('');

      if (fileParts.length > 0) {
        const content: Array<
          { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        > = [];

        for (const fp of fileParts) {
          const data = fp.data || fp.url;
          if (fp.mediaType?.startsWith('image/') && data) {
            content.push({ type: 'image', data, mimeType: fp.mediaType });
          }
        }

        if (textContent) {
          content.push({ type: 'text', text: textContent });
        }

        result.push({
          role: 'user',
          content,
          timestamp: msg.createdAt,
        });
      } else {
        result.push({
          role: 'user',
          content: textContent || '',
          timestamp: msg.createdAt,
        });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const assistantContent: Array<
        | { type: 'text'; text: string }
        | { type: 'thinking'; thinking: string }
        | { type: 'toolCall'; id: string; name: string; arguments: Record<string, any> }
      > = [];

      const toolResults: Array<{
        toolCallId: string;
        toolName: string;
        result: unknown;
        isError: boolean;
      }> = [];

      for (const part of msg.parts) {
        if (part.type === 'text') {
          assistantContent.push({ type: 'text', text: part.text });
        } else if (part.type === 'reasoning') {
          assistantContent.push({
            type: 'thinking',
            thinking: part.text,
            ...(part.signature ? { thinkingSignature: part.signature } : {}),
          });
        } else if (part.type === 'tool-call') {
          assistantContent.push({
            type: 'toolCall',
            id: part.toolCallId,
            name: part.toolName,
            arguments: part.args as Record<string, any>,
          });
        } else if (part.type === 'tool-result') {
          toolResults.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: part.result,
            isError: part.state === 'output-error',
          });
        }
      }

      // Only push assistant message if it has content
      if (assistantContent.length > 0) {
        result.push({
          role: 'assistant',
          content: assistantContent,
          api: 'openai-completions', // Placeholder — not used for history replay
          provider: 'openai',
          model: msg.model || 'unknown',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: msg.createdAt,
        });
      }

      // Add tool results as separate messages, preserving image content blocks
      for (const tr of toolResults) {
        const resultText = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
        const content: Array<
          { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        > = [{ type: 'text', text: resultText }];

        // Reconstruct ImageContent from associated file parts (tool-image-{toolCallId})
        const associatedImages = msg.parts.filter(
          (p): p is Extract<ChatMessagePart, { type: 'file' }> =>
            p.type === 'file' &&
            p.filename?.startsWith(`tool-image-${tr.toolCallId}`) === true &&
            p.data != null,
        );
        for (const img of associatedImages) {
          content.push({
            type: 'image',
            data: img.data!,
            mimeType: img.mediaType ?? 'image/jpeg',
          });
        }

        result.push({
          role: 'toolResult',
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          content,
          isError: tr.isError,
          timestamp: msg.createdAt,
        });
      }
    }
  }

  return result;
};

/**
 * The convertToLlm callback for the Agent constructor.
 * filter to LLM-compatible message roles.
 */
export const convertToLlm = (messages: AgentMessage[]): Message[] =>
  messages.filter(
    (m): m is Message => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
  );

/**
 * Factory that wraps convertToLlm with provider-specific transcript sanitization.
 * Sanitization runs at the AgentMessage level (after conversion from ChatMessage)
 * so it can operate on pi-mono fields like `thinkingSignature` and `|fc_*` tool call IDs.
 */
export const makeConvertToLlm =
  (model: ChatModel) =>
  (messages: AgentMessage[]): Message[] => {
    const filtered = convertToLlm(messages);
    return sanitizeTranscript(filtered as AgentMessage[], model) as Message[];
  };
