/**
 * Speech plugin registry — single source of truth for all speech web provider plugins.
 *
 * Adding a new speech provider:
 * 1. Create providers/{id}.speech.ts
 * 2. Import and add to the `speechPlugins` array below
 * 3. Add the id to MediaEngine in media-understanding/types.ts
 * 4. Add the id to SttConfig.engine in storage
 *
 * Mirrors `web-providers/plugin-registry.ts` (LLM side).
 */

import { geminiWebSpeechPlugin } from './providers/gemini-web.speech';
import type { SpeechWebProviderPlugin } from './plugin-types';

const speechPlugins: readonly SpeechWebProviderPlugin[] = [geminiWebSpeechPlugin];

const pluginMap = new Map<string, SpeechWebProviderPlugin>(
  speechPlugins.map(p => [p.definition.id, p]),
);

/** Look up a speech web provider plugin by ID. */
const getSpeechPlugin = (id: string): SpeechWebProviderPlugin | undefined => pluginMap.get(id);

/** Get all registered speech web provider plugins. */
const getAllSpeechPlugins = (): readonly SpeechWebProviderPlugin[] => speechPlugins;

export { getSpeechPlugin, getAllSpeechPlugins };
