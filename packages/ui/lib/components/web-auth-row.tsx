import { Button } from './ui';
import { AlertCircleIcon, CheckCircle2Icon, LoaderIcon, LogInIcon, LogOutIcon } from 'lucide-react';
import type { SpeechAuthStatus } from '@extension/shared';

export interface WebAuthRowLabels {
  checking: string;
  loggedIn: string;
  expired: string;
  notLoggedIn: string;
  login: string;
  signingIn: string;
  logout: string;
}

export interface WebAuthRowProps {
  status: SpeechAuthStatus;
  loginLoading: boolean;
  error: string | null;
  login: () => void;
  logout: () => void;
  labels: WebAuthRowLabels;
  className?: string;
  /** Extra disable condition for the login button (in addition to loginLoading). */
  loginDisabled?: boolean;
}

/**
 * Shared login/logout status row for browser-session web auth (e.g. gemini-web).
 * Presentational — the caller owns the `useWebAuth` hook and supplies i18n labels.
 */
export const WebAuthRow = ({
  status,
  loginLoading,
  error,
  login,
  logout,
  labels,
  className,
  loginDisabled,
}: WebAuthRowProps) => (
  <div className={className}>
    <div className="flex items-center gap-3">
      <span className="text-sm">
        {status === 'checking' && (
          <span className="text-muted-foreground flex items-center gap-1.5">
            <LoaderIcon className="size-3.5 animate-spin" />
            {labels.checking}
          </span>
        )}
        {status === 'logged-in' && (
          <span className="flex items-center gap-1.5 text-green-600">
            <CheckCircle2Icon className="size-3.5" />
            {labels.loggedIn}
          </span>
        )}
        {status === 'expired' && (
          <span className="flex items-center gap-1.5 text-amber-600">
            <AlertCircleIcon className="size-3.5" />
            {labels.expired}
          </span>
        )}
        {status === 'not-logged-in' && (
          <span className="text-muted-foreground flex items-center gap-1.5">
            <AlertCircleIcon className="size-3.5" />
            {labels.notLoggedIn}
          </span>
        )}
      </span>

      {(status === 'not-logged-in' || status === 'expired') && (
        <Button
          disabled={loginLoading || loginDisabled}
          onClick={login}
          size="sm"
          variant="outline">
          {loginLoading ? (
            <LoaderIcon className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <LogInIcon className="mr-1.5 size-3.5" />
          )}
          {loginLoading ? labels.signingIn : labels.login}
        </Button>
      )}

      {status === 'logged-in' && (
        <Button onClick={logout} size="sm" variant="ghost">
          <LogOutIcon className="mr-1.5 size-3.5" />
          {labels.logout}
        </Button>
      )}
    </div>

    {error && (
      <p className="flex items-center gap-1.5 text-xs text-red-600">
        <AlertCircleIcon className="size-3" />
        {error}
      </p>
    )}
  </div>
);
