import { useCallback, useRef } from 'react';

const MAX_HISTORY = 1000;

/**
 * In-memory, session-scoped history of submitted chat inputs.
 *
 * - Holds at most {@link MAX_HISTORY} entries (oldest dropped first).
 * - Not persisted anywhere — the history lives in the hook's refs and is
 *   dropped when the page unmounts (close / reload).
 * - Navigation cursor: `null` means "fresh draft" (not browsing history).
 *   `0` is the most-recent entry, larger indices are older.
 */
const useInputHistory = () => {
  const historyRef = useRef<string[]>([]);
  // null = not navigating (editing a fresh draft). Otherwise index from the
  // end of the history array (0 = most recent submitted entry).
  const cursorRef = useRef<number | null>(null);

  const record = useCallback((value: string) => {
    const trimmed = value.trim();
    cursorRef.current = null;
    if (!trimmed) return;
    const history = historyRef.current;
    // Skip consecutive duplicates of the most recent entry.
    if (history[history.length - 1] === trimmed) return;
    history.push(trimmed);
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
  }, []);

  /** Move toward older entries. Returns the entry to display, or null if no-op. */
  const previous = useCallback((): string | null => {
    const history = historyRef.current;
    if (history.length === 0) return null;
    const current = cursorRef.current;
    const next = current === null ? 0 : Math.min(current + 1, history.length - 1);
    cursorRef.current = next;
    return history[history.length - 1 - next];
  }, []);

  /**
   * Move toward newer entries. Returns the entry to display, an empty string
   * when stepping back to the fresh draft, or null if not navigating.
   */
  const next = useCallback((): string | null => {
    const history = historyRef.current;
    const current = cursorRef.current;
    if (current === null) return null;
    if (current <= 0) {
      cursorRef.current = null;
      return '';
    }
    const nextCursor = current - 1;
    cursorRef.current = nextCursor;
    return history[history.length - 1 - nextCursor];
  }, []);

  /** Reset navigation back to the fresh-draft state (call when the user edits). */
  const resetCursor = useCallback(() => {
    cursorRef.current = null;
  }, []);

  /** Whether the user is currently browsing history (not editing a fresh draft). */
  const isNavigating = useCallback(() => cursorRef.current !== null, []);

  return { record, previous, next, resetCursor, isNavigating };
};

export { useInputHistory, MAX_HISTORY };
