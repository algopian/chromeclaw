/**
 * Turn a raw `KeyboardEvent.code` into a friendly label (e.g. `AltRight` →
 * `Right Alt`, `Space` → `Space`, `KeyK` → `K`). Pure — no DOM — so it can be
 * unit tested. Unknown codes are returned as-is.
 */
export const formatKeyCode = (code: string): string => {
  if (!code) return '';
  const sideMatch = code.match(/^(Alt|Control|Shift|Meta)(Left|Right)$/);
  if (sideMatch) {
    const nameMap: Record<string, string> = {
      Alt: 'Alt',
      Control: 'Ctrl',
      Shift: 'Shift',
      Meta: 'Meta',
    };
    return `${sideMatch[2]} ${nameMap[sideMatch[1]]}`;
  }
  const letter = code.match(/^Key([A-Z])$/);
  if (letter) return letter[1];
  const digit = code.match(/^Digit([0-9])$/);
  if (digit) return digit[1];
  const named: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Escape: 'Esc',
    Backquote: '`',
    Tab: 'Tab',
    CapsLock: 'Caps Lock',
  };
  return named[code] ?? code;
};
