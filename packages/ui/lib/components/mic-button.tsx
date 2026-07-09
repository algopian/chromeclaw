import { Button } from './ui';
import { useT } from '@extension/i18n';
import { LoaderIcon, MicIcon, SquareIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

type MicButtonProps = {
  /**
   * Called with the recorded clip once the user stops. `base64` is the RAW
   * base64 body (no `data:` prefix) so the background `TRANSCRIBE_DICTATION`
   * handler can `atob()` it directly. May be async — while it resolves the
   * button shows a processing spinner. This component touches no chrome APIs;
   * the parent owns the transcription round-trip.
   */
  onAudio: (base64: string, mimeType: string) => void | Promise<void>;
  /**
   * Called when getUserMedia is rejected because microphone permission is
   * missing (`NotAllowedError` — includes Chrome's "Permission dismissed").
   * The side panel's own prompt is unreliable, so the parent handles this by
   * opening a dedicated permission popup window. When omitted, the component
   * just surfaces the generic error toast.
   */
  onPermissionNeeded?: () => void;
  /**
   * Called with the live capture stream when recording starts and `null` when
   * it stops (or on unmount). Lets the parent render a waveform in the footer
   * bar rather than on the button itself.
   */
  onStreamChange?: (stream: MediaStream | null) => void;
  disabled?: boolean;
};

type MicState = 'idle' | 'recording' | 'processing';

/** Strip the `data:<mime>;base64,` prefix, leaving the raw base64 body. */
const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read audio'));
    reader.readAsDataURL(blob);
  });

/**
 * Chat-input microphone toggle. Click to record via getUserMedia + MediaRecorder,
 * click again to stop; the recorded clip is emitted as base64 through `onAudio`.
 * Always stops the mic track on stop/error/unmount so no capture indicator lingers.
 */
const MicButton = ({ onAudio, onPermissionNeeded, onStreamChange, disabled }: MicButtonProps) => {
  const t = useT();
  const [state, setState] = useState<MicState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Keep the latest callback in a ref so the record/stop callbacks stay stable
  // and the unmount cleanup can always reach the current handler.
  const onStreamChangeRef = useRef(onStreamChange);
  onStreamChangeRef.current = onStreamChange;

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    onStreamChangeRef.current?.(null);
  }, []);

  // Safety net: tear down capture if unmounted mid-recording.
  useEffect(
    () => () => {
      const rec = recorderRef.current;
      if (rec && rec.state === 'recording') rec.stop();
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      onStreamChangeRef.current?.(null);
    },
    [],
  );

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      onStreamChangeRef.current?.(stream);
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        stopStream();

        if (blob.size === 0) {
          console.warn('[mic] recording produced an empty blob; nothing to transcribe', {
            mimeType: type,
          });
          setState('idle');
          return;
        }

        setState('processing');
        try {
          const base64 = await blobToBase64(blob);
          await onAudio(base64, blob.type || type);
        } catch (err) {
          console.error('[mic] failed to process/transcribe recording', err);
          toast.error(t('chat_mic_error'));
        } finally {
          setState('idle');
        }
      };

      recorder.start();
      setState('recording');
    } catch (err) {
      stopStream();
      setState('idle');
      // A missing mic permission surfaces as NotAllowedError (Chrome uses this
      // for both a hard block and its unreliable "Permission dismissed" case in
      // the side panel). Hand off to the parent to open a proper permission
      // popup instead of showing the generic failure toast.
      const isPermission = err instanceof DOMException && err.name === 'NotAllowedError';
      if (isPermission && onPermissionNeeded) {
        console.warn('[mic] microphone permission missing; requesting permission popup', err);
        toast.info(t('chat_mic_permission'));
        onPermissionNeeded();
        return;
      }
      console.error('[mic] failed to start recording (getUserMedia/MediaRecorder)', err);
      toast.error(t('chat_mic_error'));
    }
  }, [onAudio, onPermissionNeeded, stopStream, t]);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state === 'recording') rec.stop();
  }, []);

  const handleClick = useCallback(() => {
    if (state === 'recording') stopRecording();
    else if (state === 'idle') startRecording();
  }, [state, startRecording, stopRecording]);

  const isRecording = state === 'recording';
  const label = isRecording ? t('chat_mic_stop') : t('chat_mic_start');

  return (
    <Button
      aria-label={label}
      className="shrink-0 gap-1.5 rounded-lg"
      data-testid="mic-button"
      disabled={disabled || state === 'processing'}
      onClick={handleClick}
      size="icon"
      title={label}
      type="button"
      variant="default">
      {state === 'processing' ? (
        <LoaderIcon className="size-4 animate-spin" />
      ) : isRecording ? (
        <SquareIcon className="size-4 fill-current" />
      ) : (
        <MicIcon className="size-4" />
      )}
    </Button>
  );
};

export { MicButton };
export type { MicButtonProps };
