// ──────────────────────────────────────────────
// STT Engine Registry — single dispatch point for local STT engines
// ──────────────────────────────────────────────
// Every local STT engine (Whisper via transformers, SenseVoice via sherpa-wasm,
// and any future engine) registers ONE LocalSttEngine here. The offscreen
// dispatch (`transcribeAudio` / `handleModelDownload`) then looks the engine up
// instead of branching on `if (engine === …)` in two parallel chains.
//
// Why this matters for the hotkey: the push-to-talk hotkey is the ONLY entry
// point that runs `transcribe` (the Download button only runs `download`). When
// dispatch was two hand-maintained if-chains, adding an engine and forgetting
// the transcribe branch produced an "Unknown STT engine" error that surfaced
// only on first dictation. A single registration entry removes that failure mode
// — register once and both transcribe + download work.

/** Identifier for a local STT engine. Extend this union to add an engine. */
type SttEngine = 'transformers' | 'sensevoice';

/**
 * A local STT engine. `transcribe` turns a recorded clip into text; `download`
 * pre-fetches whatever model assets the engine needs so first-use dictation
 * doesn't block on a large download. An engine that has no separate pre-download
 * step may omit `download`.
 */
interface LocalSttEngine {
  id: SttEngine;
  transcribe: (
    audio: ArrayBuffer,
    requestId: string,
    model: string,
    language: string,
  ) => Promise<string>;
  download?: (model: string, downloadId: string) => Promise<void>;
}

const registry = new Map<SttEngine, LocalSttEngine>();

/** Register a local STT engine. Called once per engine at module load. */
const registerSttEngine = (engine: LocalSttEngine): void => {
  registry.set(engine.id, engine);
};

/** Look up a registered engine, or `undefined` if the id is unknown. */
const getSttEngine = (id: SttEngine): LocalSttEngine | undefined => registry.get(id);

/** All registered engine ids — used by tests to assert the registry is complete. */
const registeredSttEngineIds = (): SttEngine[] => [...registry.keys()];

export { registerSttEngine, getSttEngine, registeredSttEngineIds };
export type { SttEngine, LocalSttEngine };
