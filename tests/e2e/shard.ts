/**
 * Deterministic sharding for the hack e2e runner.
 *
 * Docker CI splits the default scenario set across parallel runners with
 * `--shard=i/n`. The partition is a pure function of the scenario names, the
 * shard count and the checked-in duration hints below, so every runner of one
 * commit computes the same plan without coordinating: each scenario lands in
 * exactly one shard and no shard runs a scenario twice.
 *
 * Balancing is longest-processing-time first: scenarios are taken from the
 * longest hint down (name order breaks ties) and each goes to the currently
 * lightest shard (lowest index breaks ties). The long native scenarios therefore
 * occupy separate shards before the short ones fill the remaining capacity.
 * Within a shard, scenarios keep the runner's registration order.
 */

export type ShardSelection = {
  /** One-based shard index, `1 <= index <= count`. */
  readonly index: number;
  readonly count: number;
};

/** Upper bound on `n` in `--shard=i/n`; far above any useful runner fan-out. */
export const MAX_SHARD_COUNT = 32;

/** Hint for a scenario with no measured duration yet; keeps it in the plan. */
export const DEFAULT_DURATION_HINT_SECONDS = 60;

/**
 * Measured hosted Docker durations in seconds (GitHub-hosted ubuntu-24.04,
 * docker-e2e shards of next CI run 42634804251, 2026-11-09; the PASS line of
 * each scenario, rounded, minimum 1). Hints only balance shards; they never
 * bound or skip a scenario, so a stale value costs wall time, not coverage.
 * Refresh them from the shard logs when a scenario's runtime changes
 * materially. `native-config-networks` alone is longer than any other shard's
 * whole load, so it always runs by itself and sets the docker-e2e wall time.
 */
export const E2E_DURATION_HINTS_SECONDS: Readonly<Record<string, number>> = {
  "native-config-networks": 3090,
  "native-config-compose": 736,
  "native-config-routing": 558,
  "native-compose-adoption-job-worktrees": 177,
  "native-config-build": 155,
  "native-config-down-hooks": 155,
  "native-config-process-policy": 122,
  "native-compose-adoption-local-worktrees": 90,
  "pattern-p01-dependency-bootstrap": 66,
  "native-compose-adoption-managed-worktrees": 64,
  "native-compose-adoption-network-health-worktrees": 56,
  "native-compose-adoption-network-worktrees": 55,
  "pattern-p07-capability-overlays": 54,
  "dependency-cache-bootstrap": 49,
  "native-compose-adoption-dependency-worktrees": 49,
  "native-compose-adoption-plural-network-worktrees": 44,
  "dependency-cache": 43,
  "native-compose-adoption-branch-worktrees": 38,
  "portable-bootstrap-negatives": 38,
  "dependency-cache-package": 37,
  "shared-host-helpers": 36,
  "native-compose-adoption-string-worktrees": 35,
  "worktree-parallel-up": 35,
  "native-compose-adoption-worktrees": 34,
  "portable-multiservice": 33,
  "native-config-files": 30,
  "exec-stale-env": 29,
  "mcp-logs-compose": 24,
  "lifecycle-session-recovery": 21,
  "cache-prune": 18,
  "up-down": 16,
  "dependency-cache-protocol": 14,
  "lifecycle-host-process": 14,
  "agent-surface-freeze": 12,
  "pattern-p02-portable-toolchain": 9,
  "compose-config-hash-drift": 5,
  "worktree-branch-default": 5,
  doctor: 3,
  "agent-docs-sync": 2,
  "automation-check": 2,
  "domain-migration-files": 2,
  "env-secrets": 1,
  "worktree-registry": 1,
  "worktree-secrets": 1,
  init: 1,
};

const SHARD_PATTERN = /^([1-9][0-9]*)\/([1-9][0-9]*)$/;

/** Parse `i/n`; returns null for anything outside `1 <= i <= n <= MAX`. */
export function parseShard(value: string): ShardSelection | null {
  const match = SHARD_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count > MAX_SHARD_COUNT || index > count) {
    return null;
  }
  return { index, count };
}

function hintFor(opts: {
  readonly name: string;
  readonly hints: Readonly<Record<string, number>>;
}): number {
  return Object.hasOwn(opts.hints, opts.name)
    ? (opts.hints[opts.name] as number)
    : DEFAULT_DURATION_HINT_SECONDS;
}

/**
 * Split `names` into `count` disjoint shards whose union is `names`.
 * Duplicate names are rejected because they would make a scenario run twice.
 */
export function partitionScenarios(opts: {
  readonly names: readonly string[];
  readonly count: number;
  readonly hints?: Readonly<Record<string, number>>;
}): readonly (readonly string[])[] {
  const hints = opts.hints ?? E2E_DURATION_HINTS_SECONDS;
  if (
    !Number.isSafeInteger(opts.count) ||
    opts.count < 1 ||
    opts.count > MAX_SHARD_COUNT
  ) {
    throw new Error("Shard count must be an integer from 1 to 32");
  }
  if (new Set(opts.names).size !== opts.names.length) {
    throw new Error("Scenario names must be unique to shard");
  }

  const order = new Map(opts.names.map((name, position) => [name, position]));
  const longestFirst = [...opts.names].sort((left, right) => {
    const byHint =
      hintFor({ name: right, hints }) - hintFor({ name: left, hints });
    if (byHint !== 0) {
      return byHint;
    }
    return left < right ? -1 : 1;
  });

  const loads: number[] = Array.from({ length: opts.count }, () => 0);
  const shards: string[][] = Array.from({ length: opts.count }, () => []);
  for (const name of longestFirst) {
    let lightest = 0;
    for (let shard = 1; shard < opts.count; shard += 1) {
      if ((loads[shard] as number) < (loads[lightest] as number)) {
        lightest = shard;
      }
    }
    loads[lightest] = (loads[lightest] as number) + hintFor({ name, hints });
    (shards[lightest] as string[]).push(name);
  }

  return shards.map((shard) =>
    shard.sort(
      (left, right) =>
        (order.get(left) as number) - (order.get(right) as number)
    )
  );
}

/** The names `selection` runs, in registration order. */
export function selectShard(opts: {
  readonly names: readonly string[];
  readonly selection: ShardSelection;
  readonly hints?: Readonly<Record<string, number>>;
}): readonly string[] {
  const shards = partitionScenarios({
    names: opts.names,
    count: opts.selection.count,
    hints: opts.hints,
  });
  return shards[opts.selection.index - 1] ?? [];
}
