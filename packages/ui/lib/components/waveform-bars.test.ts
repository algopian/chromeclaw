/**
 * Tests for waveform-bars.ts — pure bar-height math, no DOM / Web Audio.
 */
import { computeWaveformBars, BAR_FLOOR } from './waveform-bars';
import { describe, it, expect } from 'vitest';

describe('computeWaveformBars', () => {
  it('returns an empty array for a non-positive bar count', () => {
    expect(computeWaveformBars(new Uint8Array([1, 2, 3]), 0)).toEqual([]);
    expect(computeWaveformBars(new Uint8Array([1, 2, 3]), -4)).toEqual([]);
  });

  it('returns all-floor bars when there is no frequency data', () => {
    expect(computeWaveformBars(new Uint8Array([]), 4)).toEqual([
      BAR_FLOOR,
      BAR_FLOOR,
      BAR_FLOOR,
      BAR_FLOOR,
    ]);
  });

  it('produces exactly barCount bars', () => {
    const freq = new Uint8Array(64).fill(128);
    expect(computeWaveformBars(freq, 8)).toHaveLength(8);
    expect(computeWaveformBars(freq, 1)).toHaveLength(1);
  });

  it('floors silence (all-zero spectrum) to BAR_FLOOR', () => {
    const bars = computeWaveformBars(new Uint8Array(32).fill(0), 4);
    expect(bars.every(b => b === BAR_FLOOR)).toBe(true);
  });

  it('maps a full-scale spectrum to 1', () => {
    const bars = computeWaveformBars(new Uint8Array(32).fill(255), 4);
    expect(bars.every(b => b === 1)).toBe(true);
  });

  it('normalises a mid-level spectrum to roughly 0.5', () => {
    const bars = computeWaveformBars(new Uint8Array(16).fill(128), 4);
    for (const b of bars) {
      expect(b).toBeCloseTo(128 / 255, 5);
    }
  });

  it('keeps every bar within [BAR_FLOOR, 1]', () => {
    const freq = new Uint8Array(50);
    for (let i = 0; i < freq.length; i++) freq[i] = (i * 37) % 256;
    for (const b of computeWaveformBars(freq, 12)) {
      expect(b).toBeGreaterThanOrEqual(BAR_FLOOR);
      expect(b).toBeLessThanOrEqual(1);
    }
  });

  it('averages within each bucket (loud low half, silent high half)', () => {
    // 8 samples: first 4 at max, last 4 at zero → 2 bars: bar0≈1, bar1≈floor.
    const freq = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]);
    const bars = computeWaveformBars(freq, 2);
    expect(bars[0]).toBe(1);
    expect(bars[1]).toBe(BAR_FLOOR);
  });
});
