/**
 * Where the step store lives and whether this command uses it (HACK-2461).
 *
 * One store per user: `<global Hack directory>/store`. The runtime runs with a
 * closed environment, so the CLI passes the directory explicitly
 * (`--step-store <dir>`). Until each slice's measurement is in, the store is
 * off by default and on only with `HACK_STEP_STORE=on`; with it off nothing
 * is passed and no step reads or writes a record.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { resolveGlobalHackDir } from "../config-paths.ts";

/** Whether this process uses the step store. Off unless `HACK_STEP_STORE=on`. */
export function stepStoreEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env.HACK_STEP_STORE === "on";
}

/**
 * The canonical form of an absolute path whose tail may not exist yet: the
 * deepest existing ancestor is resolved (symlinks followed), the rest appended.
 *
 * The runtime refuses a store with a symlinked ancestor, and macOS puts the
 * temporary directory and `/var` behind symlinks, so the path is resolved once
 * here rather than refused there.
 */
export function canonicalPath(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch (error) {
      const parent = dirname(current);
      if (
        parent === current ||
        (error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT"
      ) {
        return path;
      }
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** The per-user step store directory, canonical. Selecting it never creates it. */
export function stepStoreDirectory(): string {
  return canonicalPath(join(resolveGlobalHackDir(), "store"));
}

/** The runtime arguments that hand the store to a runtime request, if enabled. */
export function stepStoreRuntimeArgs(
  env: Readonly<Record<string, string | undefined>> = process.env
): readonly string[] {
  return stepStoreEnabled(env) ? ["--step-store", stepStoreDirectory()] : [];
}
