import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { CI_JOBS } from "../scripts/prerelease-plan.ts";
import { selectScenarios } from "./e2e/harness.ts";
import { ALL_SCENARIOS, shardScenarioNames } from "./e2e/run.ts";
import {
  DEFAULT_DURATION_HINT_SECONDS,
  E2E_DURATION_HINTS_SECONDS,
  MAX_SHARD_COUNT,
  parseShard,
  partitionScenarios,
  selectShard,
} from "./e2e/shard.ts";

const repoRoot = resolve(import.meta.dir, "..");
const runner = resolve(import.meta.dir, "e2e/run.ts");
const defaultNames = selectScenarios({ scenarios: ALL_SCENARIOS }).map(
  (scenario) => scenario.name
);
const LONG_SCENARIOS = [
  "native-config-networks",
  "native-config-compose",
  "native-config-routing",
];

type Workflow = {
  readonly jobs: Record<
    string,
    {
      readonly name?: string;
      readonly needs?: string | readonly string[];
      readonly if?: string;
      readonly strategy?: {
        readonly "fail-fast"?: boolean;
        readonly matrix?: { readonly shard?: readonly number[] };
      };
      readonly steps: readonly {
        readonly name?: string;
        readonly run?: string;
        readonly env?: Record<string, string>;
        readonly with?: Record<string, string>;
      }[];
    }
  >;
};

async function ciWorkflow(): Promise<Workflow> {
  return Bun.YAML.parse(
    await Bun.file(resolve(repoRoot, ".github/workflows/ci.yml")).text()
  ) as Workflow;
}

function expectExactPartition(opts: {
  readonly shards: readonly (readonly string[])[];
  readonly names: readonly string[];
}): void {
  const flattened = opts.shards.flat();
  // Disjoint: no scenario appears twice across (or within) shards.
  expect(new Set(flattened).size).toBe(flattened.length);
  // Complete: the union is exactly the input set.
  expect([...flattened].sort()).toEqual([...opts.names].sort());
}

describe("e2e shard selection", () => {
  test("parses only 1 <= i <= n <= MAX_SHARD_COUNT", () => {
    expect(parseShard("1/4")).toEqual({ index: 1, count: 4 });
    expect(parseShard("4/4")).toEqual({ index: 4, count: 4 });
    expect(parseShard(`1/${MAX_SHARD_COUNT}`)).toEqual({
      index: 1,
      count: MAX_SHARD_COUNT,
    });
    for (const invalid of [
      "",
      "1",
      "0/4",
      "5/4",
      "1/0",
      "01/4",
      "1/04",
      "-1/4",
      "1.5/4",
      " 1/4",
      "1/4 ",
      "1/4/4",
      `1/${MAX_SHARD_COUNT + 1}`,
    ]) {
      expect(parseShard(invalid)).toBeNull();
    }
  });

  test("every default scenario runs in exactly one shard for each count", () => {
    expect(defaultNames.length).toBeGreaterThan(0);
    for (let count = 1; count <= 8; count += 1) {
      const shards = partitionScenarios({ names: defaultNames, count });
      expect(shards).toHaveLength(count);
      expectExactPartition({ shards, names: defaultNames });
      // The runner's own selection agrees with the pure partition.
      for (let index = 1; index <= count; index += 1) {
        expect(shardScenarioNames({ index, count })).toEqual(
          shards[index - 1] as readonly string[]
        );
      }
    }
  });

  test("the plan is deterministic and keeps registration order within a shard", () => {
    const first = partitionScenarios({ names: defaultNames, count: 4 });
    const second = partitionScenarios({ names: [...defaultNames], count: 4 });
    expect(second).toEqual(first);
    for (const shard of first) {
      const positions = shard.map((name) => defaultNames.indexOf(name));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  test("the known long scenarios land on separate CI shards", () => {
    const shards = partitionScenarios({ names: defaultNames, count: 4 });
    const homes = LONG_SCENARIOS.map((name) =>
      shards.findIndex((shard) => shard.includes(name))
    );
    expect(homes.every((home) => home >= 0)).toBe(true);
    expect(new Set(homes).size).toBe(LONG_SCENARIOS.length);
    // The longest scenario runs alone so nothing queues behind it.
    const networks = shards.find((shard) =>
      shard.includes("native-config-networks")
    );
    expect(networks).toEqual(["native-config-networks"]);
  });

  test("unhinted scenarios still run and duplicates are refused", () => {
    const names = ["alpha", "beta", "gamma"];
    const shards = partitionScenarios({ names, count: 2, hints: {} });
    expectExactPartition({ shards, names });
    expect(DEFAULT_DURATION_HINT_SECONDS).toBeGreaterThan(0);
    expect(
      selectShard({ names, selection: { index: 3, count: 3 }, hints: {} })
    ).toHaveLength(1);
    expect(() =>
      partitionScenarios({ names: ["alpha", "alpha"], count: 2 })
    ).toThrow("Scenario names must be unique to shard");
    expect(() => partitionScenarios({ names, count: 0 })).toThrow(
      "Shard count must be an integer from 1 to 32"
    );
  });

  test("duration hints name only registered default scenarios", () => {
    for (const name of Object.keys(E2E_DURATION_HINTS_SECONDS)) {
      expect(defaultNames).toContain(name);
    }
  });

  test("the runner refuses invalid or combined shard selection before any scenario", () => {
    for (const args of [
      ["--shard=0/4"],
      ["--shard=5/4"],
      ["--shard=1/4", "--only=init"],
    ]) {
      const result = Bun.spawnSync(["bun", runner, ...args], {
        cwd: repoRoot,
        env: { ...process.env, HACK_E2E_DOCKER: "0" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout.toString()).not.toContain("isolation canary");
    }
    const listed = Bun.spawnSync(["bun", runner, "--list", "--shard=1/4"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(listed.exitCode).toBe(0);
    expect(
      listed.stdout
        .toString()
        .trim()
        .split("\n")
        .map((line) => line.split(/\s+/)[0])
    ).toEqual([...shardScenarioNames({ index: 1, count: 4 })]);
  });
});

describe("docker-e2e CI fan-in", () => {
  test("the shard matrix covers 1..n and every shard runs its own slice", async () => {
    const shardJob = (await ciWorkflow()).jobs["docker-e2e-shard"];
    const matrix = shardJob?.strategy?.matrix?.shard ?? [];
    const count = matrix.length;
    expect(count).toBeGreaterThanOrEqual(3);
    expect(matrix).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(shardJob?.strategy?.["fail-fast"]).toBe(false);
    expect(shardJob?.name).toBe(
      `docker-e2e shard \${{ matrix.shard }}/${count}`
    );
    const run = shardJob?.steps.find(
      (step) => step.name === "Run local and Docker E2E shard"
    );
    expect(run?.env?.HACK_E2E_SHARD).toBe(`\${{ matrix.shard }}/${count}`);
    expect(run?.run).toContain(
      'HACK_E2E_REQUIRE_DOCKER=1 HACK_E2E_REQUIRE_TMUX=1 bun run test:e2e:local:docker --shard="$HACK_E2E_SHARD"'
    );
    const capsule = shardJob?.steps.find(
      (step) =>
        step.name === "Preserve process-policy capsule and startup diagnostic"
    );
    expect(capsule?.with?.name).toBe(
      "process-policy-capsules-shard-${{ matrix.shard }}"
    );
    for (let shard = 1; shard <= count; shard += 1) {
      expect(
        shardScenarioNames({ index: shard, count }).length
      ).toBeGreaterThan(0);
    }
  });

  test("docker-e2e passes only when every shard succeeded and never skips", async () => {
    const workflow = await ciWorkflow();
    const fanIn = workflow.jobs["docker-e2e"];
    expect(fanIn?.name ?? "docker-e2e").toBe("docker-e2e");
    expect(fanIn?.needs).toBe("docker-e2e-shard");
    expect(fanIn?.if).toBe("${{ always() }}");
    const gate = fanIn?.steps.find(
      (step) => step.name === "Require every docker-e2e shard to succeed"
    );
    expect(gate?.env?.SHARD_RESULT).toBe(
      "${{ needs.docker-e2e-shard.result }}"
    );
    expect(gate?.run).toContain('if [ "$SHARD_RESULT" != "success" ]; then');
    expect(gate?.run).toContain("exit 1");
    // No other job may claim the docker-e2e name.
    const named = Object.entries(workflow.jobs).filter(
      ([key, job]) => (job.name ?? key) === "docker-e2e"
    );
    expect(named.map(([key]) => key)).toEqual(["docker-e2e"]);
  });

  test("the prerelease gate requires the fan-in and every shard job by name", async () => {
    const count =
      (await ciWorkflow()).jobs["docker-e2e-shard"]?.strategy?.matrix?.shard
        ?.length ?? 0;
    const required: readonly string[] = CI_JOBS;
    expect(required).toContain("docker-e2e");
    for (let shard = 1; shard <= count; shard += 1) {
      expect(required).toContain(`docker-e2e shard ${shard}/${count}`);
    }
    expect(
      required.filter((name) => name.startsWith("docker-e2e shard "))
    ).toHaveLength(count);
  });
});
