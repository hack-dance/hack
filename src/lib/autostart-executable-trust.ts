import { checkServicePathDirectories } from "../daemon/systemd.ts";
import { HackCliError } from "./cli-result.ts";

/**
 * Login helper lookup has the same read-only ownership and mode requirements on
 * both platforms. Check every lookup directory and its executable/symlink
 * entries before any helper runs; inherited shell paths are never repaired.
 */
export async function assertAutostartExecutablePathTrusted(opts: {
  readonly path: string;
}): Promise<void> {
  try {
    if (
      (await checkServicePathDirectories({ dirs: opts.path.split(":") })) ===
      null
    ) {
      return;
    }
  } catch {
    // Host filesystem diagnostics can carry private paths; never return them.
  }
  throw new HackCliError({
    code: "E_PERMISSION",
    message:
      "Automatic startup refused an unsafe executable search path. Review directory and program ownership and permissions, then retry. Values omitted.",
    detail: { reason: "executable_path_untrusted" },
  });
}
