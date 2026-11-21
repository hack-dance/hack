/**
 * Where the step store lives and whether this command uses it (HACK-2461).
 *
 * One base per user at `<global Hack directory>/store`. The runtime runs with a
 * closed environment, so the CLI passes the base explicitly
 * (`--step-store <dir>`). Until each slice's measurement is in, the store is
 * off by default and on only with `HACK_STEP_STORE=on`; with it off nothing
 * is passed and no step reads or writes a record.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { nativeExecutableDigests } from "../../backends/native-executable-hash.ts";
import { resolveGlobalHackDir } from "../config-paths.ts";
import { isCompiledHack } from "../hack-cli.ts";
import { HACK_VERSION } from "../hack-version.ts";

/**
 * The compiled CLI build for step keys. Source runs and failed executable hashes
 * return null, which tells the caller to skip the cache.
 */
export async function stepStoreBuild(): Promise<string | null> {
  if (!isCompiledHack()) {
    return null;
  }
  try {
    const hash = await nativeExecutableDigests.sha256(process.execPath, {
      refused: () => new Error("Cannot identify the step store CLI build."),
    });
    return `${HACK_VERSION}+cli:${hash}`;
  } catch {
    return null;
  }
}

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

/**
 * The canonical per-user base. The runtime owns its format subdirectory
 * (currently `hack.store-1/`). Selecting the base never creates it.
 */
export function stepStoreDirectory(): string {
  return canonicalPath(join(resolveGlobalHackDir(), "store"));
}

/** The runtime arguments that hand the store to a runtime request, if enabled. */
export function stepStoreRuntimeArgs(
  env: Readonly<Record<string, string | undefined>> = process.env
): readonly string[] {
  return stepStoreEnabled(env) ? ["--step-store", stepStoreDirectory()] : [];
}
