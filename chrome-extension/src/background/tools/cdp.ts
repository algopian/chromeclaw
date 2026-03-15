// ---------------------------------------------------------------------------
// Shared CDP (Chrome DevTools Protocol) helpers
// ---------------------------------------------------------------------------

const CDP_UNAVAILABLE_MSG =
  'Chrome DevTools Protocol (chrome.debugger) is not available on Firefox. ' +
  'This operation requires CDP and cannot be performed in this browser.';

/**
 * Send a CDP command to a tab via `chrome.debugger.sendCommand`.
 * Returns a typed Promise that resolves with the command result.
 */
const cdpSend = async <T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> => {
  if (typeof chrome.debugger === 'undefined') {
    throw new Error(CDP_UNAVAILABLE_MSG);
  }
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, result => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result as T);
      }
    });
  });
};

/**
 * Attach the debugger to a tab at protocol version 1.3.
 * Returns `null` on success (including "already attached"), or an error string.
 */
const cdpAttach = async (tabId: number): Promise<string | null> => {
  if (typeof chrome.debugger === 'undefined') {
    return CDP_UNAVAILABLE_MSG;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Another debugger')) {
      return null;
    }
    return msg;
  }
  return null;
};

export { cdpSend, cdpAttach };
