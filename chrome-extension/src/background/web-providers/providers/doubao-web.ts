/**
 * Doubao (www.doubao.com) — web provider using ByteDance's Samantha API.
 *
 * Uses binaryProtocol: 'doubao' to trigger a custom MAIN world handler in
 * content-fetch-main.ts, because the Samantha API returns a non-standard
 * streaming format: each line is a JSON object with `event_type` (number)
 * and `event_data` (JSON string), rather than standard SSE `event:`/`data:`
 * fields. The MAIN world handler reformats these into standard SSE events
 * that the bridge can process normally.
 *
 * Stateful provider that uses `conversation_id` for multi-turn context.
 * Authentication is cookie-based (sessionid) — no bearer token or PoW needed.
 * The lightweight stub body ({ prompt, conversationId }) is parsed by the
 * MAIN world handler, which builds the real Samantha API request.
 */

import type { WebProviderDefinition } from '../types';

const doubaoWeb: WebProviderDefinition = {
  id: 'doubao-web',
  name: 'Doubao (Web)',
  loginUrl: 'https://www.doubao.com/chat/',
  cookieDomain: '.doubao.com',
  sessionIndicators: ['sessionid'],
  defaultModelId: 'doubao-seed-2.0',
  defaultModelName: 'Doubao Seed 2.0',
  supportsTools: true,
  supportsReasoning: false,
  contextWindow: 64_000,
  buildRequest: opts => {
    // Strategy builds the full prompt in opts.messages[0].content
    const prompt = opts.messages[0]?.content ?? '';
    const conversationId = opts.conversationId;

    return {
      url: 'https://www.doubao.com/samantha/chat/completion',
      binaryProtocol: 'doubao',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Lightweight body — real request is built in MAIN world (content-fetch-main.ts)
        body: JSON.stringify({ prompt, conversationId }),
        credentials: 'include' as RequestCredentials,
      },
    };
  },
  parseSseDelta: () => null, // Handled by doubao stream adapter
};

export { doubaoWeb };
