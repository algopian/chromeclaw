import type { BaseStorageType, ValueOrUpdateType } from '../base/types.js';

/**
 * Deep-merge `defaults` with a `stored` value so that keys added in newer code
 * versions are present even when the persisted object predates them. Nested
 * keys (whose values are objects) are merged one level deep.
 */
const mergeDefaults = <T>(defaults: T, stored: T, nestedKeys?: (keyof T)[]): T => {
  const merged = { ...defaults, ...stored } as T;
  if (nestedKeys) {
    for (const key of nestedKeys) {
      (merged as Record<string, unknown>)[key as string] = {
        ...(defaults[key] as Record<string, unknown>),
        ...((stored[key] ?? {}) as Record<string, unknown>),
      };
    }
  }
  return merged;
};

/**
 * Wraps a raw storage instance so that BOTH the async `get()` and the reactive
 * `getSnapshot()` deep-merge defaults with stored values. This ensures that
 * keys added in newer code versions are present even when the persisted object
 * predates them — no migration required.
 *
 * `getSnapshot` feeds React's `useSyncExternalStore`, which demands a
 * referentially stable result between changes, so the merged snapshot is
 * memoized on the raw snapshot's identity and only recomputed when the
 * underlying raw reference actually changes (i.e. after a `set`).
 *
 * @param rawStorage - The underlying chrome storage handle.
 * @param defaults   - Full default config object.
 * @param nestedKeys - Top-level keys whose values are objects that should also
 *                     be merged with their respective defaults (one level deep).
 */
const createMergingStorage = <T>(
  rawStorage: BaseStorageType<T>,
  defaults: T,
  nestedKeys?: (keyof T)[],
): BaseStorageType<T> => {
  let lastRaw: T | null = null;
  let lastMerged: T | null = null;

  return {
    get: async (): Promise<T> => mergeDefaults(defaults, await rawStorage.get(), nestedKeys),
    set: (value: ValueOrUpdateType<T>) => rawStorage.set(value),
    getSnapshot: () => {
      const raw = rawStorage.getSnapshot();
      if (raw === null) return null;
      if (raw !== lastRaw) {
        lastRaw = raw;
        lastMerged = mergeDefaults(defaults, raw, nestedKeys);
      }
      return lastMerged;
    },
    subscribe: (listener: () => void) => rawStorage.subscribe(listener),
  };
};

export { createMergingStorage };
