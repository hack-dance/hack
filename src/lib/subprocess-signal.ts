import { constants as osConstants } from "node:os";

/**
 * The signal that ended a Bun subprocess. Bun reports a named signal by
 * name and a signal without a name (for example a Linux real-time signal)
 * by its number, so callers must handle both.
 */
export type SubprocessSignal = NodeJS.Signals | number;

/** The signal's number, or `fallback` for a name this platform does not define. */
export function subprocessSignalNumber(
  signal: SubprocessSignal,
  fallback: number
): number {
  return typeof signal === "number"
    ? signal
    : (osConstants.signals[signal] ?? fallback);
}

/** Shell-style exit status for a process ended by `signal`: 128 plus its number. */
export function subprocessSignalExitStatus(
  signal: SubprocessSignal,
  fallback: number
): number {
  return 128 + subprocessSignalNumber(signal, fallback);
}

/** The signal as text for records and messages: its name, or its number in decimal. */
export function subprocessSignalLabel(
  signal: SubprocessSignal | null | undefined
): string | null {
  if (signal === null || signal === undefined) {
    return null;
  }
  return typeof signal === "number" ? String(signal) : signal;
}
