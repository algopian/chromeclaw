// ── Visibility resolution ───────────────────────
// Simplified from OpenClaw's multi-layer (cfg/channel/account) resolver —
// ChromeClaw has only a per-agent config + defaults layer.

import type { HeartbeatConfig, HeartbeatVisibilityConfig } from './types';

interface ResolvedHeartbeatVisibility {
  showOk: boolean;
  showAlerts: boolean;
  useIndicator: boolean;
}

const DEFAULT_VISIBILITY: ResolvedHeartbeatVisibility = {
  showOk: false,
  showAlerts: true,
  useIndicator: true,
};

/**
 * Merge per-agent visibility config with defaults. Unset fields fall through
 * to `DEFAULT_VISIBILITY` (silent OKs, visible alerts, on-screen indicator).
 */
const resolveVisibility = (
  config: HeartbeatConfig | undefined,
  defaults?: HeartbeatVisibilityConfig,
): ResolvedHeartbeatVisibility => {
  const perAgent = config?.visibility;
  return {
    showOk: perAgent?.showOk ?? defaults?.showOk ?? DEFAULT_VISIBILITY.showOk,
    showAlerts: perAgent?.showAlerts ?? defaults?.showAlerts ?? DEFAULT_VISIBILITY.showAlerts,
    useIndicator:
      perAgent?.useIndicator ?? defaults?.useIndicator ?? DEFAULT_VISIBILITY.useIndicator,
  };
};

export { resolveVisibility, DEFAULT_VISIBILITY };
export type { ResolvedHeartbeatVisibility };
