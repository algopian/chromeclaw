import type { ChatMessage, ChatMessagePart, ModelProvider } from '@extension/shared';

// ── Shared Helpers ──────────────────────────────

/**
 * Merge consecutive messages with the same role into a single message.
 */
const mergeConsecutiveSameRole = (messages: ChatMessage[]): ChatMessage[] => {
  if (messages.length <= 1) return messages;

  const result: ChatMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    if (prev.role === curr.role) {
      // Merge parts into previous message
      result[result.length - 1] = {
        ...prev,
        parts: [...prev.parts, ...curr.parts],
      };
    } else {
      result.push(curr);
    }
  }

  return result;
};

/**
 * Enforce strict user/assistant alternation by inserting synthetic messages.
 */
const enforceAlternation = (messages: ChatMessage[]): ChatMessage[] => {
  if (messages.length === 0) return messages;

  const result: ChatMessage[] = [];

  // Ensure first message is user
  if (messages[0].role !== 'user') {
    result.push({
      id: '__synthetic_user',
      chatId: messages[0].chatId,
      role: 'user',
      parts: [{ type: 'text', text: 'Continue.' }],
      createdAt: messages[0].createdAt - 1,
    });
  }

  for (const msg of messages) {
    const prev = result[result.length - 1];

    if (prev && prev.role === msg.role) {
      // Same role consecutive — merge
      result[result.length - 1] = {
        ...prev,
        parts: [...prev.parts, ...msg.parts],
      };
    } else if (prev && prev.role === 'user' && msg.role === 'user') {
      // Already handled by merge above
      result[result.length - 1] = {
        ...prev,
        parts: [...prev.parts, ...msg.parts],
      };
    } else {
      result.push(msg);
    }
  }

  return result;
};

/**
 * Ensure every tool-call in assistant messages has a matching tool-result.
 * If a tool-call has no result, inject a synthetic error result.
 */
const repairToolResultPairing = (messages: ChatMessage[]): ChatMessage[] => {
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant') {
      result.push(msg);
      continue;
    }

    const toolCalls = msg.parts.filter(
      (p): p is Extract<ChatMessagePart, { type: 'tool-call' }> => p.type === 'tool-call',
    );
    const toolResults = msg.parts.filter(
      (p): p is Extract<ChatMessagePart, { type: 'tool-result' }> => p.type === 'tool-result',
    );

    if (toolCalls.length === 0) {
      result.push(msg);
      continue;
    }

    // Check each tool-call has a matching tool-result
    const resultIds = new Set(toolResults.map(r => r.toolCallId));
    const missingResults: ChatMessagePart[] = [];

    for (const tc of toolCalls) {
      if (!resultIds.has(tc.toolCallId)) {
        // The UI stores tool results merged into the tool-call part's `result` field.
        // Extract that into a proper tool-result part instead of injecting a synthetic error.
        if (tc.result != null) {
          missingResults.push({
            type: 'tool-result',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: tc.result,
          });
        } else {
          missingResults.push({
            type: 'tool-result',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: { error: 'Tool execution was interrupted or unavailable.' },
          });
        }
      }
    }

    if (missingResults.length > 0) {
      result.push({
        ...msg,
        parts: [...msg.parts, ...missingResults],
      });
    } else {
      result.push(msg);
    }
  }

  return result;
};

// ── Anthropic Rules ─────────────────────────────

const sanitizeForAnthropic = (messages: ChatMessage[]): ChatMessage[] => {
  let result = [...messages];

  // Rule 1: First message must be user role
  if (result.length > 0 && result[0].role !== 'user') {
    result = [
      {
        id: '__synthetic_user',
        chatId: result[0].chatId,
        role: 'user',
        parts: [{ type: 'text', text: 'Continue.' }],
        createdAt: result[0].createdAt - 1,
      },
      ...result,
    ];
  }

  // Rule 2: No consecutive same-role messages — merge adjacent
  result = mergeConsecutiveSameRole(result);

  // Rule 3: Tool result pairing — ensure every tool-call has a matching tool-result
  result = repairToolResultPairing(result);

  return result;
};

// ── Gemini Rules ────────────────────────────────

const sanitizeForGemini = (messages: ChatMessage[]): ChatMessage[] => {
  // Rule 1: No system role messages in history
  let result = messages.filter(m => m.role !== 'system');

  // Rule 2: Strict user/assistant alternation
  result = enforceAlternation(result);

  // Rule 3: Tool result pairing repair
  result = repairToolResultPairing(result);

  return result;
};

// ── OpenAI Rules (minimal) ──────────────────────

const sanitizeForOpenAI = (messages: ChatMessage[]): ChatMessage[] =>
  // Only tool result pairing repair needed
  repairToolResultPairing(messages);

/**
 * Sanitize message history per provider before sending to LLM.
 * Applies provider-specific rules to ensure valid message sequences.
 */
const sanitizeHistory = (messages: ChatMessage[], provider: ModelProvider): ChatMessage[] => {
  switch (provider) {
    case 'anthropic':
      return sanitizeForAnthropic(messages);
    case 'google':
      return sanitizeForGemini(messages);
    case 'openai':
    case 'openrouter':
    case 'custom':
    case 'azure':
    case 'openai-codex':
    case 'web':
    default:
      return sanitizeForOpenAI(messages);
  }
};

export { sanitizeHistory };
