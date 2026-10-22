import { ClosedCliError } from "../../src/lib/cli-result.ts";

/**
 * Checkout write guard (HACK-1343).
 *
 * Tests must write only inside temp directories. A test that writes into the
 * repository checkout instead (for example a CLI call that outlives its timed
 * out test and resolves an emptied fixture root against the current
 * directory) leaves an untracked file that nothing else reports. The guard
 * records the checkout's untracked files when the test run starts and, after
 * the last test, fails the run naming every untracked file that appeared.
 *
 * It sees untracked files that git does not ignore. Writes under an ignored
 * path, edits of tracked files and writes after the run ends are outside it.
 */

/** At most this many paths are named in a failure. */
const MAX_NAMED = 50;

type GitRunner = {
  readonly git: string;
  readonly env: Readonly<Record<string, string>>;
};

function runGit(
  runner: GitRunner,
  cwd: string,
  args: readonly string[]
): { readonly exitCode: number; readonly stdout: string } {
  const result = Bun.spawnSync([runner.git, ...args], {
    cwd,
    env: runner.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

/**
 * Untracked, non-ignored files under `checkout`, as checkout-relative paths.
 * A failed `git status` is refused, closed: the guard never treats an
 * unreadable checkout as clean.
 */
export function untrackedCheckoutFiles(
  runner: GitRunner,
  checkout: string
): string[] {
  const status = runGit(runner, checkout, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.exitCode !== 0) {
    throw new ClosedCliError(
      "checkout write guard: git status failed; the checkout could not be checked for files written by tests."
    );
  }
  const entries = status.stdout.split("\0");
  const untracked: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.startsWith("?? ")) {
      untracked.push(entry.slice(3));
    } else if (entry.startsWith("R") || entry.startsWith("C")) {
      // A rename or copy is followed by its source path as its own entry.
      index += 1;
    }
  }
  return untracked;
}

/** Paths in `current` that were not untracked at the baseline, sorted. */
export function newUntrackedFiles(
  baseline: ReadonlySet<string>,
  current: readonly string[]
): string[] {
  return current.filter((path) => !baseline.has(path)).sort();
}

/** Fails, closed, when `appeared` names any file. */
export function assertNoNewUntrackedFiles(opts: {
  readonly checkout: string;
  readonly appeared: readonly string[];
}): void {
  if (opts.appeared.length === 0) {
    return;
  }
  const named = opts.appeared.slice(0, MAX_NAMED).map((path) => `  ${path}`);
  if (opts.appeared.length > MAX_NAMED) {
    named.push(`  ... and ${opts.appeared.length - MAX_NAMED} more`);
  }
  throw new ClosedCliError(
    [
      `checkout write guard: ${opts.appeared.length} untracked file(s) appeared in ${opts.checkout} during the test run.`,
      "A test wrote outside its temp directory (HACK-1343). Remove the files and fix the test:",
      ...named,
    ].join("\n")
  );
}

/**
 * Records the baseline for the git checkout that contains `start` and
 * registers the end-of-run check through `afterAll`.
 *
 * When `start` is not in a git work tree (an export, or a container mount of a
 * linked worktree) there is nothing to compare, so the guard stays inactive
 * and says so on stderr. Under CI that is refused, closed: CI always runs in a
 * checkout, and a silently inactive guard would hide this class of leak.
 */
export function installCheckoutWriteGuard(opts: {
  readonly start: string;
  readonly afterAll: (hook: () => void) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): void {
  const source = opts.env ?? process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  // Read-only status: never take the index lock a contributor's git may need.
  env.GIT_OPTIONAL_LOCKS = "0";
  const ci = env.CI === "true" || env.CI === "1";
  const git = Bun.which("git", { PATH: env.PATH ?? "" });
  const runner: GitRunner | null = git ? { git, env } : null;
  const toplevel = runner
    ? runGit(runner, opts.start, ["rev-parse", "--show-toplevel"])
    : null;
  if (!(runner && toplevel) || toplevel.exitCode !== 0) {
    if (ci) {
      throw new ClosedCliError(
        "checkout write guard: the test run is not in a readable git checkout, so files written by tests cannot be detected."
      );
    }
    process.stderr.write(
      "checkout write guard: inactive, the test run is not in a readable git checkout.\n"
    );
    return;
  }
  const checkout = toplevel.stdout.trim();
  const baseline = new Set(untrackedCheckoutFiles(runner, checkout));
  opts.afterAll(() => {
    assertNoNewUntrackedFiles({
      checkout,
      appeared: newUntrackedFiles(
        baseline,
        untrackedCheckoutFiles(runner, checkout)
      ),
    });
  });
}
