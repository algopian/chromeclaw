/**
 * Tests for use-input-history.ts — in-memory, session-scoped input history.
 *
 * React is mocked so the hook can run outside a component. Because useRef
 * returns a stable object and useCallback returns the raw function, a single
 * invocation of the hook yields working closures over the same refs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react', () => ({
  useRef: (init: unknown) => ({ current: init }),
  useCallback: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { useInputHistory, MAX_HISTORY } from './use-input-history';

describe('useInputHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null from previous/next when history is empty', () => {
    const h = useInputHistory();
    expect(h.previous()).toBeNull();
    expect(h.next()).toBeNull();
    expect(h.isNavigating()).toBe(false);
  });

  it('recalls entries newest-first with ArrowUp', () => {
    const h = useInputHistory();
    h.record('one');
    h.record('two');
    h.record('three');
    expect(h.previous()).toBe('three');
    expect(h.previous()).toBe('two');
    expect(h.previous()).toBe('one');
    // Stays at the oldest entry.
    expect(h.previous()).toBe('one');
  });

  it('walks back toward the fresh draft with next()', () => {
    const h = useInputHistory();
    h.record('a');
    h.record('b');
    expect(h.previous()).toBe('b');
    expect(h.previous()).toBe('a');
    expect(h.next()).toBe('b');
    // Stepping past the newest entry returns the empty draft and stops navigating.
    expect(h.next()).toBe('');
    expect(h.isNavigating()).toBe(false);
    expect(h.next()).toBeNull();
  });

  it('ignores empty and whitespace-only submissions', () => {
    const h = useInputHistory();
    h.record('');
    h.record('   ');
    expect(h.previous()).toBeNull();
  });

  it('trims recorded values', () => {
    const h = useInputHistory();
    h.record('  hello  ');
    expect(h.previous()).toBe('hello');
  });

  it('skips consecutive duplicates', () => {
    const h = useInputHistory();
    h.record('dup');
    h.record('dup');
    h.record('other');
    expect(h.previous()).toBe('other');
    expect(h.previous()).toBe('dup');
    expect(h.previous()).toBe('dup'); // only one 'dup' stored
  });

  it('resets the navigation cursor on record and resetCursor', () => {
    const h = useInputHistory();
    h.record('x');
    h.record('y');
    expect(h.previous()).toBe('y');
    expect(h.isNavigating()).toBe(true);
    h.resetCursor();
    expect(h.isNavigating()).toBe(false);
    // After reset, ArrowUp starts again from the newest.
    expect(h.previous()).toBe('y');
  });

  it('caps history at MAX_HISTORY entries, dropping oldest', () => {
    const h = useInputHistory();
    for (let i = 0; i < MAX_HISTORY + 50; i++) {
      h.record(`entry-${i}`);
    }
    // Most recent is the last recorded.
    expect(h.previous()).toBe(`entry-${MAX_HISTORY + 49}`);
    // Walk to the oldest retained entry.
    let last: string | null = null;
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      const v = h.previous();
      if (v !== null) last = v;
    }
    // The 50 oldest entries were dropped, so the oldest retained is entry-50.
    expect(last).toBe('entry-50');
  });
});
