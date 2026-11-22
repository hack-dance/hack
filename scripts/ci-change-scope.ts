#!/usr/bin/env bun
/**
 * Pull-request change scope for the CI workflow (HACK-1960).
 *
 *   bun scripts/ci-change-scope.ts --event=pull_request
 *
 * A pull request run checks out GitHub's merge commit, whose first parent is
 * the base branch tip, so `HEAD^1..HEAD` is exactly what the pull request
 * changes. Each changed path gets a kind, and the kinds decide the scope:
 *
 * | scope          | when                                              |
 * | -------------- | ------------------------------------------------- |
 * | `full`         | not a pull request, or the diff is unavailable    |
 * | `docs`         | every path is documentation or docs site tooling  |
 * | `runtime-core` | every path is documentation or runtime core Rust  |
 * | `typescript`   | no path is Rust, toolchain or workflow            |
 * | `code`         | anything else                                     |
 *
 * Separately from the scope, `docs_site` is true when any path feeds the
 * documentation site (`docs/`, `site/`, `scripts/docs/` or this workflow).
 *
 * The outputs written to `$GITHUB_OUTPUT` are the job switches in
 * `.github/workflows/ci.yml`. Only `full` runs every job and every config
 * compiler host on main and explicit full dispatches. Next pushes use a proven
 * successful before revision; the workflow widens uncertainty to full.
 * `ci-pr-plan.ts` layers the
 * conservative unit subset and draft policy over these coarse switches.
 * Ready PRs retain platform pools; drafts run their subset on Linux and fail
 * the required fan-in. A failed or empty diff selects every unit test.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

export type PathKind = "docs" | "runtime-core" | "rust" | "typescript";

export type ChangeScope =
  | "full"
  | "code"
  | "typescript"
  | "runtime-core"
  | "docs";

/**
 * Documentation that no build reads; tests that read it run in `docs` scope.
 * `scripts/docs/` is the docs site tooling: only the `docs site` job and the
 * `docs:*` package scripts run it, so a change there needs no bun shards,
 * Docker e2e or compiler build.
 */
const DOCS_PATHS = [/^docs\//, /^site\//, /^scripts\/docs\//] as const;
const DOCS_FILES = new Set([
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "PACKAGING.md",
  "LICENSE",
]);

/**
 * The runtime core, the guest it embeds and the checkout launcher its tests
 * copy (packages/runtime-core/tests/local_contract.rs) and CI smoke-tests.
 * Nothing else outside packages/runtime-core is read by its job.
 */
const RUNTIME_CORE_PATHS = [
  /^packages\/runtime-core\//,
  /^packages\/relay-guest\//,
  /^scripts\/build-hack-local\.sh$/,
  /^hack-local$/,
] as const;

/** Other Rust, toolchain pins and CI definitions: they can change any job. */
const RUST_PATHS = [
  /^packages\/config-compiler\//,
  /(^|\/)Cargo\.(toml|lock)$/,
  /(^|\/)rust-toolchain(\.toml)?$/,
  /^mise\.toml$/,
  /^\.github\//,
  /^scripts\/build-config-compiler\.ts$/,
] as const;

export function pathKind(path: string): PathKind {
  if (
    DOCS_FILES.has(path) ||
    DOCS_PATHS.some((pattern) => pattern.test(path))
  ) {
    return "docs";
  }
  if (RUNTIME_CORE_PATHS.some((pattern) => pattern.test(path))) {
    return "runtime-core";
  }
  if (RUST_PATHS.some((pattern) => pattern.test(path))) {
    return "rust";
  }
  return "typescript";
}

/**
 * Inputs of the documentation site job: the docs corpus and its pins, the site,
 * the scripts that stage and check them, the README picture references, and
 * the workflow that defines the job.
 */
const DOCS_SITE_PATHS = [
  /^README\.md$/,
  /^docs\//,
  /^site\//,
  /^scripts\/docs\//,
  /^\.github\/workflows\/ci\.yml$/,
] as const;

/** Whether a changed path can change the docs checks or the site build. */
export function touchesDocsSite(path: string): boolean {
  return DOCS_SITE_PATHS.some((pattern) => pattern.test(path));
}

/**
 * Relocated bundles exercise CLI refusals as well as compiler transports. Any
 * CLI source may change HOME writes, output or dispatch before the refusal.
 * Keep this independent of the unit-test import graph and compiler Rust inputs.
 */
export function touchesRelocatedCli(path: string): boolean {
  return /^(?:src\/|index\.ts$|packages\/cli\/|scripts\/check-(?:.+-cli|native-plan-clis)\.ts$)/.test(
    path
  );
}

/** The scope of a pull request that changes `paths`; empty means `full`. */
export function changeScope(paths: readonly string[]): ChangeScope {
  if (paths.length === 0) {
    return "full";
  }
  const kinds = new Set(paths.map(pathKind));
  if (kinds.size === 1 && kinds.has("docs")) {
    return "docs";
  }
  if (!(kinds.has("rust") || kinds.has("typescript"))) {
    return "runtime-core";
  }
  if (!(kinds.has("rust") || kinds.has("runtime-core"))) {
    return "typescript";
  }
  return "code";
}

/** One config compiler matrix entry; `os` is also the job name suffix. */
export type CompilerHost = {
  readonly os: string;
  readonly platform: "linux" | "darwin";
  readonly arch: "x64" | "arm64";
};

/** Every compiler release host; main and explicit release runs cover them all. */
export const COMPILER_HOSTS: readonly CompilerHost[] = [
  { os: "ubuntu-latest", platform: "linux", arch: "x64" },
  { os: "macos-latest", platform: "darwin", arch: "arm64" },
  { os: "ubuntu-24.04-arm", platform: "linux", arch: "arm64" },
  { os: "macos-15-intel", platform: "darwin", arch: "x64" },
];

export type ScopeOutputs = {
  readonly scope: ChangeScope;
  /** JSON `include` list for the config compiler matrix; `[]` skips it. */
  readonly compiler_hosts: string;
  /** Whether the config compiler job runs its Rust format, lint and tests. */
  readonly compiler_rust: boolean;
  readonly runtime_core: boolean;
  /** Bun shards, docker-e2e, runtime images and the Linux lifetime job. */
  readonly suite: boolean;
  /**
   * `pooled` (macOS and Linux pools) on every scope since HACK-2028; `full`
   * (all shards on macOS) remains a valid layout for manual runs.
   */
  readonly test_layout: "full" | "pooled";
  /**
   * The focused test run that replaces the suite: a comma-separated list of
   * `docs` and `runtime-core`, or empty when the suite runs.
   */
  readonly test_focus: string;
  /** Docs corpus checks, the site build and its HTTP smoke. */
  readonly docs_site: boolean;
};

/** The job switches for a pull request that changes `paths`. */
export function planScope(paths: readonly string[]): ScopeOutputs {
  const outputs = {
    ...scopeOutputs(changeScope(paths)),
    docs_site: paths.length === 0 || paths.some(touchesDocsSite),
  };
  if (
    outputs.scope === "runtime-core" &&
    paths.some((path) => pathKind(path) === "docs")
  ) {
    return { ...outputs, test_focus: "docs,runtime-core" };
  }
  return outputs;
}

export function scopeOutputs(scope: ChangeScope): ScopeOutputs {
  const linuxOnly = COMPILER_HOSTS.filter(
    (host) => host.os === "ubuntu-latest"
  );
  switch (scope) {
    case "full":
      return {
        scope,
        compiler_hosts: JSON.stringify(COMPILER_HOSTS),
        compiler_rust: true,
        runtime_core: true,
        suite: true,
        test_layout: "pooled",
        test_focus: "",
        docs_site: true,
      };
    case "code":
      return {
        scope,
        compiler_hosts: JSON.stringify(linuxOnly),
        compiler_rust: true,
        runtime_core: true,
        suite: true,
        test_layout: "pooled",
        test_focus: "",
        docs_site: false,
      };
    case "typescript":
      return {
        scope,
        compiler_hosts: JSON.stringify(linuxOnly),
        compiler_rust: false,
        runtime_core: false,
        suite: true,
        test_layout: "pooled",
        test_focus: "",
        docs_site: false,
      };
    case "runtime-core":
      return {
        scope,
        compiler_hosts: "[]",
        compiler_rust: false,
        runtime_core: true,
        suite: false,
        test_layout: "pooled",
        test_focus: "runtime-core",
        docs_site: false,
      };
    case "docs":
      return {
        scope,
        compiler_hosts: "[]",
        compiler_rust: false,
        runtime_core: false,
        suite: false,
        test_layout: "pooled",
        test_focus: "docs",
        docs_site: false,
      };
    default:
      throw new Error(`Unknown change scope: ${String(scope satisfies never)}`);
  }
}

/** Paths the merge commit `HEAD` changes against its first parent, or null. */
export function pullRequestPaths(repoRoot: string): string[] | null {
  const parents = Bun.spawnSync(
    ["git", "rev-list", "--parents", "-n", "1", "HEAD"],
    {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  // A merge commit lists itself and two parents.
  if (
    parents.exitCode !== 0 ||
    parents.stdout.toString().trim().split(/\s+/).length !== 3
  ) {
    return null;
  }
  const baseRevision = parents.stdout.toString().trim().split(/\s+/)[1];
  return baseRevision ? revisionPaths({ repoRoot, baseRevision }) : null;
}

/** A push's supplied before SHA is data, and must be a known ancestor. */
export function revisionPaths(opts: {
  readonly repoRoot: string;
  readonly baseRevision: string;
}): string[] | null {
  if (
    !/^[0-9a-f]{40}$/.test(opts.baseRevision) ||
    /^0+$/.test(opts.baseRevision)
  ) {
    return null;
  }
  const ancestry = Bun.spawnSync(
    ["git", "merge-base", "--is-ancestor", opts.baseRevision, "HEAD"],
    { cwd: opts.repoRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  if (ancestry.exitCode !== 0) {
    return null;
  }
  const diff = Bun.spawnSync(
    [
      "git",
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      opts.baseRevision,
      "HEAD",
    ],
    {
      cwd: opts.repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  if (diff.exitCode !== 0) {
    return null;
  }
  return diff.stdout
    .toString()
    .split("\0")
    .filter((path) => path.length > 0);
}

function formatOutputs(outputs: ScopeOutputs): string {
  return `${Object.entries(outputs)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\n")}\n`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const event = argv
    .find((arg) => arg.startsWith("--event="))
    ?.slice("--event=".length);
  if (!event) {
    console.error("ci-change-scope: --event=<GitHub event name> is required.");
    return 2;
  }
  // CI executes this policy from the base archive against the merge tree's data.
  const rootArgument = argv.find((arg) => arg.startsWith("--repo-root="));
  const repoRoot = rootArgument
    ? resolve(rootArgument.slice("--repo-root=".length))
    : resolve(import.meta.dir, "..");
  const { fullPushPlan, planPullRequest } = await import("./ci-pr-plan.ts");
  const ref = argv.find((arg) => arg.startsWith("--ref="))?.slice(6) ?? "";
  const nextPush = event === "push" && ref === "refs/heads/next";
  let outputs = fullPushPlan({
    releaseHosts: !nextPush && event !== "pull_request",
  });
  let reason = `event ${event} always runs the full matrix`;
  if (event === "pull_request" || nextPush) {
    const baseRevision = argument(argv, "--base-revision=");
    const paths = nextPush
      ? revisionPaths({ repoRoot, baseRevision })
      : pullRequestPaths(repoRoot);
    if (paths === null) {
      reason = "the pull request diff is unavailable; running the full matrix";
    } else {
      const counts = new Map<PathKind, number>();
      for (const path of paths) {
        counts.set(pathKind(path), (counts.get(pathKind(path)) ?? 0) + 1);
      }
      reason = `${paths.length} changed paths (${[...counts]
        .map(([kind, count]) => `${kind} ${count}`)
        .join(", ")})`;
    }
    outputs = await planPullRequest({
      repoRoot,
      changed: paths,
      draft: event === "pull_request" && process.env.PR_DRAFT === "true",
      full: event === "pull_request" && process.env.PR_FULL === "true",
      baseRef: process.env.PR_BASE_REF,
      releaseHosts: false,
      pullRequest: event === "pull_request",
      mac: process.env.PR_MAC === "true",
      e2e: process.env.PR_E2E === "true",
    });
    console.log(
      `test selection: ${outputs.selection_mode}; draft: ${outputs.draft}; shard indices: ${outputs.test_shards}`
    );
  }
  console.log(`change scope: ${outputs.scope}; ${reason}`);
  process.stdout.write(formatOutputs(outputs));
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, formatOutputs(outputs));
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(
      summaryPath,
      `Change scope: \`${outputs.scope}\` (${reason}).\n`
    );
  }
  return 0;
}

function argument(argv: readonly string[], prefix: string): string {
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? "";
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
