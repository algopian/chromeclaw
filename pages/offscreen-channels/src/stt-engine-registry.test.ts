// Locks the invariant that every STT engine in the SttEngine union is registered
// with a working transcribe fn. This is the failure mode the registry exists to
// prevent: an engine that passes tests / downloads but errors on first hotkey
// dictation because its transcribe branch was never wired up.

import { getSttEngine, registeredSttEngineIds } from './stt-engine-registry';
import type { SttEngine } from './stt-engine-registry';
import { describe, expect, it, vi } from 'vitest';

// stt-worker performs the registrations at module load. Importing it (rather
// than re-registering here) asserts the REAL wiring, not a test double.
vi.stubGlobal('chrome', {
  runtime: {
    getURL: (p: string) => `chrome-extension://test/${p}`,
    sendMessage: () => Promise.resolve(),
  },
});
await import('./stt-worker');

// The full set of engine ids the union promises. Keep in sync with SttEngine.
const ALL_ENGINE_IDS: SttEngine[] = ['transformers', 'sensevoice'];

describe('stt-engine-registry', () => {
  it('registers every engine id in the SttEngine union', () => {
    const registered = registeredSttEngineIds().sort();
    expect(registered).toEqual([...ALL_ENGINE_IDS].sort());
  });

  for (const id of ALL_ENGINE_IDS) {
    it(`resolves '${id}' with a transcribe function`, () => {
      const impl = getSttEngine(id);
      expect(impl).toBeDefined();
      expect(typeof impl?.transcribe).toBe('function');
    });
  }
});
