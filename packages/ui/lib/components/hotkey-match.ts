/**
 * Decide whether a raw keyboard event should start/stop mic recording. Kept
 * pure (no DOM, no React) so both `MicButton` and its unit test share the exact
 * same rules.
 *
 * Push-to-talk: recording runs only while the hotkey is held.
 * - `shouldHotkeyStart` fires on a fresh `keydown` (`repeat === false`) whose
 *   `KeyboardEvent.code` equals the configured hotkey, only when a click would
 *   also be honoured (not `disabled`, not mid-`processing`, not already
 *   `recording`).
 * - `shouldHotkeyStop` fires on the matching `keyup` while `recording`. Once
 *   armed, releasing the key must always stop, no matter where focus has moved.
 *
 * Editable-target guard: a printable hotkey (letter/digit/Space/…) must not arm
 * the mic while the user is typing in an input/textarea/contenteditable, or the
 * user could never type that character. A lone modifier (Alt/Ctrl/Shift/Meta)
 * inserts no text when held on its own, so it is allowed even when a text field
 * has focus — this is what lets the default Right Alt dictate straight from the
 * focused chat input.
 *
 * An empty or undefined `hotkey` disables the shortcut entirely.
 */
const MODIFIER_CODES = new Set([
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
]);

/** True when `code` is a lone modifier key that types nothing when held alone. */
export const isModifierCode = (code: string | undefined): boolean =>
  !!code && MODIFIER_CODES.has(code);

export const shouldHotkeyStart = (
  hotkey: string | undefined,
  event: { code: string; repeat: boolean },
  guards: { disabled?: boolean; processing: boolean; recording: boolean; editableTarget?: boolean },
): boolean => {
  if (!hotkey || event.repeat || event.code !== hotkey) return false;
  if (guards.editableTarget && !isModifierCode(hotkey)) return false;
  if (guards.disabled || guards.processing || guards.recording) return false;
  return true;
};

export const shouldHotkeyStop = (
  hotkey: string | undefined,
  event: { code: string },
  guards: { recording: boolean },
): boolean => {
  if (!hotkey || event.code !== hotkey) return false;
  return guards.recording;
};
