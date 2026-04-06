---
summary: "Sessions and chat history — persistent conversations with auto-titling, date grouping, and search."
read_when:
  - Understanding how chat sessions work
  - Learning about chat history and persistence
  - Understanding session transitions and memory flushing
title: "Sessions"
---

# Sessions

ChromeClaw persists every conversation as a chat session in IndexedDB. Sessions provide continuity across browser restarts and support search, grouping, and automatic memory extraction.

## Chat persistence

Each chat session stores:

- **Messages** — Full conversation history with all parts (text, reasoning, tool calls, tool results, files)
- **Metadata** — Title, timestamps, agent ID, model used, channel metadata
- **Token usage** — Prompt tokens, completion tokens, total tokens, compaction status
- **Compaction state** — Summary from prior compaction, compaction count, method used

Messages are stored in IndexedDB as structured objects with typed parts, not plain text. This preserves tool call arguments, results, reasoning blocks, and file attachments.

## Auto-titling

When a new conversation starts, ChromeClaw automatically generates a short title using the LLM after the first exchange. This title appears in the chat history sidebar.

## Chat history

The chat history panel shows all previous conversations with:

- **Date grouping** — Today, Yesterday, This Week, This Month, Older
- **Search** — Full-text search across conversation titles and content
- **Agent indicator** — Which agent was used for each chat

Click any chat to resume the conversation with full history intact.

## Session transitions

When you switch from one chat to another (or start a new chat), ChromeClaw triggers **session journaling**:

1. The current conversation transcript is analyzed by the LLM
2. Durable memories are extracted (facts, decisions, preferences)
3. New memories are appended to `memory/YYYY-MM-DD.md`
4. The `MEMORY.md` summary is updated
5. The transcript is indexed for future memory search

This ensures important context from completed conversations is preserved in long-term memory. See [Memory](/concepts/memory) for details.

<Note>
Session journaling has a 60-second cooldown per chat to prevent rapid re-processing when switching back and forth.
</Note>

## Channel sessions

When messages arrive via [WhatsApp or Telegram](/channels/index), ChromeClaw creates or resumes a chat session linked to the channel conversation. Channel metadata (sender ID, channel ID, chat type) is stored alongside the chat record.

Each channel conversation maps to a separate ChromeClaw chat, maintaining distinct context and history per contact or group.

## Token usage tracking

Each session tracks cumulative token usage:

- **promptTokens** — Tokens sent to the LLM
- **completionTokens** — Tokens received from the LLM
- **totalTokens** — Combined total
- **wasCompacted** — Whether context compaction was applied
- **contextUsage** — Token counts from the most recent compacted context

This data is visible on the Options page under the **Usage** tab.
