import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ClosedCliError } from "./cli-result.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { isRecord } from "./guards.ts";

function dataHomeRefusal(): ClosedCliError {
  return new ClosedCliError(
    "Env migration cannot resolve its data home. Use an accessible HOME or HACK_HOME directory; values omitted."
  );
}

/** Resolve user-selected HOME aliases once, before adding owned metadata subdirectories. */
export function resolveEnvMigrationDataHome(): string {
  let existing = resolveGlobalHackDir();
  const missing: string[] = [];
  for (;;) {
    try {
      // lstat distinguishes an absent component from a dangling symlink.
      lstatSync(existing);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        const parent = dirname(existing);
        if (parent !== existing) {
          missing.unshift(basename(existing));
          existing = parent;
          continue;
        }
      }
      throw dataHomeRefusal();
    }
    try {
      const canonical = realpathSync(existing);
      if (!statSync(canonical).isDirectory()) {
        throw dataHomeRefusal();
      }
      return join(canonical, ...missing);
    } catch {
      throw dataHomeRefusal();
    }
  }
}
