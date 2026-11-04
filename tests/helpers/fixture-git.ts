/**
 * The one environment every test-fixture `git` command runs with (HACK-1459).
 *
 * A fixture `git` that inherits the runner's environment is not hermetic:
 * - `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
 *   `GIT_COMMON_DIR` and the other repository variables redirect the command
 *   into whatever repository the caller exported. With `GIT_DIR` set to a real
 *   checkout, a fixture's `init`/`add`/`commit`/`worktree add` writes commits,
 *   branches, worktree registrations and files into that checkout.
 * - The contributor's global and system config (`~/.gitconfig`,
 *   `$XDG_CONFIG_HOME/git/config`, `/etc/gitconfig`) can set `core.hooksPath`
 *   to a guard that refuses fixture commits, turn on commit signing, or change
 *   the default branch; `$XDG_CONFIG_HOME/git/ignore` and `attributes` change
 *   what `status` and `check-ignore` report.
 * - Without an identity of its own, `commit` depends on the runner's
 *   `user.name`/`user.email`, which a private HOME or CI does not have.
 *
 * {@link fixtureGitEnv} therefore builds the child's environment from scratch:
 * only `PATH` and `TMPDIR` come from the runner, then the values the caller
 * passes, then every `GIT_*` variable is removed (including ones the caller's
 * values copied from the runner) and `HOME`/`XDG_CONFIG_HOME` are dropped
 * unless the caller passed them, and finally the fixed hermetic settings below
 * are applied. `DOCKER_HOST` and `DOCKER_CONTEXT` never pass through either.
 *
 * Route every fixture `git` spawn through {@link fixtureGitEnv},
 * {@link runFixtureGitSync} or {@link runFixtureGit};
 * `tests/fixture-hermeticity.test.ts` refuses a test file that spawns `git`
 * without one of them.
 */

/** Author and committer identity of every fixture commit. */
export const FIXTURE_GIT_IDENTITY = Object.freeze({
  name: "Hack Fixture",
  email: "fixture@example.invalid",
});

/** Runner variables a fixture `git` inherits; nothing else is copied. */
export const FIXTURE_GIT_INHERITED_ENV = ["PATH", "TMPDIR"] as const;

/**
 * Settings applied last, over the runner and the caller's values. Global and
 * system config are disabled, the identity is fixed and Git never prompts.
 *
 * Automatic maintenance is off too. Otherwise `commit` starts a detached
 * `git maintenance run --auto` that takes `objects/maintenance.lock` in the
 * fixture repository after the command returned. That process outlives the
 * fixture command, can still be writing when a test compares the repository
 * or removes its temp root, and is a process the test never owns.
 */
export const FIXTURE_GIT_HERMETIC_ENV: Readonly<Record<string, string>> =
  Object.freeze({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "gc.auto",
    GIT_CONFIG_VALUE_1: "0",
    GIT_AUTHOR_NAME: FIXTURE_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: FIXTURE_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: FIXTURE_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: FIXTURE_GIT_IDENTITY.email,
    GIT_TERMINAL_PROMPT: "0",
  });

/**
 * Variables that select which repository, work tree, index or object store a
 * `git` command uses instead of discovering it from its working directory.
 * {@link fixtureGitEnv} removes these with every other `GIT_*` variable; a
 * helper that must keep the contributor's config (the checkout write guard)
 * removes only these.
 */
export const GIT_REPOSITORY_ENV_KEYS = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_PREFIX",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
] as const);

/** Runner variables that never reach a fixture `git`, even when passed in. */
const DROPPED_KEYS = new Set(["DOCKER_HOST", "DOCKER_CONTEXT"]);
/** Dropped when they come from the runner; kept when the caller sets them. */
const RUNNER_HOME_KEYS = ["HOME", "XDG_CONFIG_HOME"] as const;

function isGitVariable(key: string): boolean {
  return key.startsWith("GIT_");
}

/**
 * Builds the complete environment for one fixture `git` command.
 *
 * `env` holds what the command needs beyond `PATH` and `TMPDIR`, such as a
 * private `HOME`. An `undefined` value removes a key. Any `GIT_*` key in `env`
 * is removed too, because callers often pass a copy of the runner's
 * environment; pass `gitEnv` for a Git variable the test sets on purpose (for
 * example `GIT_AUTHOR_DATE`). `gitEnv` cannot override the hermetic settings.
 */
export function fixtureGitEnv(
  opts: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly gitEnv?: Readonly<Record<string, string>>;
  } = {}
): Record<string, string> {
  const passed = opts.env ?? {};
  const env = withPassedEnv(inheritedEnv(), passed);
  for (const key of Object.keys(env)) {
    if (isGitVariable(key) || DROPPED_KEYS.has(key)) {
      Reflect.deleteProperty(env, key);
    }
  }
  for (const key of RUNNER_HOME_KEYS) {
    const value = passed[key];
    // A value equal to the runner's own is a copy of the runner environment,
    // not a fixture home.
    if (value === undefined || value === process.env[key]) {
      Reflect.deleteProperty(env, key);
    }
  }
  for (const [key, value] of Object.entries(opts.gitEnv ?? {})) {
    if (isGitVariable(key) && !Object.hasOwn(FIXTURE_GIT_HERMETIC_ENV, key)) {
      env[key] = value;
    }
  }
  return Object.assign(env, FIXTURE_GIT_HERMETIC_ENV);
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of FIXTURE_GIT_INHERITED_ENV) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

function withPassedEnv(
  env: Record<string, string>,
  passed: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  for (const [key, value] of Object.entries(passed)) {
    if (value === undefined) {
      Reflect.deleteProperty(env, key);
    } else {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Options for `run`/`exec` in src/lib/shell.ts, which lay `env` over the
 * runner's whole `process.env`: `unsetEnvKeys` names every runner key that
 * {@link fixtureGitEnv} did not set, so the child gets exactly that
 * environment. Spread the result into the options right before the call.
 */
export function fixtureGitShellEnv(
  opts: Parameters<typeof fixtureGitEnv>[0] = {}
): {
  readonly env: Record<string, string>;
  readonly unsetEnvKeys: readonly string[];
} {
  const env = fixtureGitEnv(opts);
  return {
    env,
    unsetEnvKeys: Object.keys(process.env).filter(
      (key) => !Object.hasOwn(env, key)
    ),
  };
}

/** Options shared by {@link runFixtureGitSync} and {@link runFixtureGit}. */
export type FixtureGitOptions = {
  /** Working directory of the command; must be a fixture path. */
  readonly cwd: string;
  readonly args: readonly string[];
  /** Extra environment; see {@link fixtureGitEnv}. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly gitEnv?: Readonly<Record<string, string>>;
};

/** Result of one fixture `git` command. */
export type FixtureGitResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function spawnOptions(opts: FixtureGitOptions) {
  return {
    cwd: opts.cwd,
    env: fixtureGitEnv({ env: opts.env, gitEnv: opts.gitEnv }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  } as const;
}

/** Runs one fixture `git` command synchronously. It does not throw on failure. */
export function runFixtureGitSync(opts: FixtureGitOptions): FixtureGitResult {
  const result = Bun.spawnSync(["git", ...opts.args], spawnOptions(opts));
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Runs one fixture `git` command. It does not throw on failure. */
export async function runFixtureGit(
  opts: FixtureGitOptions
): Promise<FixtureGitResult> {
  const child = Bun.spawn(["git", ...opts.args], spawnOptions(opts));
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
