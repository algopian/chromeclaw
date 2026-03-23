import 'webextension-polyfill';
import { handleLLMStream } from './agents/stream-handler';
import { initChannels, validateChannelAuth, toggleChannel } from './channels';
import { saveChannelConfig, getChannelConfig, createDefaultChannelConfig } from './channels/config';
import {
  handleWatchdogAlarm,
  handleOffscreenMessage,
  isWatchdogAlarm,
} from './channels/offscreen-manager';
import {
  handlePassivePollAlarm,
  isChannelPollAlarm,
  channelIdFromAlarmName,
} from './channels/poller';
import { CronService, readRunLogs } from './cron';
import { executeScheduledTask } from './cron/executor';
import {
  createLogger,
  configReady,
  getLogEntries,
  clearLogEntries,
  registerStreamPort,
} from './logging/logger-buffer';
import { runSessionJournal } from './memory/memory-journal';
import { setCronServiceRef } from './tools/scheduler';
import { createKeepAliveManager } from './utils/keep-alive';
import { initSidePanelBehavior } from '@extension/shared';
import { getScheduledTask } from '@extension/storage';
import type { LLMRequestMessage } from '@extension/shared';

// ── Port Listener for LLM Streaming ───────────

// ── Side Panel Behavior ────────────────────────

// ── Loggers ─────────────────────────────────
const cronLog = createLogger('cron');
const slashCmdLog = createLogger('slash-cmd');

const cronService = new CronService({
  log: cronLog,
  executeTask: executeScheduledTask,
  onEvent: evt => {
    chrome.runtime.sendMessage({ type: 'CRON_EVENT', ...evt }).catch(() => {});
  },
});

setCronServiceRef(cronService);

// Start cron — use microtask to avoid setTimeout race with Firefox event page suspension.
// IndexedDB is available immediately; the 1-second delay was unnecessary and risky.
Promise.resolve().then(() =>
  cronService.start().catch(err => {
    cronLog.error('Failed to start cron service', { error: String(err) });
  }),
);

// ── Strip CORP headers for extension image loads ──
// Google CDN (and other servers) set Cross-Origin-Resource-Policy: same-site,
// which blocks <img> loads from chrome-extension:// pages.
// This dynamic rule removes that header for image requests initiated by the extension.
// NOTE: Use string literals for action type / header operation / resource type —
// Firefox does not expose the Chrome-style enum objects (RuleActionType, HeaderOperation, etc.).
const CORP_STRIP_RULE_ID = 9999;
try {
  chrome.declarativeNetRequest
    .updateDynamicRules({
      removeRuleIds: [CORP_STRIP_RULE_ID],
      addRules: [
        {
          id: CORP_STRIP_RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
            responseHeaders: [
              {
                header: 'Cross-Origin-Resource-Policy',
                operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation,
              },
            ],
          },
          condition: {
            resourceTypes: ['image' as chrome.declarativeNetRequest.ResourceType],
            initiatorDomains: [chrome.runtime.id],
          },
        },
      ],
    })
    .catch(err => {
      console.error('[corp-strip] Failed to register CORP header rule:', err);
    });
} catch (err) {
  console.error('[corp-strip] Failed to create CORP header rule:', err);
}

// ── Message Handlers ───────────────────────────

type MessageHandler = (
  request: Record<string, unknown>,
) => Promise<Record<string, unknown> | undefined>;

const messageHandlers: Record<string, MessageHandler> = {
  GET_LOGS: async () => ({ ...getLogEntries() }),

  CLEAR_LOGS: async () => {
    clearLogEntries();
    return { success: true };
  },

  LOG_RELAY: async request => {
    const logger = createLogger('media');
    const level = request.level as string;
    const logFn = logger[level as keyof typeof logger];
    if (logFn) logFn(request.message as string, request.data);
    return {};
  },

  CHANNEL_VALIDATE_AUTH: async request => {
    const channelId = request.channelId as string;
    const credentials = request.credentials as Record<string, string>;
    return validateChannelAuth(channelId, credentials);
  },

  CHANNEL_TOGGLE: async request => {
    const channelId = request.channelId as string;
    const enabled = request.enabled as boolean;
    await toggleChannel(channelId, enabled);
    return { success: true };
  },

  // ── Offscreen Storage Proxy ─────────────────
  // Offscreen documents cannot access chrome.storage directly.
  // These handlers proxy storage operations from the offscreen document.

  OFFSCREEN_STORAGE_GET: async request => {
    const keys = request.keys as string | string[];
    const data = await chrome.storage.local.get(keys);
    return { data };
  },

  OFFSCREEN_STORAGE_SET: async request => {
    const items = request.items as Record<string, unknown>;
    await chrome.storage.local.set(items);
    return { success: true };
  },

  OFFSCREEN_STORAGE_REMOVE: async request => {
    const keys = request.keys as string | string[];
    await chrome.storage.local.remove(keys);
    return { success: true };
  },

  CHANNEL_SAVE_CONFIG: async request => {
    const channelId = request.channelId as string;
    const updates = request.config as Record<string, unknown>;
    let config = await getChannelConfig(channelId);
    if (!config) {
      config = createDefaultChannelConfig(channelId);
    }
    // R6: Whitelist fields that can be set from Options page
    if (updates.credentials && typeof updates.credentials === 'object') {
      config.credentials = updates.credentials as Record<string, string>;
    }
    if (Array.isArray(updates.allowedSenderIds)) {
      config.allowedSenderIds = updates.allowedSenderIds as string[];
    }
    if (updates.modelId !== undefined) {
      config.modelId = updates.modelId as string | undefined;
    }
    if (updates.acceptFromMe !== undefined) {
      config.acceptFromMe = updates.acceptFromMe as boolean;
    }
    if (updates.acceptFromOthers !== undefined) {
      config.acceptFromOthers = updates.acceptFromOthers as boolean;
    }
    await saveChannelConfig(config);
    return { success: true };
  },

  CHANNEL_GET_CONFIG: async request => {
    const channelId = request.channelId as string;
    const config = await getChannelConfig(channelId);
    return { config: config ?? createDefaultChannelConfig(channelId) };
  },

  STT_DOWNLOAD_MODEL: async request => {
    const { requestModelDownload } = await import('./media-understanding');
    const downloadId = await requestModelDownload(request.model as string);
    return { downloadId };
  },

  TTS_DOWNLOAD_MODEL: async request => {
    const { requestModelDownload } = await import('./tts/providers/kokoro-bridge');
    const downloadId = await requestModelDownload(request.model as string);
    return { downloadId };
  },

  LOCAL_LLM_DOWNLOAD_MODEL: async request => {
    const { ensureOffscreenDocument } = await import('./channels/offscreen-manager');
    await ensureOffscreenDocument();
    const modelId = request.modelId as string;
    const downloadId = (request.downloadId as string) || crypto.randomUUID();
    const device =
      request.device === 'webgpu' || request.device === 'wasm' ? request.device : undefined;
    await chrome.runtime.sendMessage({
      type: 'LOCAL_LLM_DOWNLOAD_MODEL',
      modelId,
      downloadId,
      device,
    });
    return { downloadId };
  },

  SUBAGENT_STOP: async request => {
    const runId = request.runId as string;
    if (!runId) return { status: 'error', error: 'runId is required' };
    const { executeKillSubagent } = await import('./tools/subagent');
    const result = await executeKillSubagent({ runId });
    return JSON.parse(result);
  },

  SESSION_JOURNAL: async request => {
    const chatId = request.chatId as string;
    if (!chatId) return { error: 'chatId is required' };
    const agentId = (request.agentId as string) || undefined;
    cronLog.debug('Session journal requested', { chatId, agentId });
    streamKeepAlive.acquire();
    try {
      const result = await runSessionJournal({ chatId, agentId });
      return { result };
    } finally {
      streamKeepAlive.release();
    }
  },

  CRON_STATUS: async () => {
    const result = await cronService.status();
    return { status: result };
  },

  CRON_LIST_TASKS: async request => {
    const tasks = await cronService.list({
      includeDisabled: (request.includeDisabled as boolean) ?? true,
    });
    return { tasks };
  },

  CRON_GET_TASK: async request => {
    const id = request.taskId as string;
    if (!id) return { error: 'taskId is required' };
    const task = await getScheduledTask(id);
    return { task: task ?? null };
  },

  CRON_TOGGLE_TASK: async request => {
    const id = request.taskId as string;
    const enabled = request.enabled as boolean;
    if (!id) return { error: 'taskId is required' };
    await cronService.update(id, { enabled });
    return { success: true };
  },

  CRON_DELETE_TASK: async request => {
    const id = request.taskId as string;
    if (!id) return { error: 'taskId is required' };
    const result = await cronService.remove(id);
    return result;
  },

  CRON_RUN_NOW: async request => {
    const id = request.taskId as string;
    if (!id) return { error: 'taskId is required' };
    const result = await cronService.run(id, 'force');
    return result;
  },

  CRON_GET_RUNS: async request => {
    const id = request.taskId as string;
    if (!id) return { error: 'taskId is required' };
    const runs = await readRunLogs(id, 50);
    return { runs };
  },

  CHECK_LOCAL_STORAGE: async request => {
    const tabId = request.tabId as number;
    const keys = request.keys as string[];
    if (!tabId || !keys?.length) return { tokens: null };
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (indicators: string[]) =>
          indicators.reduce(
            (acc, name) => {
              const val = localStorage.getItem(name);
              if (val) acc[name] = val;
              return acc;
            },
            {} as Record<string, string>,
          ),
        args: [keys],
      });
      const tokens = results?.[0]?.result as Record<string, string> | undefined;
      return { tokens: tokens && Object.keys(tokens).length > 0 ? tokens : null };
    } catch {
      return { tokens: null };
    }
  },

  TEST_CONNECTION: async request => {
    const modelConfig = request.modelConfig as import('@extension/shared').ChatModel;
    if (!modelConfig?.provider) return { error: 'modelConfig is required' };
    try {
      if (modelConfig.provider === 'web') {
        const { testWebConnection } = await import('./web-providers/auth');
        return testWebConnection(modelConfig.webProviderId);
      }
      const { completeText } = await import('./agents/stream-bridge');
      await completeText(modelConfig, '', 'hi', { maxTokens: 1 });
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Connection failed' };
    }
  },

  COMPACT_REQUEST: async request => {
    const chatId = request.chatId as string;
    const modelConfig = request.modelConfig as import('@extension/shared').ChatModel;
    if (!chatId || !modelConfig) return { error: 'chatId and modelConfig are required' };

    slashCmdLog.trace('COMPACT_REQUEST received', { chatId, modelId: modelConfig.id });
    streamKeepAlive.acquire();

    try {
      const {
        getMessagesByChatId,
        getChat,
        updateCompactionSummary,
        incrementCompactionCount,
        getEnabledWorkspaceFiles,
      } = await import('@extension/storage');
      const { compactMessagesWithSummary } = await import('./context/compaction');
      const { enforceToolResultBudget } = await import('./context/tool-result-context-guard');
      const { extractCriticalRules } = await import('./context/summarizer');
      const { buildHeadlessSystemPrompt } = await import('./agents/agent-setup');
      const { getProviderTokenLimit } = await import('./context/provider-limit-cache');

      const [messages, chat] = await Promise.all([getMessagesByChatId(chatId), getChat(chatId)]);
      slashCmdLog.debug('Loaded messages for compaction', { chatId, messageCount: messages.length });
      if (messages.length <= 2) return { error: 'Not enough messages to compact' };

      // Build system prompt to get accurate token count (same as stream-handler.ts)
      const agentId = chat?.agentId ?? 'main';
      const systemPrompt = await buildHeadlessSystemPrompt(modelConfig, agentId);
      const systemPromptTokens = Math.ceil(systemPrompt.length / 4);

      // Use the lower of model contextWindow and any detected provider limit
      const cachedLimit = getProviderTokenLimit(modelConfig.id);
      const effectiveContextWindow =
        cachedLimit && modelConfig.contextWindow
          ? Math.min(cachedLimit, modelConfig.contextWindow)
          : (cachedLimit ?? modelConfig.contextWindow);

      slashCmdLog.trace('COMPACT_REQUEST: effective context window', {
        cachedLimit,
        modelContextWindow: modelConfig.contextWindow,
        effectiveContextWindow,
      });

      // Pre-compaction: enforce tool result budget (same as transform.ts auto-compaction path)
      const guarded = enforceToolResultBudget(
        messages as import('@extension/shared').ChatMessage[],
        modelConfig.id,
        effectiveContextWindow,
      );

      // Extract critical rules from workspace files for summary context
      const workspaceFiles = await getEnabledWorkspaceFiles(agentId);
      const criticalRules = extractCriticalRules(workspaceFiles);

      const result = await compactMessagesWithSummary(guarded, modelConfig.id, modelConfig, {
        existingSummary: chat?.compactionSummary,
        systemPromptTokens,
        contextWindowOverride: effectiveContextWindow,
        force: true,
        criticalRules,
      });

      if (!result.wasCompacted) {
        // force compaction was requested but nothing was compacted — this can happen
        // when there are too few messages to summarize (e.g. only anchor + 1 message)
        return { error: 'Not enough messages to compact' };
      }

      slashCmdLog.info('Compaction result', {
        chatId,
        wasCompacted: result.wasCompacted,
        compactionMethod: result.compactionMethod,
        summaryLength: result.summary?.length ?? 0,
        keptMessages: result.messages.length,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        tokensSaved:
          result.tokensBefore && result.tokensAfter
            ? result.tokensBefore - result.tokensAfter
            : undefined,
        messagesDropped: result.messagesDropped,
        durationMs: result.durationMs,
      });

      // Persist: delete old messages and keep only the compacted set
      const { deleteMessagesByChatId, addMessage } = await import('@extension/storage');
      await deleteMessagesByChatId(chatId);
      for (const msg of result.messages) {
        await addMessage({ ...msg, chatId });
      }

      if (result.summary) await updateCompactionSummary(chatId, result.summary);
      await incrementCompactionCount(chatId);

      return {
        success: true,
        summary: result.summary ?? '',
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        messagesDropped: result.messagesDropped,
        compactionMethod: result.compactionMethod,
        durationMs: result.durationMs,
      };
    } catch (err) {
      slashCmdLog.error('Compaction failed', { chatId, error: String(err) });
      throw err;
    } finally {
      streamKeepAlive.release();
    }
  },
};

chrome.runtime.onMessage.addListener(
  (
    request: Record<string, unknown>,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: Record<string, unknown> | undefined) => void,
  ) => {
    const handler = messageHandlers[request.type as string];
    if (handler) {
      handler(request)
        .then(sendResponse)
        .catch(err => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
      return true; // Keep message channel open for async response
    }
    return false;
  },
);

const streamKeepAlive = createKeepAliveManager('keep-alive');

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'log-stream') {
    registerStreamPort(port);
    return;
  }

  if (port.name === 'llm-stream') {
    streamKeepAlive.acquire();

    port.onDisconnect.addListener(() => {
      streamKeepAlive.release();
    });

    port.onMessage.addListener((msg: Record<string, unknown>) => {
      if (msg.type === 'LLM_REQUEST') {
        handleLLMStream(port, msg as unknown as LLMRequestMessage);
      }
    });
  }
});

// Handle alarms: keep-alive, channel passive polls, and watchdog.
// Use waitUntil pattern (returning promise) to keep SW alive during async poll work.
chrome.alarms.onAlarm.addListener(alarm => {
  if (CronService.isSchedulerAlarm(alarm.name)) {
    cronService.handleAlarm().catch(err => {
      cronLog.error('Cron alarm handler failed', { error: String(err) });
    });
  } else if (isChannelPollAlarm(alarm.name)) {
    // Keep SW alive by handling the promise — Chrome extends lifetime for pending async event work
    handlePassivePollAlarm(channelIdFromAlarmName(alarm.name)).catch(err => {
      console.error('[alarm] Passive poll failed:', err);
    });
  } else if (isWatchdogAlarm(alarm.name)) {
    handleWatchdogAlarm().catch(err => {
      console.error('[alarm] Watchdog failed:', err);
    });
  }
  // keep-alive alarm: no-op (just keeps the service worker active)
});

// ── Channel Initialization ────────────────────

// R22: Initialize channels on startup with retry on failure
const channelLog = createLogger('channel-init');
const initWithRetry = async (attempts = 3, delayMs = 2000): Promise<void> => {
  for (let i = 0; i < attempts; i++) {
    try {
      await initChannels();
      return;
    } catch (err) {
      console.error(`[channels] Init failed (attempt ${i + 1}/${attempts}):`, err);
      channelLog.error('Init failed', { attempt: i + 1, attempts, error: String(err) });
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
};
// Ensure log config is loaded before channel init so structured logs aren't silently dropped.
// Export the promise so the offscreen message handler can await it — on SW restart,
// CHANNEL_UPDATES may arrive before initChannels() completes.
const channelsReady = configReady
  .then(() => initWithRetry())
  .catch(err => console.error('[channels] configReady failed:', err));

// R14: Handle messages from the offscreen document — return true for async handling
chrome.runtime.onMessage.addListener(
  (
    message: Record<string, unknown>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    // Only handle messages originating from the offscreen/worker document, not our own
    // broadcasts back to extension pages. Offscreen senders have sender.url set
    // to the offscreen HTML page; the SW broadcasting to itself has no url.
    // On Firefox, workers run in a hidden popup window with the same page URL.
    const senderUrl = sender.url ?? '';
    const isFromOffscreen =
      sender.id === chrome.runtime.id && senderUrl.includes('offscreen-channels');
    const isFromWorkerRouter = message._source === 'worker-router';

    if (typeof message.type === 'string') {
      const type = message.type;

      if (
        type === 'CHANNEL_UPDATES' ||
        type === 'CHANNEL_ERROR' ||
        type === 'WA_QR_CODE' ||
        type === 'WA_CONNECTION_STATUS' ||
        type === 'WA_DEBUG'
      ) {
        if (!isFromOffscreen && !isFromWorkerRouter) {
          // This is our own broadcast echoing back — ignore it
          return false;
        }
        // Wait for channel initialization to complete before processing.
        // On SW restart, this message may arrive before initChannels() finishes.
        channelsReady
          .then(() => handleOffscreenMessage(message))
          .then(() => sendResponse({ ok: true }))
          .catch(err => {
            console.error('[channels] Offscreen message handler error:', err);
            sendResponse({ ok: false });
          });
        return true; // Keep message channel open for async response
      }
    }
    return false;
  },
);

initSidePanelBehavior();
