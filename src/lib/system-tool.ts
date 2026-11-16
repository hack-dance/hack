import { existsSync } from "node:fs";
import { checkReplaceableChain } from "./path-trust.ts";

/**
 * System tools the daemon's process proofs run (HACK-2216). They are never
 * looked up on PATH: an automatic replacement (the orphan sweep, the
 * ownership proof) runs them as this user, and a `ps` or `lsof` planted in
 * an earlier PATH directory would run instead.
 */
export type SystemTool = "ps" | "lsof";

/** The fixed places each tool may live, in order, per platform. */
const CANDIDATES: Readonly<
  Record<"darwin" | "linux", Readonly<Record<SystemTool, readonly string[]>>>
> = {
  darwin: { ps: ["/bin/ps"], lsof: ["/usr/sbin/lsof"] },
  linux: {
    ps: ["/bin/ps", "/usr/bin/ps"],
    lsof: ["/usr/bin/lsof", "/usr/sbin/lsof"],
  },
};

const overrides = new Map<SystemTool, string>();

/**
 * Test-only: points `tool` at a stand-in, for tests that run the process
 * proofs against a fake tool. Called only from tests; production code
 * never calls it, and no environment variable selects a tool.
 */
export function useSystemToolForTests(
  tool: SystemTool,
  path: string | null
): void {
  if (path === null) {
    overrides.delete(tool);
  } else {
    overrides.set(tool, path);
  }
}

/**
 * The absolute path to run `tool` from, or null when none qualifies. Only
 * the fixed candidates for this platform are considered, never PATH. A
 * candidate must exist and be safe from other accounts along its whole
 * path, symlink hops included (`checkReplaceableChain`, the chain check
 * `checkServiceExecutableTrusted` runs: owned by root or this user, no
 * directory on the way that another account can replace). Callers treat
 * null as an observation they could not make, and fail closed.
 */
export function resolveSystemTool(
  tool: SystemTool,
  opts: {
    /** Defaults to `process.platform`. */
    readonly platform?: NodeJS.Platform;
    /** Defaults to `existsSync`. */
    readonly exists?: (path: string) => boolean;
    /** Defaults to {@link checkReplaceableChain} for this process's uid. */
    readonly isTrusted?: (path: string) => boolean;
  } = {}
): string | null {
  const override = overrides.get(tool);
  if (override !== undefined) {
    return override;
  }
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    return null;
  }
  const exists = opts.exists ?? existsSync;
  const isTrusted =
    opts.isTrusted ??
    ((path: string) =>
      checkReplaceableChain({
        path,
        uid: process.getuid?.() ?? -1,
        hackHome: null,
      }) === null);
  for (const candidate of CANDIDATES[platform][tool]) {
    if (exists(candidate) && isTrusted(candidate)) {
      return candidate;
    }
  }
  return null;
}
