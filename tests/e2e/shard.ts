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
 * Measured hosted Docker durations in seconds (Blacksmith 4 vCPU Ubuntu 24.04,
 * next CI run 38181288374). Hints only balance shards; they never bound or
 * skip a scenario, so a stale value costs wall time, not coverage. Refresh
 * them from a docker-e2e summary when a scenario's runtime changes materially.
 */
export const E2E_DURATION_HINTS_SECONDS: Readonly<Record<string, number>> = {
  "native-config-networks": 3409,
  "native-config-compose": 973,
  "native-config-routing": 571,
  "native-config-build": 209,
  "native-config-down-hooks": 158,
  "native-config-process-policy": 136,
  "native-compose-adoption-job-worktrees": 108,
  "native-compose-adoption-local-worktrees": 52,
  "native-compose-adoption-network-health-worktrees": 48,
  "native-compose-adoption-managed-worktrees": 46,
  "lifecycle-session-recovery": 46,
  "dependency-cache-bootstrap": 44,
  "native-compose-adoption-dependency-worktrees": 39,
  "dependency-cache": 37,
  "worktree-parallel-up": 35,
  "native-compose-adoption-network-worktrees": 34,
  "native-compose-adoption-plural-network-worktrees": 33,
  "native-compose-adoption-branch-worktrees": 33,
  "portable-multiservice": 30,
  "dependency-cache-package": 30,
  "native-compose-adoption-worktrees": 28,
  "native-compose-adoption-string-worktrees": 28,
  "native-config-files": 20,
  doctor: 18,
  "lifecycle-host-process": 13,
  "up-down": 12,
  "cache-prune": 12,
  "dependency-cache-protocol": 11,
  "worktree-branch-default": 2,
  "agent-docs-sync": 2,
  "domain-migration-files": 1,
  "automation-check": 1,
  "worktree-secrets": 1,
  "worktree-registry": 1,
  "env-secrets": 1,
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
