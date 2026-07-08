import { computeWaveformBars } from './waveform-bars';
import { cn } from '../utils';
import { useEffect, useRef, useState } from 'react';

type WaveformProps = {
  /** Live capture stream. When null, nothing renders. */
  stream: MediaStream | null;
  /** Number of bars to draw. */
  barCount?: number;
  className?: string;
};

/** FFT window for the analyser — smallest power of two that gives enough bins. */
const FFT_SIZE = 32;

/**
 * Compact live audio-level waveform for the recording state. Taps the given
 * MediaStream with a Web Audio `AnalyserNode` and animates a small set of bars
 * driven by the input spectrum. The analyser is not connected to the audio
 * destination, so it never plays the mic back. All audio resources are torn
 * down when the stream changes or the component unmounts.
 */
const Waveform = ({ stream, barCount = 4, className }: WaveformProps) => {
  const [bars, setBars] = useState<number[]>(() =>
    computeWaveformBars(new Uint8Array(0), barCount),
  );

  const frameRef = useRef<number>(0);

  useEffect(() => {
    if (!stream) return;

    // Some browsers namespace AudioContext; fall back for older engines.
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const audioCtx = new Ctor();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    source.connect(analyser);
    // Intentionally NOT connected to audioCtx.destination — analysis only.

    const freq = new Uint8Array(analyser.frequencyBinCount);
    // Resume in case the context starts suspended (autoplay policy).
    void audioCtx.resume().catch(() => {});

    const tick = () => {
      analyser.getByteFrequencyData(freq);
      setBars(computeWaveformBars(freq, barCount));
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameRef.current);
      source.disconnect();
      void audioCtx.close().catch(() => {});
    };
  }, [stream, barCount]);

  return (
    <span
      aria-hidden="true"
      className={cn('flex h-4 w-4 items-center justify-center gap-[2px]', className)}
      data-testid="waveform">
      {bars.map((height, i) => (
        <span
          className="w-[2px] rounded-full bg-current"
          key={i}
          style={{ height: `${Math.round(height * 100)}%` }}
        />
      ))}
    </span>
  );
};

export { Waveform };
export type { WaveformProps };
