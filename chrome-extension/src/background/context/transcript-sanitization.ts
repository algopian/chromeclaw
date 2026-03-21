/**
 * Orchestrates transcript sanitization based on model config.
 *
 * Composes provider-specific sanitization passes:
 * - OpenAI Responses/Codex API: fix reasoning block + function_call pairing issues
 * - Non-Anthropic providers: drop thinking blocks entirely
 * - Anthropic: no-op (native thinking support)
 */

import {
  downgradeOpenAIReasoningBlocks,
  downgradeOpenAIFunctionCallReasoningPairs,
} from './openai-reasoning-sanitization';
import { dropThinkingBlocks } from './thinking-sanitization';
import type { ChatModel } from '@extension/shared';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

/**
 * Apply transcript sanitization appropriate for the target model/provider.
 *
 * Decision matrix:
 * | Provider/API                    | Gap 1+2 (OpenAI reasoning) | Gap 3 (drop thinking) |
 * |---------------------------------|----------------------------|-----------------------|
 * | OpenAI + openai-responses       | Yes                        | No (supported)        |
 * | OpenAI + openai-codex-responses | Yes                        | No (supported)        |
 * | OpenAI + openai-completions     | No                         | Yes                   |
 * | Anthropic                       | No                         | No (native support)   |
 * | Google                          | No                         | Yes                   |
 * | OpenRouter                      | No                         | Yes                   |
 * | Custom / Local                  | No                         | Yes                   |
 */
export const sanitizeTranscript = (messages: AgentMessage[], model: ChatModel): AgentMessage[] => {
  const api = model.api;
  const isResponsesApi =
    api === 'openai-responses' ||
    api === 'openai-codex-responses' ||
    api === 'azure-openai-responses';

  if (isResponsesApi) {
    // Gap 1 + Gap 2: fix reasoning/function_call pairing issues
    return downgradeOpenAIFunctionCallReasoningPairs(downgradeOpenAIReasoningBlocks(messages));
  }

  // Gap 3: providers that don't support thinking blocks
  // Anthropic supports them natively; everything else doesn't.
  if (model.provider !== 'anthropic') {
    return dropThinkingBlocks(messages);
  }

  return messages;
};
