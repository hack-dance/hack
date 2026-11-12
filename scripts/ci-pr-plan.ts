/** PR-only policy layered over the existing coarse change-scope classifier. */
import { COMPILER_HOSTS, planScope, scopeOutputs } from "./ci-change-scope.ts";
import { selectTests, type TestSelection } from "./ci-test-selection.ts";
import { requiresWorkflowFull } from "./ci-workflow-guard.ts";
import { classifyTestPools } from "./test-shard-plan.ts";

export type PullRequestPlan = ReturnType<typeof scopeOutputs> & {
  readonly draft: boolean;
  /** Empty on pushes; JSON file list on PRs. Never evaluated as shell input. */
  readonly test_files: string;
  /** Original shard indices retain the exact full-push job names. */
  readonly test_shards: string;
  readonly selection_mode: string;
  readonly docker_suite: boolean;
};

export function fullPushPlan(): PullRequestPlan {
  return {
    ...scopeOutputs("full"),
    draft: false,
    test_files: "",
    test_shards: "[1,2,3,4,5,6,7,8]",
    selection_mode: "full",
    docker_suite: true,
  };
}

/** Inputs copied/compiled by the candidate job, including its qualification scripts. */
export function touchesCandidate(path: string): boolean {
  return /^(?:packages\/(?:runtime-core|config-compiler|relay-guest)\/|hack-local$|scripts\/(?:build-hack-local|native-|.*candidate|.*provider)|mise\.toml$|\.github\/|(?:.*\/)?(?:Cargo\.(?:toml|lock)|rust-toolchain(?:\.toml)?)$)/.test(
    path
  );
}

/** Rust compiler/host inputs require its native host matrix, not just Linux. */
export function touchesCompilerHost(path: string): boolean {
  return /^(?:packages\/config-compiler\/|scripts\/build-config-compiler\.ts$|mise\.toml$|\.github\/|(?:.*\/)?rust-toolchain(?:\.toml)?$)/.test(
    path
  );
}

export async function planPullRequest(opts: {
  readonly repoRoot: string;
  readonly changed: readonly string[] | null;
  readonly draft: boolean;
  readonly full: boolean;
  /** Selection seam for policy tests. */
  readonly selection?: TestSelection;
}): Promise<PullRequestPlan> {
  const full = opts.full || requiresWorkflowFull(opts.changed);
  const selection =
    opts.selection ??
    selectTests({
      repoRoot: opts.repoRoot,
      changed: opts.changed,
      full,
    });
  const coarse = full ? scopeOutputs("full") : planScope(opts.changed ?? []);
  const pools = await classifyTestPools({
    repoRoot: opts.repoRoot,
    files: selection.files,
  });
  const macos = !opts.draft && pools.macos.length > 0 ? [1, 2, 3] : [];
  const linux = [4, 5, 6, 7, 8];
  const allJobs = full;
  const nativeHosts = allJobs || opts.changed?.some(touchesCompilerHost);
  const compiler = opts.draft
    ? "[]"
    : nativeHosts
      ? JSON.stringify(COMPILER_HOSTS)
      : coarse.compiler_hosts;
  return {
    ...coarse,
    // All PRs use the selector, including docs and native-only changes. The
    // prior focused path stays available for manual use, not as a second oracle.
    suite: true,
    test_focus: "",
    test_layout: "pooled",
    compiler_hosts: compiler,
    runtime_core:
      !opts.draft &&
      (allJobs || (opts.changed?.some(touchesCandidate) ?? true)),
    draft: opts.draft,
    test_files: JSON.stringify(selection.files),
    test_shards: JSON.stringify([...macos, ...linux]),
    selection_mode: selection.mode,
    docker_suite: coarse.suite,
  };
}
