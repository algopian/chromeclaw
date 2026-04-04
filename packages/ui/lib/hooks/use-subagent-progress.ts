import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubagentProgressInfo } from '@extension/shared';

interface UseSubagentProgressOpts {
  /** Called when a subagent completes for the currently-viewed chat. */
  onCurrentChatComplete?: (chatId: string) => void;
  /** Called when a subagent completes for a different chat (e.g. show a toast). */
  onOtherChatComplete?: (chatId: string, task: string) => void;
}

/**
 * Tracks subagent progress across SUBAGENT_PROGRESS / SUBAGENT_COMPLETE
 * runtime messages. Returns an array of active subagent infos filtered
 * to the current chatId.
 */
const useSubagentProgress = (chatId: string, opts?: UseSubagentProgressOpts): SubagentProgressInfo[] => {
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  // Stable refs for callbacks so the listener doesn't re-register on callback changes
  const onCurrentRef = useRef(opts?.onCurrentChatComplete);
  onCurrentRef.current = opts?.onCurrentChatComplete;
  const onOtherRef = useRef(opts?.onOtherChatComplete);
  onOtherRef.current = opts?.onOtherChatComplete;

  const [subagents, setSubagents] = useState<Map<string, SubagentProgressInfo>>(new Map());

  // Clear entries that belong to a different chat when the user switches
  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      setSubagents(map => {
        const filtered = new Map<string, SubagentProgressInfo>();
        for (const [id, info] of map) {
          if (info.chatId === chatId) filtered.set(id, info);
        }
        return filtered.size === map.size ? map : filtered;
      });
    }
  }, [chatId]);

  useEffect(() => {
    const handler = (message: Record<string, unknown>) => {
      const type = message.type as string;
      const msgChatId = message.chatId as string;
      if (!msgChatId) return;

      if (type === 'SUBAGENT_PROGRESS') {
        if (chatIdRef.current !== msgChatId) return;

        const runId = message.runId as string;
        const event = message.event as string;

        setSubagents(map => {
          const next = new Map(map);
          const existing = next.get(runId) ?? {
            runId,
            chatId: msgChatId,
            task: (message.task as string) ?? '',
            startedAt: Date.now(),
            stepCount: 0,
            steps: [],
          };

          if (event === 'started') {
            next.set(runId, { ...existing, task: (message.task as string) ?? existing.task });
          } else if (event === 'tool_start') {
            next.set(runId, {
              ...existing,
              steps: [
                ...existing.steps,
                {
                  toolCallId: (message.toolCallId as string) ?? '',
                  toolName: message.toolName as string,
                  status: 'running',
                  args: (message.args as string) ?? undefined,
                  startedAt: Date.now(),
                },
              ],
            });
          } else if (event === 'tool_done') {
            const toolCallId = (message.toolCallId as string) ?? '';
            const steps = existing.steps.map(s =>
              s.toolCallId === toolCallId && s.status === 'running'
                ? {
                    ...s,
                    status: (message.isError as boolean) ? ('error' as const) : ('done' as const),
                    result: (message.result as string) ?? undefined,
                    endedAt: Date.now(),
                  }
                : s,
            );
            next.set(runId, { ...existing, steps });
          } else if (event === 'turn_end') {
            next.set(runId, { ...existing, stepCount: message.stepCount as number });
          }
          return next;
        });
        return;
      }

      if (type === 'SUBAGENT_COMPLETE') {
        const runId = message.runId as string;
        setSubagents(map => {
          const next = new Map(map);
          next.delete(runId);
          return next;
        });

        if (chatIdRef.current === msgChatId) {
          onCurrentRef.current?.(msgChatId);
        } else {
          const task = (message.task as string)?.slice(0, 80) ?? 'Subagent';
          onOtherRef.current?.(msgChatId, task);
        }
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // Filter to current chatId
  return useMemo(
    () => [...subagents.values()].filter(sa => sa.chatId === chatId),
    [subagents, chatId],
  );
};

export { useSubagentProgress };
