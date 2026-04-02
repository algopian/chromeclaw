import type { ChatMessage, ChatModel } from '../chat-types.js';

interface SlashCommandDef {
  name: string;
  description: string;
  execute: (ctx: SlashCommandContext) => Promise<void>;
}

interface SlashCommandContext {
  chatId: string;
  messages: ChatMessage[];
  model: ChatModel;
  /** Raw argument string after the command name (e.g. "3" for "/copy 3"). */
  args: string;
  /** Append a system message to the chat (ephemeral, not persisted). */
  appendSystemMessage: (id: string, text: string) => void;
  /** Replace all messages in the chat. */
  replaceMessages: (msgs: ChatMessage[]) => void;
  /** Clear the input field. */
  clearInput: () => void;
  /** Reset token usage counters to zero. */
  resetUsage: () => void;
  /** Increment the compaction counter by one. */
  incrementCompactionCount: () => void;
  /** Block/unblock user input during compaction. */
  setIsCompacting: (isCompacting: boolean) => void;
  /** Start a new chat session (equivalent to clicking the new session button). */
  onNewChat?: () => void;
}

export type { SlashCommandDef, SlashCommandContext };
