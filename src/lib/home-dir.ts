import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * Normalize a home-directory candidate: trimmed and absolute, otherwise null.
 *
 * Empty and relative values are rejected because `resolve("")` and
 * `resolve("relative")` land under the current working directory, which would
 * put global state (registry, daemon socket, secret key material) in `<cwd>`.
 */
export function normalizeHomeDir(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    return null;
  }
  return resolve(trimmed);
}

/** `HOME` when it is set to an absolute path; null when empty, unset or relative. */
export function readHomeEnv(): string | null {
  return normalizeHomeDir(process.env.HOME);
}

/**
 * Resolve the user's home directory without ever falling back to the cwd.
 *
 * Resolution order:
 * 1. `HOME` when set to an absolute path.
 * 2. `os.homedir()` when it returns an absolute path (it also consults `HOME`
 *    on POSIX, so it is only a fallback for an empty or unset `HOME`).
 * 3. Otherwise throw: there is no safe home to build global paths from.
 */
export function resolveUserHomeDir({
  osHomedir = homedir,
}: {
  readonly osHomedir?: () => string;
} = {}): string {
  const fromEnv = readHomeEnv();
  if (fromEnv) {
    return fromEnv;
  }
  let fromOs: string | null = null;
  try {
    fromOs = normalizeHomeDir(osHomedir());
  } catch {
    fromOs = null;
  }
  if (fromOs) {
    return fromOs;
  }
  throw new Error(
    "Cannot resolve the home directory: HOME is empty or not an absolute path. " +
      "Set HOME (or HACK_HOME) to an absolute path."
  );
}

/**
 * Read the `HACK_HOME` override.
 *
 * Returns null when unset or whitespace-only. A relative value is refused with
 * an error instead of being resolved against the cwd or silently ignored:
 * HACK_HOME exists to isolate global state, so falling back to the real home
 * would be as wrong as writing under the cwd.
 */
export function readHackHomeOverride(): string | null {
  const raw = (process.env.HACK_HOME ?? "").trim();
  if (raw.length === 0) {
    return null;
  }
  const normalized = normalizeHomeDir(raw);
  if (!normalized) {
    throw new Error(
      `HACK_HOME must be an absolute path (got a relative path: ${JSON.stringify(raw)}).`
    );
  }
  return normalized;
}
