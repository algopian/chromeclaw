/**
 * Tests for hotkey-match.ts — the pure push-to-talk predicates shared by
 * MicButton. No DOM: events are plain `{ code, repeat }` objects.
 *
 * Model: hold-to-talk. `shouldHotkeyStart` arms on keydown; `shouldHotkeyStop`
 * releases on keyup while recording.
 */
import { shouldHotkeyStart, shouldHotkeyStop, isModifierCode } from './hotkey-match';
import { describe, it, expect } from 'vitest';

const idle = { disabled: false, processing: false, recording: false };

describe('shouldHotkeyStart', () => {
  it('fires when the code matches and it is a fresh press', () => {
    expect(shouldHotkeyStart('AltRight', { code: 'AltRight', repeat: false }, idle)).toBe(true);
  });

  it('does not fire when the code does not match', () => {
    expect(shouldHotkeyStart('AltRight', { code: 'AltLeft', repeat: false }, idle)).toBe(false);
  });

  it('does not fire on auto-repeat even when the code matches', () => {
    expect(shouldHotkeyStart('AltRight', { code: 'AltRight', repeat: true }, idle)).toBe(false);
  });

  it('does not fire when the hotkey is empty or undefined', () => {
    expect(shouldHotkeyStart('', { code: 'AltRight', repeat: false }, idle)).toBe(false);
    expect(shouldHotkeyStart(undefined, { code: 'AltRight', repeat: false }, idle)).toBe(false);
  });

  it('does not fire while disabled', () => {
    expect(
      shouldHotkeyStart(
        'AltRight',
        { code: 'AltRight', repeat: false },
        { disabled: true, processing: false, recording: false },
      ),
    ).toBe(false);
  });

  it('does not fire while processing', () => {
    expect(
      shouldHotkeyStart(
        'AltRight',
        { code: 'AltRight', repeat: false },
        { disabled: false, processing: true, recording: false },
      ),
    ).toBe(false);
  });

  it('does not fire while already recording', () => {
    expect(
      shouldHotkeyStart(
        'AltRight',
        { code: 'AltRight', repeat: false },
        { disabled: false, processing: false, recording: true },
      ),
    ).toBe(false);
  });

  it('does not fire when a printable-key hotkey targets an editable field', () => {
    expect(
      shouldHotkeyStart(
        'KeyK',
        { code: 'KeyK', repeat: false },
        { disabled: false, processing: false, recording: false, editableTarget: true },
      ),
    ).toBe(false);
  });

  it('still fires for a lone-modifier hotkey even when an editable field has focus', () => {
    // Right Alt (the default) types nothing on its own, so dictation must arm
    // straight from the focused chat input.
    expect(
      shouldHotkeyStart(
        'AltRight',
        { code: 'AltRight', repeat: false },
        { disabled: false, processing: false, recording: false, editableTarget: true },
      ),
    ).toBe(true);
  });

  it('treats an omitted disabled guard as not disabled', () => {
    expect(
      shouldHotkeyStart(
        'AltRight',
        { code: 'AltRight', repeat: false },
        { processing: false, recording: false },
      ),
    ).toBe(true);
  });

  it('matches a letter-key hotkey by code', () => {
    expect(shouldHotkeyStart('KeyK', { code: 'KeyK', repeat: false }, idle)).toBe(true);
    expect(shouldHotkeyStart('KeyK', { code: 'KeyJ', repeat: false }, idle)).toBe(false);
  });
});

describe('shouldHotkeyStop', () => {
  it('fires on keyup while recording when the code matches', () => {
    expect(shouldHotkeyStop('AltRight', { code: 'AltRight' }, { recording: true })).toBe(true);
  });

  it('does not fire when not recording', () => {
    expect(shouldHotkeyStop('AltRight', { code: 'AltRight' }, { recording: false })).toBe(false);
  });

  it('does not fire when the code does not match', () => {
    expect(shouldHotkeyStop('AltRight', { code: 'AltLeft' }, { recording: true })).toBe(false);
  });

  it('does not fire when the hotkey is empty or undefined', () => {
    expect(shouldHotkeyStop('', { code: 'AltRight' }, { recording: true })).toBe(false);
    expect(shouldHotkeyStop(undefined, { code: 'AltRight' }, { recording: true })).toBe(false);
  });

  it('ignores where focus is — a release always stops an armed recording', () => {
    // No editableTarget guard on stop: once armed, releasing must always stop.
    expect(shouldHotkeyStop('KeyK', { code: 'KeyK' }, { recording: true })).toBe(true);
  });
});

describe('isModifierCode', () => {
  it('is true for the sided modifier keys', () => {
    for (const code of ['AltLeft', 'AltRight', 'ControlLeft', 'ShiftRight', 'MetaLeft']) {
      expect(isModifierCode(code)).toBe(true);
    }
  });

  it('is false for printable and named keys', () => {
    for (const code of ['KeyK', 'Digit1', 'Space', 'Enter', 'Escape']) {
      expect(isModifierCode(code)).toBe(false);
    }
  });

  it('is false for empty or undefined input', () => {
    expect(isModifierCode('')).toBe(false);
    expect(isModifierCode(undefined)).toBe(false);
  });
});
