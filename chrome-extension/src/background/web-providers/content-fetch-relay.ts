/**
 * Content script injected into ISOLATED world of a provider's tab.
 * Listens for messages from the MAIN world content script and relays
 * them to the extension background via chrome.runtime.sendMessage().
 *
 * The MAIN world script can't call chrome.runtime directly, so this
 * relay bridges the gap.
 */

/**
 * Install the relay listener. Injected via chrome.scripting.executeScript.
 * @param requestId — scopes this relay to a single generation request
 * @param expectedOrigin — only forward messages from this origin (prevents cross-origin injection)
 * @param timeoutMs — auto-cleanup after this many ms (should match or exceed bridge timeout)
 */
export const installRelay = (
  requestId: string,
  expectedOrigin: string,
  timeoutMs: number,
): void => {
  const handler = (event: MessageEvent) => {
    if (event.source !== window) return;
    if (event.origin !== expectedOrigin) return;
    const data = event.data;
    if (!data || data.requestId !== requestId) return;

    if (
      data.type === 'WEB_LLM_CHUNK' ||
      data.type === 'WEB_LLM_DONE' ||
      data.type === 'WEB_LLM_ERROR'
    ) {
      chrome.runtime.sendMessage(data);
    }
  };

  window.addEventListener('message', handler);

  // Auto-cleanup after timeout
  setTimeout(() => window.removeEventListener('message', handler), timeoutMs);
};
