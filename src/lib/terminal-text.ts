/**
 * Terminal-safe text for one line (HACK-2177). Paths from project
 * configuration are input: a carriage return, a newline or an escape
 * sequence in one could rewrite or forge what the terminal shows (for
 * example erase the real target from a confirmation prompt). Every C0
 * control character (newline and tab included), DEL, and every C1 control
 * character is shown visibly as `\xNN`. Multi-line output escapes each line
 * on its own, then joins them.
 */
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export function escapeTerminalControls(text: string): string {
  return text.replace(
    TERMINAL_CONTROL,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`
  );
}
