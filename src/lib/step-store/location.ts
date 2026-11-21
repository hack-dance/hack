/**
 * Where the step store lives and whether this command uses it (HACK-2461).
 *
 * One store per user: `<global Hack directory>/store`. The runtime runs with a
 * closed environment, so the CLI passes the directory explicitly
 * (`--step-store <dir>`). Until each slice's measurement is in, the store is
 * off by default and on only with `HACK_STEP_STORE=on`; with it off nothing
 * is passed and no step reads or writes a record.
 */
import { join } from "node:path";

import { resolveGlobalHackDir } from "../config-paths.ts";

/** Whether this process uses the step store. Off unless `HACK_STEP_STORE=on`. */
export function stepStoreEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env.HACK_STEP_STORE === "on";
}

/** The per-user step store directory. Selecting it never creates it. */
export function stepStoreDirectory(): string {
  return join(resolveGlobalHackDir(), "store");
}

/** The runtime arguments that hand the store to a runtime request, if enabled. */
export function stepStoreRuntimeArgs(
  env: Readonly<Record<string, string | undefined>> = process.env
): readonly string[] {
  return stepStoreEnabled(env) ? ["--step-store", stepStoreDirectory()] : [];
}
