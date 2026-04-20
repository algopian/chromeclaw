// Gate a toast call on document visibility. When multiple extension pages
// (side panel + full-page chat) each receive the same background broadcast,
// pages that are currently hidden drop the toast. Pages that are visible
// still show it, so if both a side panel and a full-page chat tab are
// visible at once the user will see two toasts — this helper reduces
// duplicates from hidden pages but does not fully dedupe across pages.
// If no page is visible, the toast is dropped and the background SW log
// entry remains the record of truth.
const toastIfVisible = (fn: () => void): void => {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') fn();
};

export { toastIfVisible };
