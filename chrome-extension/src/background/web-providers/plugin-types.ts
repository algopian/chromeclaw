/**
 * Plugin system types for web LLM providers.
 *
 * A WebProviderPlugin bundles everything a provider needs — definition,
 * stream adapter factory, tool strategy, lifecycle hooks, and optional
 * MAIN world content-fetch handler — into a single registerable object.
 */

import type { WebProviderDefinition, WebProviderId } from './types';
import type { SseStreamAdapter } from './sse-stream-adapter';
import type { WebProviderToolStrategy } from './tool-strategy';
import type { ContentFetchRequest } from './content-fetch-main';
import type { WebProviderCredential } from '@extension/storage';

// ── Hook context types ──────────────────────────────

interface StreamDoneContext {
  providerId: WebProviderId;
  credential: WebProviderCredential;
}

interface MetadataContext {
  providerId: WebProviderId;
  metadata: Record<string, unknown>;
}

interface SessionCheckContext {
  providerId: WebProviderId;
  credential: WebProviderCredential;
}

// ── Hook interface ──────────────────────────────────

interface WebProviderHooks {
  /** Called after WEB_LLM_DONE — e.g., record lastRequestAt for stale-session detection. */
  onStreamDone?: (ctx: StreamDoneContext) => void;
  /** Called on WEB_LLM_METADATA — e.g., persist deviceId for cross-request stability. */
  onMetadata?: (ctx: MetadataContext) => void;
  /** Called before tab injection when an existing tab is found — return true to force reload. */
  shouldReloadTab?: (ctx: SessionCheckContext) => boolean;
  /** Whether this provider supports WEB_LLM_RETRY_REFRESH (tab refresh + re-inject on 403). */
  supportsRetryRefresh?: boolean;
}

// ── Plugin interface ────────────────────────────────

interface WebProviderPlugin {
  readonly definition: WebProviderDefinition;

  /** Create a provider-specific SSE stream adapter. Falls back to default passthrough if unset. */
  createStreamAdapter?: (opts?: {
    excludeTools?: ReadonlySet<string>;
  }) => SseStreamAdapter;

  /** Provider-specific tool strategy. Falls back to defaultToolStrategy if unset. */
  toolStrategy?: WebProviderToolStrategy;

  /** Lifecycle hooks called by the bridge at specific points in the stream lifecycle. */
  hooks?: WebProviderHooks;

  /**
   * MAIN world content-fetch handler for providers with custom binary protocols.
   * If unset, the bridge injects the shared mainWorldFetch (Connect Protocol + SSE).
   */
  contentFetchHandler?: (request: ContentFetchRequest) => Promise<void>;
}

export type {
  WebProviderPlugin,
  WebProviderHooks,
  StreamDoneContext,
  MetadataContext,
  SessionCheckContext,
};
