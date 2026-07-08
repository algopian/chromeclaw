/**
 * Plugin system types for speech web providers.
 *
 * A SpeechWebProviderPlugin bundles everything a browser-session speech
 * provider needs — definition (auth info), request encoder, result decoder,
 * and MAIN-world transport — into a single registerable object.
 *
 * Mirrors `web-providers/plugin-types.ts` (LLM side).
 */

/** The generic uplink payload that all speech plugins produce. */
interface SpeechFetchRequest {
  requestId: string;
  /** base64url config frame. */
  configFrame: string;
  /** base64url audio frames, in order. */
  audioFrames: string[];
  /** base64url end frame. */
  endFrame: string;
}

/** Auth/identity definition for a speech web provider. */
interface SpeechWebProviderDefinition {
  /** Must match the MediaEngine / SttConfig.engine literal, e.g. 'gemini-web'. */
  id: string;
  /** Human-readable name, e.g. 'Gemini (browser session)'. */
  name: string;
  /** Cookie domain to check for session indicators. */
  cookieDomain: string;
  /** Cookie names that indicate an active session. */
  sessionIndicators: string[];
  /** URL to open for the user to log in. */
  loginUrl: string;
}

/** A registered speech web provider plugin. */
interface SpeechWebProviderPlugin {
  readonly definition: SpeechWebProviderDefinition;

  /** Build the provider-specific uplink frames for the MAIN-world client. */
  encodeRequest(audio: ArrayBuffer, language: string): SpeechFetchRequest;

  /** Select + assemble the transcript from the collected downlink payloads. */
  decodeResult(payloads: string[]): string;

  /** MAIN-world transport injected via chrome.scripting.executeScript({ func }). */
  channelClient: (request: SpeechFetchRequest) => Promise<void>;
}

/** Auth-subset that checkWebAuth / initiateWebLogin already accept. */
type WebAuthDefinition = Pick<
  SpeechWebProviderDefinition,
  'id' | 'cookieDomain' | 'sessionIndicators' | 'loginUrl'
>;

export type {
  SpeechFetchRequest,
  SpeechWebProviderDefinition,
  SpeechWebProviderPlugin,
  WebAuthDefinition,
};
