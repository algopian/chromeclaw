/**
 * Types for web-based LLM providers that use browser session cookies.
 * Web providers operate via `chrome.scripting.executeScript` in MAIN world,
 * inheriting the user's logged-in session on provider websites.
 */

/** Identifier for each supported web LLM provider. */
type WebProviderId =
  | 'claude-web'
  | 'kimi-web'
  | 'qwen-web'
  | 'qwen-cn-web'
  | 'glm-web'
  | 'glm-intl-web'
  | 'gemini-web';

/**
 * Credential type is defined in `@extension/storage` (web-credentials-storage.ts)
 * as the single source of truth. Import from there.
 */

/** Auth status for a web provider. */
type WebAuthStatus = 'not-logged-in' | 'checking' | 'logged-in' | 'expired';

/** Options passed to a provider's request builder. */
interface WebRequestOpts {
  messages: Array<{ role: string; content: string }>;
  systemPrompt: string;
  credential: { providerId: string; cookies: Record<string, string>; token?: string };
  /** Conversation ID for providers that use stateful conversations. */
  conversationId?: string;
}

/** Definition for a web LLM provider. */
interface WebProviderDefinition {
  id: WebProviderId;
  name: string;
  /** URL to open for the user to log in. */
  loginUrl: string;
  /** Cookie domain to check for session indicators. */
  cookieDomain: string;
  /** Cookie names that indicate an active session. */
  sessionIndicators: string[];
  /** Default model ID for this provider. */
  defaultModelId: string;
  /** Human-readable default model name. */
  defaultModelName: string;
  /** Whether this provider supports tool calling (via XML injection). */
  supportsTools: boolean;
  /** Whether this provider supports reasoning/thinking blocks. */
  supportsReasoning: boolean;
  /** Context window size in tokens. */
  contextWindow: number;
  /** Build the fetch request for a generation call. */
  buildRequest: (opts: WebRequestOpts) => {
    url: string;
    init: RequestInit;
    /** Optional setup request (e.g., create chat session) that runs before the main fetch. */
    setupRequest?: { url: string; init: RequestInit };
    /** When true, `url` is a template — `{key}` placeholders are replaced from setup response. */
    urlTemplate?: boolean;
    /** When set, the response uses a binary-framed protocol instead of plain SSE text. */
    binaryProtocol?: 'connect-json' | 'gemini-chunks';
    /** When true, encode the JSON body into a binary frame before sending. */
    binaryEncodeBody?: boolean;
  };
  /** Extract the text delta from a provider-specific SSE data payload. */
  parseSseDelta: (data: unknown) => string | null;
  /** Optional post-login auth refresh (e.g., GLM token exchange). Called with the login tab still open. */
  refreshAuth?: (opts: { tabId: number; cookies: Record<string, string> }) => Promise<Record<string, string> | null>;
}

export type { WebProviderId, WebAuthStatus, WebRequestOpts, WebProviderDefinition };
