/**
 * Per-provider tool-calling strategies for web LLM providers.
 * Each strategy controls: tool prompt format, prompt assembly,
 * conversation ID extraction, and history serialization.
 */

import { buildToolPrompt as buildDefaultToolPrompt } from './tool-prompt';
import type { ToolDef } from './tool-prompt';
import type { WebProviderId } from './types';

interface SimpleMessage {
  role: string;
  content: string;
}

interface ContentPart {
  type: 'text' | 'thinking' | 'toolCall';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface WebProviderToolStrategy {
  /** Build the tool prompt section. */
  buildToolPrompt(tools: ToolDef[]): string;

  /**
   * Build the final system prompt and messages to pass to the provider's buildRequest().
   * Strategy controls how system prompt, tool prompt, and messages are combined.
   */
  buildPrompt(opts: {
    systemPrompt: string;
    toolPrompt: string;
    messages: SimpleMessage[];
    conversationId?: string;
  }): { systemPrompt: string; messages: SimpleMessage[] };

  /** Extract conversation/session ID from SSE response data. */
  extractConversationId?(data: unknown): string | undefined;

  /** Serialize assistant message content parts to string for history. */
  serializeAssistantContent?(content: ContentPart[]): string;
}

// ── Conversation ID Cache ────────────────────────

const CONVERSATION_ID_CACHE_MAX = 100;
const conversationIdCache = new Map<string, string>();

const getConversationId = (key: string): string | undefined => conversationIdCache.get(key);

const setConversationId = (key: string, id: string): void => {
  if (conversationIdCache.size >= CONVERSATION_ID_CACHE_MAX && !conversationIdCache.has(key)) {
    const oldest = conversationIdCache.keys().next().value;
    if (oldest !== undefined) conversationIdCache.delete(oldest);
  }
  conversationIdCache.set(key, id);
};

const clearConversationId = (key: string): boolean => conversationIdCache.delete(key);

// ── Default Strategy ─────────────────────────────
// Default strategy — delegates to existing XML tool prompt.

const defaultToolStrategy: WebProviderToolStrategy = {
  buildToolPrompt: tools => buildDefaultToolPrompt(tools),

  buildPrompt: ({ systemPrompt, toolPrompt, messages }) => ({
    systemPrompt: toolPrompt ? `${systemPrompt}\n\n${toolPrompt}` : systemPrompt,
    messages,
  }),
};

// ── Shared Markdown Tool Prompt ──────────────────
// Used by Qwen, Kimi, GLM, and Gemini strategies — markdown tool listing with XML call format.
// Includes explicit correct/wrong examples to prevent models from falling back to native
// function-calling formats (observed with GLM-5, Qwen, and others).

const buildMarkdownToolPrompt = (tools: ToolDef[]): string => {
  if (tools.length === 0) return '';

  const toolDefs = tools
    .map(t => `#### ${t.name}\n${t.description}\nParameters: ${JSON.stringify(t.parameters)}`)
    .join('\n\n');

  return `## Tool Use Instructions
IMPORTANT: You MUST use the EXACT XML tag format shown below for ALL tool calls.
Do NOT use any other format — no function calls, no JSON objects, no markdown code blocks.
EVERY tool call MUST start with an opening <tool_call> tag and end with </tool_call>.

Format: <tool_call id="unique_id" name="tool_name">{"arg": "value"}</tool_call>

Example of a CORRECT tool call:
<tool_call id="abc12345" name="read">{"path": "example.md"}</tool_call>

Example of WRONG formats (do NOT use these):
- {"path": "example.md"} (missing XML tags)
- \`\`\`json\n{"name": "read", "arguments": {"path": "example.md"}}\n\`\`\` (wrong format)

Rules:
1. ALWAYS think before calling a tool. Explain your reasoning inside <think> tags.
2. The 'id' attribute must be a unique 8-character string for each call.
3. Each tool call must have BOTH the opening <tool_call ...> and closing </tool_call> tags.
4. Wait for the tool result before proceeding.

After a tool executes, the result will be provided as:
<tool_response id="call_id" name="tool_name">
result text
</tool_response>

### Available Tools
${toolDefs}`;
};

// ── Shared Helpers ───────────────────────────────
// Extracted from Qwen/Kimi/GLM strategies to eliminate duplication.

/** Serialize assistant content parts — shared by qwen, kimi, and glm strategies. */
const serializeAssistantContent = (content: ContentPart[]): string => {
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === 'thinking' && c.thinking) {
      parts.push(`<think>\n${c.thinking}\n</think>\n`);
    }
    if (c.type === 'toolCall' && c.name) {
      parts.push(
        `<tool_call id="${c.id ?? ''}" name="${c.name}">${JSON.stringify(c.arguments ?? {})}</tool_call>`,
      );
    }
    if (c.type === 'text' && c.text) {
      parts.push(c.text);
    }
  }
  return parts.join('');
};

/** Aggregate all messages into a single user message with role labels. */
const aggregateHistory = (
  systemPrompt: string,
  toolPrompt: string,
  messages: SimpleMessage[],
): SimpleMessage[] => {
  const parts: string[] = [];
  parts.push(`System: ${systemPrompt}${toolPrompt ? `\n\n${toolPrompt}` : ''}`);
  for (const m of messages) {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    parts.push(`${role}: ${m.content}`);
  }
  return [{ role: 'user', content: parts.join('\n\n') }];
};

/** Unified tool call hint — shared by qwen and glm continuation prompts. */
const TOOL_CALL_HINT =
  '\n\n[SYSTEM HINT]: Remember to use the XML format for tool calls: <tool_call id="unique_id" name="tool_name">{"arg": "value"}</tool_call>';

/**
 * Build prompt for stateful providers (qwen, glm) — first-turn aggregates
 * full history; continuation sends only the last message with tool hint.
 */
const buildStatefulPrompt = (opts: {
  systemPrompt: string;
  toolPrompt: string;
  messages: SimpleMessage[];
  conversationId?: string;
}): { systemPrompt: string; messages: SimpleMessage[] } => {
  if (!opts.conversationId) {
    // First turn: full history with role labels
    return {
      systemPrompt: '',
      messages: aggregateHistory(opts.systemPrompt, opts.toolPrompt, opts.messages),
    };
  }

  // Continuation: send only the last message
  const lastMsg = opts.messages[opts.messages.length - 1];
  if (!lastMsg) {
    return { systemPrompt: '', messages: [{ role: 'user', content: '' }] };
  }

  // If last message contains tool_response, send just the response + hint
  if (lastMsg.content.includes('<tool_response')) {
    const content = `${lastMsg.content}\n\nPlease proceed based on this tool result.${opts.toolPrompt ? TOOL_CALL_HINT : ''}`;
    return {
      systemPrompt: '',
      messages: [{ role: 'user', content }],
    };
  }

  // Regular continuation: just the last user message + hint if tools present
  const content = `${lastMsg.content}${opts.toolPrompt ? TOOL_CALL_HINT : ''}`;
  return {
    systemPrompt: '',
    messages: [{ role: 'user', content }],
  };
};

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

// ── GLM International Strategy ──────────────────
// chat.z.ai is stateful — the MAIN world handler injects a synthetic
// `{"type":"glm:chat_id","chat_id":"..."}` SSE event at the start of
// each stream so the bridge can cache and reuse the chat_id.

const glmIntlToolStrategy: WebProviderToolStrategy = {
  buildToolPrompt: buildMarkdownToolPrompt,
  buildPrompt: buildStatefulPrompt,

  extractConversationId: data => {
    const obj = data as Record<string, unknown>;
    return obj.chat_id as string | undefined;
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
      return glmToolStrategy;
    case 'glm-intl-web':
      return glmIntlToolStrategy;
    default:
      return defaultToolStrategy;
  }
};

export {
  getToolStrategy,
  getConversationId,
  setConversationId,
  clearConversationId,
  defaultToolStrategy,
  claudeToolStrategy,
  qwenToolStrategy,
  kimiToolStrategy,
  glmToolStrategy,
  glmIntlToolStrategy,
  geminiToolStrategy,
};
export type { WebProviderToolStrategy, SimpleMessage, ContentPart };
