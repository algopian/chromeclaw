import { describe, it, expect, vi } from 'vitest';
import { createMergingStorage } from './create-merging-storage';
import type { BaseStorageType } from '../base/types';

/** Create a minimal fake raw storage backed by an in-memory value. */
const fakeRawStorage = <T>(initial: T): BaseStorageType<T> => {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: vi.fn(async () => value),
    set: vi.fn(async (v: T | ((prev: T) => T | Promise<T>)) => {
      value = typeof v === 'function' ? await (v as (prev: T) => T | Promise<T>)(value) : v;
      listeners.forEach(l => l());
    }),
    getSnapshot: vi.fn(() => value),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
};

describe('createMergingStorage', () => {
  it('merges top-level defaults with stored values', async () => {
    const defaults = { a: 1, b: 'hello', c: true };
    const raw = fakeRawStorage({ a: 42 } as typeof defaults);
    const storage = createMergingStorage(raw, defaults);

    const result = await storage.get();
    expect(result).toEqual({ a: 42, b: 'hello', c: true });
  });

  it('returns full defaults when stored value matches defaults', async () => {
    const defaults = { x: 10, y: 20 };
    const raw = fakeRawStorage(defaults);
    const storage = createMergingStorage(raw, defaults);

    const result = await storage.get();
    expect(result).toEqual(defaults);
  });

  it('deep-merges nested keys', async () => {
    const defaults = {
      engine: 'kokoro' as const,
      kokoro: { model: 'default-model', voice: 'af_heart', speed: 1.0 },
      openai: { model: 'tts-1', voice: 'nova' },
    };
    // Stored value is missing kokoro.speed and openai entirely
    const stored = {
      engine: 'kokoro' as const,
      kokoro: { model: 'custom-model', voice: 'bf_emma' },
      openai: undefined,
    } as unknown as typeof defaults;
    const raw = fakeRawStorage(stored);
    const storage = createMergingStorage(raw, defaults, ['kokoro', 'openai']);

    const result = await storage.get();
    expect(result.kokoro).toEqual({ model: 'custom-model', voice: 'bf_emma', speed: 1.0 });
    expect(result.openai).toEqual({ model: 'tts-1', voice: 'nova' });
  });

  it('delegates set/getSnapshot/subscribe to raw storage', async () => {
    const defaults = { a: 1 };
    const raw = fakeRawStorage(defaults);
    const storage = createMergingStorage(raw, defaults);

    await storage.set({ a: 99 });
    expect(raw.set).toHaveBeenCalledWith({ a: 99 });

    storage.getSnapshot();
    expect(raw.getSnapshot).toHaveBeenCalled();

    const listener = vi.fn();
    storage.subscribe(listener);
    expect(raw.subscribe).toHaveBeenCalledWith(listener);
  });

  it('merges defaults into getSnapshot for configs that predate a new key', () => {
    // Reactive path (useStorage → useSyncExternalStore) must backfill new keys
    // the same way get() does, or an old persisted config yields undefined.
    const defaults = { a: 1, b: 'hello', c: true };
    const raw = fakeRawStorage({ a: 42 } as typeof defaults);
    const storage = createMergingStorage(raw, defaults);

    expect(storage.getSnapshot()).toEqual({ a: 42, b: 'hello', c: true });
  });

  it('deep-merges nested keys in getSnapshot', () => {
    const defaults = {
      engine: 'kokoro' as const,
      openai: { model: 'tts-1', voice: 'nova' },
    };
    const stored = { engine: 'kokoro' as const, openai: undefined } as unknown as typeof defaults;
    const raw = fakeRawStorage(stored);
    const storage = createMergingStorage(raw, defaults, ['openai']);

    expect(storage.getSnapshot()?.openai).toEqual({ model: 'tts-1', voice: 'nova' });
  });

  it('returns null from getSnapshot before the raw cache is populated', () => {
    const defaults = { a: 1 };
    const raw = fakeRawStorage(null as unknown as typeof defaults);
    const storage = createMergingStorage(raw, defaults);

    expect(storage.getSnapshot()).toBeNull();
  });

  it('returns a referentially stable getSnapshot until the raw value changes', async () => {
    // useSyncExternalStore infinite-loops unless getSnapshot is stable between
    // changes; the merged object must be memoized on the raw snapshot identity.
    const defaults = { a: 1, b: 2 };
    const raw = fakeRawStorage({ a: 42 } as typeof defaults);
    const storage = createMergingStorage(raw, defaults);

    const first = storage.getSnapshot();
    expect(storage.getSnapshot()).toBe(first);

    await storage.set({ a: 7 } as typeof defaults);
    const afterSet = storage.getSnapshot();
    expect(afterSet).not.toBe(first);
    expect(afterSet).toEqual({ a: 7, b: 2 });
  });
});
