import { ClosedCliError } from "../../src/lib/cli-result.ts";

/**
 * Checkout write guard (HACK-1343).
 *
 * Tests must write only inside temp directories. A test that writes into the
 * repository checkout instead leaves a change that nothing else reports: a CLI
 * call that outlives its timed-out test and resolves an emptied fixture root
 * against the current directory creates an untracked file, and a child
 * spawned with a `null` cwd rewrites tracked files. The guard records the
 * checkout's `git status` entries when the test run starts and, after the last
 * test, fails the run naming every entry that appeared: a new untracked file,
 * or a tracked file that became modified, deleted or renamed.
 *
 * Writes under an ignored path, further edits of a file that was already
 * changed when the run started, and writes after the run ends are outside it.
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
 * The `git status` entries of `checkout`: every untracked, non-ignored file
 * and every changed tracked file, each as its two-letter status and its
 * checkout-relative path (`?? new.txt`, ` M package.json`). A failed
 * `git status` is refused, closed: the guard never treats an unreadable
 * checkout as clean.
 */
export function checkoutStatusEntries(
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
  const fields = status.stdout.split("\0");
  const entries: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] ?? "";
    if (entry.length === 0) {
      continue;
    }
    entries.push(entry);
    if (entry.startsWith("R") || entry.startsWith("C")) {
      // A rename or copy is followed by its source path as its own field.
      index += 1;
    }
  }
  return entries;
}

/** Entries in `current` that were not in the baseline, sorted by path. */
export function newStatusEntries(
  baseline: ReadonlySet<string>,
  current: readonly string[]
): string[] {
  return current
    .filter((entry) => !baseline.has(entry))
    .sort((left, right) => left.slice(3).localeCompare(right.slice(3)));
}

/** Fails, closed, when `appeared` names any status entry. */
export function assertNoCheckoutWrites(opts: {
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
      `checkout write guard: ${opts.appeared.length} file(s) were created or changed in ${opts.checkout} during the test run.`,
      "A test wrote outside its temp directory (HACK-1343). Restore or remove these files and fix the test:",
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
  const baseline = new Set(checkoutStatusEntries(runner, checkout));
  opts.afterAll(() => {
    assertNoCheckoutWrites({
      checkout,
      appeared: newStatusEntries(
        baseline,
        checkoutStatusEntries(runner, checkout)
      ),
    });
  });
}
