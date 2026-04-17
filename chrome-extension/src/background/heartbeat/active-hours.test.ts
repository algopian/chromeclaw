// Unit tests for active-hours + reason classification (R20 / 02.24).

import { describe, expect, it } from 'vitest';
import { isWithinActiveHours } from './active-hours';
import { classifyReason, isActionLikeReason } from './reason';

describe('isWithinActiveHours', () => {
  it('returns true when config is missing', () => {
    expect(isWithinActiveHours(undefined)).toBe(true);
  });

  it('returns true for malformed time strings (permissive)', () => {
    expect(
      isWithinActiveHours({ start: 'nope', end: '25:00', timezone: 'UTC' }),
    ).toBe(true);
  });

  it('returns false when start === end (degenerate window)', () => {
    expect(isWithinActiveHours({ start: '09:00', end: '09:00', timezone: 'UTC' })).toBe(false);
  });

  it('accepts 24:00 as end-of-day', () => {
    // A UTC moment at 23:30 should be inside "00:00 - 24:00".
    const at = Date.UTC(2026, 0, 1, 23, 30);
    expect(
      isWithinActiveHours({ start: '00:00', end: '24:00', timezone: 'UTC' }, at),
    ).toBe(true);
  });

  it('handles a normal daytime window', () => {
    const morning = Date.UTC(2026, 0, 1, 10, 0);
    const night = Date.UTC(2026, 0, 1, 22, 0);
    expect(
      isWithinActiveHours({ start: '09:00', end: '18:00', timezone: 'UTC' }, morning),
    ).toBe(true);
    expect(
      isWithinActiveHours({ start: '09:00', end: '18:00', timezone: 'UTC' }, night),
    ).toBe(false);
  });

  it('handles wrap-around (night shift) windows', () => {
    const late = Date.UTC(2026, 0, 1, 23, 30);
    const early = Date.UTC(2026, 0, 1, 5, 30);
    const midday = Date.UTC(2026, 0, 1, 12, 0);
    const cfg = { start: '22:00', end: '06:00', timezone: 'UTC' };
    expect(isWithinActiveHours(cfg, late)).toBe(true);
    expect(isWithinActiveHours(cfg, early)).toBe(true);
    expect(isWithinActiveHours(cfg, midday)).toBe(false);
  });

  it('falls back to permissive when timezone is invalid', () => {
    const at = Date.UTC(2026, 0, 1, 12, 0);
    expect(
      isWithinActiveHours({ start: '09:00', end: '18:00', timezone: 'Mars/Olympus' }, at),
    ).toBeTypeOf('boolean');
  });
});

describe('classifyReason', () => {
  it('maps empty / unknown to interval', () => {
    expect(classifyReason(undefined)).toBe('interval');
    expect(classifyReason('')).toBe('interval');
  });

  it('preserves known reasons', () => {
    expect(classifyReason('manual')).toBe('manual');
    expect(classifyReason('retry')).toBe('retry');
    expect(classifyReason('exec-event')).toBe('exec-event');
    expect(classifyReason('wake')).toBe('wake');
  });

  it('preserves cron:<detail> and collapses bare cron', () => {
    expect(classifyReason('cron:abc')).toBe('cron:abc');
    expect(classifyReason('cron')).toBe('cron:unknown');
  });

  it('accepts trigger object form', () => {
    expect(classifyReason({ kind: 'manual' })).toBe('manual');
  });

  it('falls back to "other" for unrecognized strings', () => {
    expect(classifyReason('foo')).toBe('other');
  });
});

describe('isActionLikeReason', () => {
  it('treats manual / exec-event / wake / cron:* as action-like', () => {
    expect(isActionLikeReason('manual')).toBe(true);
    expect(isActionLikeReason('exec-event')).toBe(true);
    expect(isActionLikeReason('wake')).toBe(true);
    expect(isActionLikeReason('cron:job-7')).toBe(true);
  });

  it('treats interval / retry / other as non-action', () => {
    expect(isActionLikeReason('interval')).toBe(false);
    expect(isActionLikeReason('retry')).toBe(false);
    expect(isActionLikeReason('other')).toBe(false);
  });
});
