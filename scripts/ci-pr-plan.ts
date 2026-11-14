/** PR and next-push policy layered over the coarse change-scope classifier. */
import {
  COMPILER_HOSTS,
  planScope,
  scopeOutputs,
  touchesRelocatedCli,
} from "./ci-change-scope.ts";
import { selectTests, type TestSelection } from "./ci-test-selection.ts";
import { requiresWorkflowFull } from "./ci-workflow-guard.ts";
import { classifyTestPools } from "./test-shard-plan.ts";

export type PullRequestPlan = ReturnType<typeof scopeOutputs> & {
  readonly draft: boolean;
  /** Empty means full inventory; otherwise JSON selected paths, never shell input. */
  readonly test_files: string;
  /** Original shard indices retain the exact full-push job names. */
  readonly test_shards: string;
  readonly selection_mode: string;
  readonly docker_suite: boolean;
  readonly defer_macos: boolean;
  readonly build_smoke: boolean;
};

function compilerHosts(
  releaseHosts: boolean
): (typeof COMPILER_HOSTS)[number][] {
  return COMPILER_HOSTS.filter(
    (host) => releaseHosts || host.os !== "macos-15-intel"
  );
}

/** Apply the PR host tier without removing the Linux Rust safety checks. */
function selectedCompilerHosts(opts: {
  readonly draft: boolean;
  readonly mac: boolean;
  readonly linuxRust: boolean;
  readonly changed: readonly string[] | null;
  readonly releaseHosts: boolean;
  readonly nativeHosts: boolean;
  readonly coarseHosts: string;
}): ReturnType<typeof compilerHosts> {
  if (opts.draft) {
    return [];
  }
  const relocatedCli = opts.changed?.some(touchesRelocatedCli) ?? true;
  return compilerHosts(opts.releaseHosts).filter(
    (host) =>
      (opts.linuxRust && host.platform === "linux") ||
      (relocatedCli && host.os === "ubuntu-latest") ||
      (opts.mac &&
        (opts.nativeHosts ||
          opts.coarseHosts.includes(JSON.stringify(host.os))))
  );
}

/** Main and explicit release qualification retain every compiler architecture. */
export function fullPushPlan(
  opts: { readonly releaseHosts?: boolean } = {}
): PullRequestPlan {
  return {
    ...scopeOutputs("full"),
    compiler_hosts: JSON.stringify(compilerHosts(opts.releaseHosts !== false)),
    draft: false,
    test_files: "",
    test_shards: "[1,2,3,4,5,6,7,8]",
    selection_mode: "full",
    docker_suite: true,
    defer_macos: false,
    build_smoke: true,
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

/** Rust crate inputs retain Linux checks even when the PR defers macOS. */
export function touchesRustInput(path: string): boolean {
  return (
    /^packages\/relay-guest\//.test(path) ||
    (/^packages\/(?:runtime-core|config-compiler)\//.test(path) &&
      !path.endsWith(".md"))
  );
}

function shouldRunCandidate(opts: {
  readonly linuxRust: boolean;
  readonly mac: boolean;
  readonly full: boolean;
  readonly changed: readonly string[] | null;
}): boolean {
  return (
    opts.linuxRust ||
    (opts.mac && (opts.full || (opts.changed?.some(touchesCandidate) ?? true)))
  );
}

export async function planPullRequest(opts: {
  readonly repoRoot: string;
  readonly changed: readonly string[] | null;
  readonly draft: boolean;
  readonly full: boolean;
  /** Stable-line PRs retain the complete tier, including Intel compiler coverage. */
  readonly baseRef?: string;
  /** Next integrations retain platform pools; PRs opt into expensive tiers. */
  readonly pullRequest?: boolean;
  readonly mac?: boolean;
  readonly e2e?: boolean;
  /** Intel qualifies releases; main and explicit full dispatches retain it. */
  readonly releaseHosts?: boolean;
  /** Selection seam for policy tests. */
  readonly selection?: TestSelection;
}): Promise<PullRequestPlan> {
  const stablePr = opts.pullRequest !== false && opts.baseRef === "main";
  const full = opts.full || stablePr || requiresWorkflowFull(opts.changed);
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
  const integration = opts.pullRequest === false;
  const linuxRust =
    !opts.draft && (opts.changed?.some(touchesRustInput) ?? false);
  const mac = !opts.draft && (integration || full || opts.mac === true);
  const e2e = !opts.draft && (integration || full || opts.e2e === true);
  const macos = mac && pools.macos.length > 0 ? [1, 2, 3] : [];
  const linux = [4, 5, 6, 7, 8];
  const allJobs = full;
  const compiler = selectedCompilerHosts({
    draft: opts.draft,
    mac,
    linuxRust,
    changed: opts.changed,
    releaseHosts: stablePr || opts.releaseHosts === true,
    nativeHosts: allJobs || (opts.changed?.some(touchesCompilerHost) ?? false),
    coarseHosts: coarse.compiler_hosts,
  });
  return {
    ...coarse,
    // All PRs use the selector, including docs and native-only changes. The
    // prior focused path stays available for manual use, not as a second oracle.
    suite: true,
    test_focus: "",
    test_layout: "pooled",
    compiler_hosts: JSON.stringify(compiler),
    compiler_rust: coarse.compiler_rust || linuxRust,
    runtime_core: shouldRunCandidate({
      linuxRust,
      mac,
      full: allJobs,
      changed: opts.changed,
    }),
    draft: opts.draft,
    test_files: JSON.stringify(selection.files),
    test_shards: JSON.stringify([...macos, ...linux]),
    selection_mode: selection.mode,
    docker_suite: e2e && coarse.suite,
    defer_macos: !mac,
    build_smoke: !opts.draft && (integration || full),
  };
}
