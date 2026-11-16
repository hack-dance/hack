import { accessSync, constants, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The executable of the CLI running now, for deciding whether a service
 * runs "this CLI" (HACK-2216). Distinct from the `hack` this CLI would
 * install (the first on PATH, `resolveExpectedSystemdUnit` and
 * `resolveLaunchdHackBinPath`): `hack update` runs the new binary by
 * absolute path while an older `hack` may come first on PATH, and a
 * service running that older one is not this CLI.
 *
 * A compiled Hack binary (its entry is inside the binary's virtual
 * filesystem) is `process.execPath`. A source invocation (`bun index.ts`)
 * has no executable a unit or plist could name, so it is null: unknown,
 * which never makes a service eligible for an automatic restart or
 * refresh.
 */
export function resolveExecutingCliPath(
  opts: { readonly main?: string; readonly execPath?: string } = {}
): string | null {
  const main = opts.main ?? Bun.main;
  // A compiled Bun binary's entry lives in its virtual filesystem.
  const compiled = main.startsWith("/$bunfs/") || main.includes("~BUN");
  return compiled ? (opts.execPath ?? process.execPath) : null;
}

/**
 * How to run THIS CLI again (HACK-2216): the executing compiled binary, or,
 * for a source invocation, the same runtime with the same entry point
 * (`bun index.ts`). Never the `hack` first on PATH: during `hack update`
 * the new binary runs by absolute path while an older `hack` may come
 * first on PATH, and a replacement daemon started from that one would run
 * the old version.
 */
export function resolveExecutingInvocation(
  opts: { readonly main?: string; readonly execPath?: string } = {}
): { readonly bin: string; readonly args: readonly string[] } {
  const executing = resolveExecutingCliPath(opts);
  if (executing !== null) {
    return { bin: executing, args: [] };
  }
  return {
    bin: opts.execPath ?? process.execPath,
    args: [opts.main ?? Bun.main],
  };
}

/** The argv that starts this CLI's hackd in the foreground. */
export function executingDaemonArgv(
  opts: { readonly main?: string; readonly execPath?: string } = {}
): readonly string[] {
  const invocation = resolveExecutingInvocation(opts);
  return [
    invocation.bin,
    ...invocation.args,
    "daemon",
    "start",
    "--foreground",
  ];
}

/**
 * How `hack daemon start` launches a detached hackd (HACK-2263).
 *
 * - `path`: an ordinary (stable) run starts the `hack` this CLI resolves
 *   (`HACK_MCP_COMMAND`, then the first `hack` on PATH), as it always has.
 * - `candidate`: a candidate run (`HACK_CANDIDATE_ENTRYPOINT` set by
 *   `hack-next` or `hack-v5`) starts its own bundle through that bundle's
 *   `hack-v5` launcher, never a `hack` from PATH: on a machine with the
 *   stable line first on PATH that would start the stable hackd, which the
 *   candidate then calls incompatible. The launcher sits next to the
 *   running `hack-cli` (the manager runs `<root>/versions/<v>/bundle/`
 *   for `hack-next`), so this is the bundle running now, not whatever
 *   version the channel selects later. The child inherits this process's
 *   environment, which already holds what the manager and the launcher set
 *   (marker, Hack home, backend, native selectors).
 * - `refused`: a candidate run that cannot prove which hackd it would start
 *   (a source run, or no executable `hack-v5` next to the running
 *   `hack-cli`) starts nothing.
 */
export type DaemonLaunch =
  | { readonly kind: "path" }
  | { readonly kind: "candidate"; readonly argv: readonly string[] }
  | { readonly kind: "refused"; readonly message: string };

/** The marker the candidate launchers set; see `scripts/hack-v5.sh`. */
const CANDIDATE_ENTRYPOINT_ENV = "HACK_CANDIDATE_ENTRYPOINT";

export function resolveDaemonLaunch(
  opts: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly main?: string;
    readonly execPath?: string;
    /** Whether `path` is an executable file; tests inject it. */
    readonly isExecutable?: (path: string) => boolean;
  } = {}
): DaemonLaunch {
  const env = opts.env ?? process.env;
  if ((env[CANDIDATE_ENTRYPOINT_ENV] ?? "").trim() === "") {
    return { kind: "path" };
  }
  const executing = resolveExecutingCliPath({
    main: opts.main,
    execPath: opts.execPath,
  });
  if (executing === null) {
    return {
      kind: "refused",
      message:
        "Not starting hackd: this candidate run is not a compiled bundle, so it cannot prove which hackd it would start.",
    };
  }
  const launcher = join(dirname(executing), "hack-v5");
  if (!(opts.isExecutable ?? isExecutableFile)(launcher)) {
    return {
      kind: "refused",
      message: `Not starting hackd: this candidate run has no executable hack-v5 launcher next to ${executing}, so it cannot prove which hackd it would start.`,
    };
  }
  return {
    kind: "candidate",
    argv: [launcher, "daemon", "start", "--foreground"],
  };
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
