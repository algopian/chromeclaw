import { geminiWebProvider } from './gemini-web';
import { openaiProvider } from './openai';
import { transformersProvider } from './transformers';
import type { MediaProvider } from '../types';

const PROVIDERS: MediaProvider[] = [openaiProvider, transformersProvider, geminiWebProvider];

const registry = new Map<string, MediaProvider>();
for (const p of PROVIDERS) registry.set(p.id, p);

const getProvider = (id: string): MediaProvider | undefined => registry.get(id);

export { getProvider, PROVIDERS };
