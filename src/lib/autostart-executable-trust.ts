import { statSync } from "node:fs";
import { checkServicePathDirectories } from "../daemon/systemd.ts";
import {
  type AutostartAclDependencies,
  assertAutostartPathAclsTrusted,
} from "./autostart-path-acl.ts";
import { HackCliError } from "./cli-result.ts";
import { walkReplaceableChain } from "./path-trust.ts";

/**
 * Login helper lookup has the same read-only ownership and mode requirements on
 * both platforms. Check every lookup directory and its executable/symlink
 * entries before any helper runs; inherited shell paths are never repaired.
 */
export async function assertAutostartExecutablePathTrusted(
  opts: { readonly path: string },
  deps?: AutostartAclDependencies
): Promise<void> {
  try {
    const inspectedPaths = new Set<string>();
    if (
      (await checkServicePathDirectories({
        dirs: opts.path.split(":"),
        inspectedPaths,
        // Docker Desktop and OrbStack reach their tools through
        // /Applications (root:admin 0775); accept that, never o+w.
        acceptDarwinAdminDirectories: true,
      })) === null
    ) {
      await assertAutostartPathAclsTrusted(inspectedPaths, deps);
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

/**
 * The login child re-executes Hack directly (`process.execPath`), not through
 * PATH, so the PATH audit above does not cover it. Check that file's owner,
 * mode, symlink chain and ACLs; callers run this before every spawn, so a
 * replacement after the daemon loaded is refused, not executed. A source
 * checkout (`bun index.ts`) loads its whole source tree and dependencies,
 * which this audit cannot bound, so it always requires a manual start.
 * What remains: exec still opens the path by name after this check (no
 * descriptor exec), so the window is narrowed, not closed.
 */
export async function assertAutostartInvocationTrusted(
  opts: { readonly executable: string; readonly compiled: boolean },
  deps?: AutostartAclDependencies
): Promise<void> {
  try {
    const uid = process.getuid?.();
    if (opts.compiled && uid !== undefined) {
      const checked = new Set<string>();
      const trust = walkReplaceableChain({
        path: opts.executable,
        uid,
        hackHome: null,
        checked,
        acceptDarwinAdminDirectories: true,
      });
      if (
        !("error" in trust) &&
        trust.complete &&
        statSync(opts.executable).isFile()
      ) {
        await assertAutostartPathAclsTrusted(checked, deps);
        return;
      }
    }
  } catch {
    // Host filesystem diagnostics can carry private paths; never return them.
  }
  throw new HackCliError({
    code: "E_PERMISSION",
    message:
      "Automatic startup refused an unsafe Hack executable. Run a compiled hack owned by you or root that others cannot replace, then retry. Values omitted.",
    detail: { reason: "executable_path_untrusted" },
  });
}
