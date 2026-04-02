/**
 * Visual tab indicator — shows an indigo outline around the viewport
 * while ChromeClaw tools are actively interacting with a tab.
 *
 * Uses chrome.scripting.insertCSS/removeCSS (no CDP required).
 * Reference-counted so overlapping/sequential tool calls on the same
 * tab keep the indicator visible until the last one finishes + linger.
 */

const INDICATOR_CSS = 'html { outline: 3px solid #4f46e5 !important; outline-offset: -3px !important; }';

/** Number of active tool calls per tab. */
const activeCount = new Map<number, number>();

/** How long the indicator lingers after the last tool call finishes. */
const LINGER_MS = 1500;

/** Inject an indigo outline on the tab to indicate active control. */
const injectControlIndicator = async (tabId: number): Promise<void> => {
  activeCount.set(tabId, (activeCount.get(tabId) ?? 0) + 1);
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, css: INDICATOR_CSS });
  } catch {
    // Best-effort — don't fail the operation (e.g. chrome:// pages)
  }
};

/** Remove the control indicator after tool execution completes. */
const removeControlIndicator = async (tabId: number): Promise<void> => {
  const count = (activeCount.get(tabId) ?? 1) - 1;
  if (count > 0) {
    activeCount.set(tabId, count);
    return; // Other tool calls still active on this tab
  }
  activeCount.delete(tabId);

  // Linger so the user can see which tab was touched
  await new Promise(resolve => setTimeout(resolve, LINGER_MS));

  // If a new tool call started during the delay, don't remove
  if (activeCount.has(tabId)) return;

  try {
    await chrome.scripting.removeCSS({ target: { tabId }, css: INDICATOR_CSS });
  } catch {
    // Best-effort — tab may have been closed
  }
};

// Cleanup stale entries when tabs are closed
if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onRemoved.addListener(tabId => {
    activeCount.delete(tabId);
  });
}

export { injectControlIndicator, removeControlIndicator };
