import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read-time report of machine-local env files that other users can read
 * (HACK-2165). Files created by Hack are private (0600) from creation, and a
 * write tightens an existing one; a file that predates that rule, or was
 * made by hand, stays loose until then. Commands that read env layers report
 * it so the user can act before the next write.
 *
 * Only names and permission bits are inspected; no file is opened. Each
 * path is reported once per process, on stderr, so `--json` output on
 * stdout stays valid.
 */

/** A machine-local env layer: `hack.env.local.yaml`, `hack.env.<overlay>.local.yaml`. */
export const MACHINE_LOCAL_LAYER_NAME = /^hack\.env(\.[^/]+)?\.local\.yaml$/;

/**
 * A plaintext `.hack/.env` or `.hack/.env.<overlay>` file. Committed
 * templates (`.env.example`, `.sample`, `.template`, `.dist`) hold no values
 * and are excluded; backups (`.bak`, `.old`, ...) may and are not.
 */
export const PLAINTEXT_DOTENV_NAME =
  /^\.env(\.(?!(?:example|sample|template|dist)$)[A-Za-z0-9_-]+)?$/;

const LOCAL_LAYER = MACHINE_LOCAL_LAYER_NAME;
const PLAINTEXT_DOTENV = PLAINTEXT_DOTENV_NAME;

const reported = new Set<string>();

// Control and formatting characters a terminal could act on: C0, DEL, C1,
// line/paragraph separators and bidirectional overrides.
const UNPRINTABLE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * A file name or path for terminal output: every control or formatting
 * character is shown as `\u{…}`, so a name a repository chose can neither
 * inject terminal sequences nor fake extra lines (HACK-2165).
 */
export function displayPath(path: string): string {
  return path.replace(
    UNPRINTABLE,
    (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`
  );
}

/**
 * The warning for one loose file; names the file and its mode, never a
 * value. It offers no copyable shell command: the name may come from a
 * repository, so the remedy is `hack doctor --fix`.
 */
export function looseEnvLayerWarning(opts: {
  readonly name: string;
  readonly mode: number;
}): string {
  const mode = (opts.mode & 0o777).toString(8).padStart(4, "0");
  return `WARN: .hack/${displayPath(opts.name)} holds machine-local env values and is readable by other users (mode ${mode}). Hack makes it 0600 on its next write; to fix it now, run 'hack doctor --fix'.\n`;
}

/**
 * Warns once per process about each machine-local env layer or plaintext
 * `.hack/.env*` file in `projectDir` that is a regular file of this user's
 * with group or other permission bits. Best effort: an unreadable directory
 * reports nothing.
 */
export async function reportLooseEnvLayerModes(opts: {
  readonly projectDir: string;
  readonly write?: (text: string) => void;
}): Promise<void> {
  const write =
    opts.write ?? ((text: string) => void process.stderr.write(text));
  const names = await readdir(opts.projectDir).catch(() => [] as string[]);
  for (const name of names.sort()) {
    if (!(LOCAL_LAYER.test(name) || PLAINTEXT_DOTENV.test(name))) {
      continue;
    }
    const path = join(opts.projectDir, name);
    if (reported.has(path)) {
      continue;
    }
    const info = await lstat(path).catch(() => null);
    if (
      info?.isFile() &&
      info.uid === process.getuid?.() &&
      (info.mode & 0o077) !== 0
    ) {
      reported.add(path);
      write(looseEnvLayerWarning({ name, mode: info.mode }));
    }
  }
}
