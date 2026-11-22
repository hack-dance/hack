/** PR and next-push policy layered over the coarse change-scope classifier. */
import {
  COMPILER_HOSTS,
  pathKind,
  planScope,
  scopeOutputs,
} from "./ci-change-scope.ts";
import { deriveJobInputs, readsUnitFixture } from "./ci-docker-inputs.ts";
import { JOB_TIERS, type Tier } from "./ci-job-policy.ts";
import {
  buildSelectionGraph,
  selectTests,
  type TestSelection,
} from "./ci-test-selection.ts";
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
  readonly state_models: boolean;
  readonly job_input_policy?: "v1";
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
  readonly enabled: boolean;
  readonly releaseHosts: boolean;
}): ReturnType<typeof compilerHosts> {
  return opts.draft || !opts.enabled
    ? []
    : compilerHosts(opts.releaseHosts).filter(
        (host) => opts.mac || host.platform === "linux"
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
    state_models: true,
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

function changedTiers(opts: {
  readonly repoRoot: string;
  readonly baseRoot?: string;
  readonly changed: readonly string[] | null;
}) {
  const roots = new Set([opts.repoRoot, opts.baseRoot || opts.repoRoot]);

  const inputs = JOB_TIERS.map((tier) => ({
    tier,
    trees: [...roots].map((repoRoot) => deriveJobInputs({ repoRoot, tier })),
  }));
  const selectedTiers = new Set<Tier>();
  let full = inputs.some(({ trees }) => trees.includes(null));
  if (!full) {
    const testTrees = [...roots].map((repoRoot) => ({
      repoRoot,
      files: buildSelectionGraph({ repoRoot }).files,
    }));
    const unitFiles = new Set(testTrees.flatMap(({ files }) => files));
    for (const path of opts.changed ?? []) {
      let known = pathKind(path) === "docs" || unitFiles.has(path);
      for (const { tier, trees } of inputs) {
        if (trees.some((tree) => tree?.has(path))) {
          selectedTiers.add(tier);
          known ||= trees.some((tree) => tree?.knows(path));
        }
      }
      full ||= !(
        known || testTrees.some((tree) => readsUnitFixture({ ...tree, path }))
      );
    }
  }
  return { full, selectedTiers };
}

export async function planPullRequest(opts: {
  readonly repoRoot: string;
  readonly baseRoot?: string;
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
  const forcedFull =
    opts.full ||
    stablePr ||
    requiresWorkflowFull(opts.changed, { deriveUnknown: true });
  const { full, selectedTiers } = forcedFull
    ? { full: true, selectedTiers: new Set<Tier>() }
    : changedTiers(opts);
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
  const mac =
    !opts.draft && (integration || stablePr || opts.full || opts.mac === true);
  const tierEnabled = (tier: Tier): boolean =>
    !opts.draft && (full || selectedTiers.has(tier));
  const integrationTiers = !opts.draft && integration;
  const e2e =
    tierEnabled("docker") ||
    integrationTiers ||
    (!opts.draft && opts.e2e === true);
  const macos = mac && pools.macos.length > 0 ? [1, 2, 3] : [];
  const linux = [4, 5, 6, 7, 8];
  const compilerRust = tierEnabled("compilerRust");
  const compiler = selectedCompilerHosts({
    draft: opts.draft,
    mac,
    enabled: compilerRust || tierEnabled("compiler"),
    releaseHosts: stablePr || opts.releaseHosts === true,
  });
  return {
    ...coarse,
    job_input_policy: "v1",
    // All PRs use the selector, including docs and native-only changes. The
    // prior focused path stays available for manual use, not as a second oracle.
    suite: true,
    test_focus: "",
    test_layout: "pooled",
    compiler_hosts: JSON.stringify(compiler),
    compiler_rust: compilerRust,
    runtime_core: tierEnabled("candidate"),
    docs_site: full || selectedTiers.has("docs"),
    draft: opts.draft,
    test_files: JSON.stringify(selection.files),
    test_shards: JSON.stringify([...macos, ...linux]),
    selection_mode: selection.mode,
    docker_suite: e2e,
    state_models: tierEnabled("models") || integrationTiers,
    defer_macos: !mac,
    build_smoke: tierEnabled("build") || integrationTiers,
  };
}
