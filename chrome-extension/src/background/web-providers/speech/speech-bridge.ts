/**
 * Background-side bridge for browser zero-token speech-to-text.
 *
 * Generic: dispatches through a `SpeechWebProviderPlugin` — the plugin supplies
 * `encodeRequest` (build uplink frames), `channelClient` (MAIN-world transport),
 * and `decodeResult` (interpret downlink payloads). The bridge handles the
 * provider-agnostic plumbing: tab find/create, ISOLATED relay + MAIN injection,
 * requestId correlation, timeout, and `SPEECH_RESULT` message collection.
 *
 * Mirrors the R14 web-LLM bridge injection pattern but is far smaller: a single
 * request/response round-trip correlated by `requestId`, no streaming.
 */

import { createLogger } from '../../logging/logger-buffer';
import { installRelay } from '../content-fetch-relay';
import type { SpeechWebProviderPlugin } from './plugin-types';

const log = createLogger('media');

/** Overall bridge timeout (channel probe + uplink + result drain). */
const SPEECH_TIMEOUT_MS = 90_000;
const TAB_LOAD_TIMEOUT_MS = 30_000;

const waitForTabLoad = (tabId: number): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`Tab did not finish loading within ${TAB_LOAD_TIMEOUT_MS / 1000}s`));
    }, TAB_LOAD_TIMEOUT_MS);
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(to);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });

/**
 * Transcribe an audio buffer via a speech web provider plugin.
 * Resolves to the recognized transcript, or rejects with a descriptive error.
 */
const transcribeViaSpeechPlugin = (
  plugin: SpeechWebProviderPlugin,
  audio: ArrayBuffer,
  language = 'en',
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const fetchRequest = plugin.encodeRequest(audio, language);
    const { requestId } = fetchRequest;
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
    };
    const succeed = (text: string) => {
      cleanup();
      resolve(text);
    };
    const failWith = (msg: string) => {
      cleanup();
      reject(new Error(msg));
    };

    const timeout = setTimeout(
      () => failWith(`${plugin.definition.name} STT timed out after ${SPEECH_TIMEOUT_MS / 1000}s`),
      SPEECH_TIMEOUT_MS,
    );

    const listener = (message: Record<string, unknown>) => {
      if (message.requestId !== requestId || settled) return;
      if (message.type === 'SPEECH_RESULT') {
        const payloads = message.payloads;
        if (!Array.isArray(payloads) || payloads.length === 0) {
          failWith(`${plugin.definition.name} STT returned no payloads`);
          return;
        }

        const stringPayloads = payloads.filter((p): p is string => typeof p === 'string');
        log.info(`${plugin.definition.name} STT response received`, {
          requestId,
          payloadCount: payloads.length,
          payloadLengths: stringPayloads.map(p => p.length),
        });

        try {
          const transcript = plugin.decodeResult(payloads);
          log.info(`${plugin.definition.name} STT transcript assembled`, {
            requestId,
            length: transcript.length,
          });
          succeed(transcript);
        } catch (err) {
          failWith(
            `Failed to decode ${plugin.definition.name} STT result: ${String(err instanceof Error ? err.message : err)}`,
          );
        }
      } else if (message.type === 'WEB_LLM_ERROR') {
        failWith(
          typeof message.error === 'string' ? message.error : `${plugin.definition.name} STT error`,
        );
      } else if (message.type === 'SPEECH_DIAG') {
        log.info(`${plugin.definition.name} STT diag`, { requestId, msg: message.msg });
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    (async () => {
      try {
        const loginUrl = plugin.definition.loginUrl;
        // Find or create a tab on the provider's domain.
        const tabs = await chrome.tabs.query({ url: `${loginUrl}/*` });
        let tabId: number;
        if (tabs.length > 0 && tabs[0].id) {
          tabId = tabs[0].id;
        } else {
          const newTab = await chrome.tabs.create({ url: loginUrl, active: false });
          if (!newTab.id) {
            failWith(`Failed to open a ${plugin.definition.name} tab for STT`);
            return;
          }
          tabId = newTab.id;
          await waitForTabLoad(tabId);
        }

        const origin = new URL(loginUrl).origin;

        // Inject relay (ISOLATED) then the channel client (MAIN).
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'ISOLATED',
          func: installRelay,
          args: [requestId, origin, SPEECH_TIMEOUT_MS + 10_000],
        });
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: plugin.channelClient,
          args: [fetchRequest],
        });

        log.info(`${plugin.definition.name} STT request sent`, {
          requestId,
          tabId,
          language,
          audioBytes: audio.byteLength,
          audioFrames: fetchRequest.audioFrames.length,
        });
      } catch (err) {
        failWith(err instanceof Error ? err.message : String(err));
      }
    })();
  });

export { transcribeViaSpeechPlugin };
