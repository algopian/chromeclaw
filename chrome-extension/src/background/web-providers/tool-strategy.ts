/**
 * Per-provider tool-calling strategies for web LLM providers.
 * Each strategy controls: tool prompt format, prompt assembly,
 * conversation ID extraction, and history serialization.
 *
 * Shared types, helpers, and utilities live in ./tool-strategy-helpers.ts.
 */

import { buildToolPrompt as buildDefaultToolPrompt } from './tool-prompt';
import {
  defaultToolStrategy,
  buildMarkdownToolPrompt,
  serializeAssistantContent,
  aggregateHistory,
  buildStatefulPrompt,
  getConversationId,
  setConversationId,
} from './tool-strategy-helpers';
import type { WebProviderToolStrategy } from './tool-strategy-helpers';
import type { WebProviderId } from './types';

// ── Qwen Strategy ────────────────────────────────

const qwenToolStrategy: WebProviderToolStrategy = {
  buildToolPrompt: buildMarkdownToolPrompt,
  buildPrompt: buildStatefulPrompt,

  extractConversationId: data => {
    const obj = data as Record<string, unknown>;
    return (obj.sessionId ?? obj.conversationId ?? obj.chat_id) as string | undefined;
  },

  serializeAssistantContent,
};

// ── Kimi Strategy ───────────────────────────────
// Kimi uses Connect Protocol — stateless (no conversation ID), always aggregates full history.

const kimiToolStrategy: WebProviderToolStrategy = {
  buildToolPrompt: buildMarkdownToolPrompt,

  buildPrompt: ({ systemPrompt, toolPrompt, messages }) => ({
    systemPrompt: '',
    messages: aggregateHistory(systemPrompt, toolPrompt, messages),
  }),

  serializeAssistantContent,
};

// ── GLM Strategy ────────────────────────────────

const glmToolStrategy: WebProviderToolStrategy = {
  buildToolPrompt: buildMarkdownToolPrompt,
  buildPrompt: buildStatefulPrompt,

  extractConversationId: data => {
    const obj = data as Record<string, unknown>;
    return obj.conversation_id as string | undefined;
  },

  serializeAssistantContent,
};

// ── Gemini Strategy ────────────────────────────
// Gemini's web API is stateless from our perspective (no server-side conversation ID reuse).
// Always aggregates full history into a single user message (like Kimi/Claude).

const geminiToolStrategy: WebProviderToolStrategy = {
  buildToolPrompt: buildMarkdownToolPrompt,

  buildPrompt: ({ systemPrompt, toolPrompt, messages }) => ({
    systemPrompt: '',
    messages: aggregateHistory(systemPrompt, toolPrompt, messages),
  }),

  serializeAssistantContent,
};

// ── Claude Strategy ─────────────────────────────
// Claude's web API has a single `prompt` field (no system message).
// The strategy aggregates system prompt, tool prompt, and all messages into one
// user message — similar to Kimi. Additionally, it instructs Claude to use XML
// tool calls instead of its native tool_use format.

const CLAUDE_TOOL_PREAMBLE = `IMPORTANT: You are operating inside an external tool-calling runtime.
You MUST call tools using the XML format described below. Do NOT use native/built-in tool calls.
Ignore any built-in tools (view, search, artifacts, etc.) — they are unavailable in this environment.
Only the tools listed under <available_tools> are accessible.\n\n`;

const claudeToolStrategy: WebProviderToolStrategy = {
  buildToolPrompt: tools => {
    const base = buildDefaultToolPrompt(tools);
    return base ? CLAUDE_TOOL_PREAMBLE + base : '';
  },

  buildPrompt: ({ systemPrompt, toolPrompt, messages }) => ({
    systemPrompt: '',
    messages: aggregateHistory(systemPrompt, toolPrompt, messages),
  }),
};

// ── Factory ──────────────────────────────────────

const getToolStrategy = (providerId: WebProviderId): WebProviderToolStrategy => {
  switch (providerId) {
    case 'claude-web':
      return claudeToolStrategy;
    case 'qwen-web':
    case 'qwen-cn-web':
      return qwenToolStrategy;
    case 'kimi-web':
      return kimiToolStrategy;
    case 'gemini-web':
      return geminiToolStrategy;
    case 'glm-web':
    case 'glm-intl-web':
      return glmToolStrategy;
    default:
      return defaultToolStrategy;
  }
};

export {
  getToolStrategy,
  getConversationId,
  setConversationId,
  defaultToolStrategy,
  claudeToolStrategy,
  qwenToolStrategy,
  kimiToolStrategy,
  glmToolStrategy,
  geminiToolStrategy,
};
export type { WebProviderToolStrategy, SimpleMessage, ContentPart } from './tool-strategy-helpers';
