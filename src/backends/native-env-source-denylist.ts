import { basename, isAbsolute, relative, resolve } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../constants.ts";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";

/**
 * Hack's own key and secret-store files can never be a native environment
 * source: neither a service `env_file` nor the automatic `.env`.
 *
 * Ownership: the native environment reader calls this after literal path
 * admission and before it inspects, caches or reads a source, so start,
 * preflight, restart preflight and fresh exec refuse alike. The decision is
 * lexical: it performs no filesystem access, so it never opens or stats a
 * denied file or the Hack home. Callers report the authored source path and a
 * closed reason, never a resolved private path or a value.
 *
 * Denied, after Unicode NFC normalization and ASCII case folding (so a case
 * alias on a case-insensitive filesystem is denied too):
 * - any file named like the project env key, `.hack.secret.key`, at any depth.
 *   This covers the checkout key, the shared key under the git common
 *   directory and the primary checkout's key;
 * - the legacy project-relative encrypted-file store and key names,
 *   `.hack-secrets.enc.json` and `.hack-secrets-file.key`;
 * - every path under the Hack home (`HACK_HOME`, else `~/.hack`) when the Hack
 *   home lies inside the project root, including the Hack home itself being
 *   the project's `.hack` directory; a Hack home equal to the project root
 *   denies every source. A project that lies strictly inside the Hack home
 *   keeps the name rules; denying the whole Hack home would refuse every
 *   source of that project.
 *
 * Limits: the Hack home is compared by path against both the canonical and
 * the caller's project root, not by file identity; a Hack home reachable only
 * through a symlink is not recognized. Encrypted stores configured at other
 * paths are not covered. Native source admission separately refuses symlinked
 * sources and multi-link files.
 *
 * Failure: when the Hack home cannot be determined (no usable `HOME` or
 * `HACK_HOME`), building the denylist throws and every source is refused.
 */

/** Closed refusal reason; names no path and no value. */
export const NATIVE_ENV_SECRET_SOURCE_REASON =
  "Hack key and secret-store files cannot be environment sources";
/** Closed refusal reason when the denylist itself cannot be built. */
export const NATIVE_ENV_SECRET_SOURCE_UNKNOWN_REASON =
  "the Hack home could not be determined, so key files cannot be excluded";

/** Legacy project-relative encrypted-file store and key names. */
const LEGACY_STORE_NAMES = [
  ".hack-secrets-file.key",
  ".hack-secrets.enc.json",
] as const;

const DENIED_NAMES: ReadonlySet<string> = new Set(
  [PROJECT_ENV_KEY_FILENAME, ...LEGACY_STORE_NAMES].map(fold)
);

/** Unicode NFC plus ASCII-only case folding. */
function fold(path: string): string {
  return path
    .normalize("NFC")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function inside(parent: string, child: string): boolean {
  const member = relative(parent, child);
  return !(member === ".." || member.startsWith("../") || isAbsolute(member));
}

export type NativeEnvSecretDenylist = {
  /** True when `path` (absolute) must be refused as an environment source. */
  readonly denies: (path: string) => boolean;
};

/**
 * Build the denylist for one preparation. `projectRoots` are the canonical
 * root and, when different, the root the caller supplied.
 */
export function nativeEnvSecretDenylist(opts: {
  readonly projectRoots: readonly string[];
  /** Defaults to the Hack home of this process. */
  readonly hackHome?: string;
}): NativeEnvSecretDenylist {
  const home = fold(resolve(opts.hackHome ?? resolveGlobalHackDir()));
  const roots = opts.projectRoots.map((root) => fold(resolve(root)));
  // Only a Hack home inside (or equal to) the project root can hold an
  // admissible source; one equal to the root denies every source.
  const guardsHome = roots.some((root) => inside(root, home));
  return {
    denies: (path) => {
      const folded = fold(resolve(path));
      if (DENIED_NAMES.has(basename(folded))) {
        return true;
      }
      return guardsHome && inside(home, folded);
    },
  };
}
