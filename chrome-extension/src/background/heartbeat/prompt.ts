// ── Heartbeat prompt + token utilities ──────────
// Ported from OpenClaw's `src/auto-reply/heartbeat.ts` and `tokens.ts`.
//
// Responsibilities:
//  - Provide the default heartbeat prompt sent to the LLM on each tick.
//  - Strip the `HEARTBEAT_OK` sentinel from model output so we never deliver it.
//  - Decide if a given HEARTBEAT.md file has any actionable content at all.

const HEARTBEAT_TOKEN = 'HEARTBEAT_OK';

const HEARTBEAT_PROMPT =
  'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. ' +
  'Do not infer or repeat old tasks from prior chats. ' +
  `If nothing needs attention, reply ${HEARTBEAT_TOKEN}.`;

const DEFAULT_HEARTBEAT_EVERY = '30m';
const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

/** Escape a value so it can be embedded literally inside a RegExp. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Returns true iff the HEARTBEAT.md content has no actionable lines. Used to
 * short-circuit interval ticks when the file is a placeholder.
 */
const isHeartbeatContentEffectivelyEmpty = (content: string | undefined | null): boolean => {
  if (content === undefined || content === null) return true;
  if (typeof content !== 'string') return false;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // ATX markdown headers (#, ##, ...).
    if (/^#+(\s|$)/.test(trimmed)) continue;
    // Empty list items: "- ", "* [ ]", "+ [x]".
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) continue;
    return false;
  }
  return true;
};

/** Prefer the user-supplied prompt; fall back to the default. */
const resolveHeartbeatPrompt = (raw?: string): string => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || HEARTBEAT_PROMPT;
};

type StripHeartbeatMode = 'heartbeat' | 'message';

interface StripHeartbeatResult {
  shouldSkip: boolean;
  text: string;
  didStrip: boolean;
}

const stripTokenAtEdges = (raw: string): { text: string; didStrip: boolean } => {
  let text = raw.trim();
  if (!text) return { text: '', didStrip: false };

  const token = HEARTBEAT_TOKEN;
  const tokenAtEndWithOptionalTrailingPunctuation = new RegExp(
    `${escapeRegExp(token)}[^\\w]{0,4}$`,
  );
  if (!text.includes(token)) return { text, didStrip: false };

  let didStrip = false;
  let changed = true;
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(token)) {
      text = next.slice(token.length).trimStart();
      didStrip = true;
      changed = true;
      continue;
    }
    if (tokenAtEndWithOptionalTrailingPunctuation.test(next)) {
      const idx = next.lastIndexOf(token);
      const before = next.slice(0, idx).trimEnd();
      if (!before) {
        text = '';
      } else {
        const after = next.slice(idx + token.length).trimStart();
        text = `${before}${after}`.trimEnd();
      }
      didStrip = true;
      changed = true;
    }
  }

  return { text: text.replace(/\s+/g, ' ').trim(), didStrip };
};

/**
 * Strip the heartbeat acknowledgment token from model output.
 *
 * In `heartbeat` mode, if after stripping the remainder is within
 * `maxAckChars`, the whole response counts as an OK and `shouldSkip`
 * becomes true. In `message` mode the token is simply removed.
 */
const stripHeartbeatToken = (
  raw?: string,
  opts: { mode?: StripHeartbeatMode; maxAckChars?: number } = {},
): StripHeartbeatResult => {
  if (!raw) return { shouldSkip: true, text: '', didStrip: false };
  const trimmed = raw.trim();
  if (!trimmed) return { shouldSkip: true, text: '', didStrip: false };

  const mode: StripHeartbeatMode = opts.mode ?? 'message';
  const parsedAckChars =
    typeof opts.maxAckChars === 'string' ? Number(opts.maxAckChars) : opts.maxAckChars;
  const maxAckChars = Math.max(
    0,
    typeof parsedAckChars === 'number' && Number.isFinite(parsedAckChars)
      ? parsedAckChars
      : DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  const stripMarkup = (text: string): string =>
    text
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/^[*`~_]+/, '')
      .replace(/[*`~_]+$/, '');

  const trimmedNormalized = stripMarkup(trimmed);
  const hasToken = trimmed.includes(HEARTBEAT_TOKEN) || trimmedNormalized.includes(HEARTBEAT_TOKEN);
  if (!hasToken) return { shouldSkip: false, text: trimmed, didStrip: false };

  const strippedOriginal = stripTokenAtEdges(trimmed);
  const strippedNormalized = stripTokenAtEdges(trimmedNormalized);
  const picked =
    strippedOriginal.didStrip && strippedOriginal.text ? strippedOriginal : strippedNormalized;
  if (!picked.didStrip) return { shouldSkip: false, text: trimmed, didStrip: false };

  if (!picked.text) return { shouldSkip: true, text: '', didStrip: true };

  const rest = picked.text.trim();
  if (mode === 'heartbeat' && rest.length <= maxAckChars) {
    return { shouldSkip: true, text: '', didStrip: true };
  }
  return { shouldSkip: false, text: rest, didStrip: true };
};

export {
  HEARTBEAT_TOKEN,
  HEARTBEAT_PROMPT,
  DEFAULT_HEARTBEAT_EVERY,
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  isHeartbeatContentEffectivelyEmpty,
  resolveHeartbeatPrompt,
  stripHeartbeatToken,
};
export type { StripHeartbeatMode, StripHeartbeatResult };
