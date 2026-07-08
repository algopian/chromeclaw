/**
 * Pure bar-height math for the recording waveform. Kept DOM-free so it can be
 * unit-tested without a real Web Audio graph.
 *
 * `freq` is the raw byte frequency data from an `AnalyserNode`
 * (`getByteFrequencyData`), where each value is 0..255. The function buckets
 * the spectrum into `barCount` bars, averages each bucket, normalises to 0..1,
 * and applies a small floor so idle/quiet bars stay faintly visible instead of
 * collapsing to nothing.
 */

/** Smallest normalised height so a bar never fully disappears while active. */
const BAR_FLOOR = 0.08;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Reduce a frequency spectrum to `barCount` normalised bar heights in [0, 1].
 * Returns an all-floor array when there is no data or a non-positive bar count.
 */
const computeWaveformBars = (freq: Uint8Array, barCount: number): number[] => {
  if (barCount <= 0) return [];
  if (freq.length === 0) return Array.from({ length: barCount }, () => BAR_FLOOR);

  const bucketSize = freq.length / barCount;
  const bars: number[] = [];

  for (let i = 0; i < barCount; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(freq.length, Math.floor((i + 1) * bucketSize));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += freq[j];
      count++;
    }
    const avg = count > 0 ? sum / count : 0;
    const normalised = clamp01(avg / 255);
    bars.push(Math.max(BAR_FLOOR, normalised));
  }

  return bars;
};

export { computeWaveformBars, BAR_FLOOR };
