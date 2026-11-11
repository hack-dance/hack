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
const NETWORK_PARTS = [
  "native-config-networks-lifecycle",
  "native-config-networks-policy",
  "native-config-networks-ingress",
];
const LONG_SCENARIOS = [
  ...NETWORK_PARTS,
  "native-config-compose",
  "native-config-routing",
];

type Workflow = {
  readonly concurrency?: { readonly group?: string };
  readonly on: {
    readonly push?: { readonly branches?: readonly string[] };
    readonly pull_request?: { readonly types?: readonly string[] } | null;
    readonly workflow_dispatch?: unknown;
  };
  readonly jobs: Record<
    string,
    {
      readonly name?: string;
      readonly needs?: string | readonly string[];
      readonly if?: string;
      readonly env?: Record<string, string>;
      readonly "continue-on-error"?: boolean;
      readonly "runs-on"?: string;
      readonly strategy?: {
        readonly "fail-fast"?: boolean;
        readonly matrix?: { readonly shard?: readonly number[] };
      };
      readonly steps: readonly {
        readonly name?: string;
        readonly id?: string;
        readonly uses?: string;
        readonly shell?: string;
        readonly "continue-on-error"?: boolean;
        readonly run?: string;
        readonly env?: Record<string, string>;
        readonly with?: Record<string, string>;
      }[];
    }
  >;
};

async function ciWorkflow(file = "ci.yml"): Promise<Workflow> {
  return Bun.YAML.parse(
    await Bun.file(resolve(repoRoot, ".github/workflows", file)).text()
  ) as Workflow;
}

async function sharedSteps(): Promise<Workflow["jobs"][string]["steps"]> {
  const action = Bun.YAML.parse(
    await Bun.file(
      resolve(repoRoot, ".github/actions/docker-e2e-shard/action.yml")
    ).text()
  ) as { runs: { steps: Workflow["jobs"][string]["steps"] } };
  return action.runs.steps;
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

  test("four and six shards each contain all 48 defaults exactly once", () => {
    expect(defaultNames).toHaveLength(48);
    for (const count of [4, 6]) {
      expectExactPartition({
        shards: partitionScenarios({ names: defaultNames, count }),
        names: defaultNames,
      });
    }
  });

  test("trial extras stay on the lightest shard, away from every network scenario", async () => {
    const shards = partitionScenarios({ names: defaultNames, count: 6 });
    const loads = shards.map((names) =>
      names.reduce(
        (sum, name) =>
          sum +
          (E2E_DURATION_HINTS_SECONDS[name] ?? DEFAULT_DURATION_HINT_SECONDS),
        0
      )
    );
    const extra = Number(
      (await ciWorkflow("docker-e2e-trial.yml")).jobs[
        "docker-e2e-trial"
      ]?.steps.find(
        (step) => step.uses === "./.github/actions/docker-e2e-shard"
      )?.with?.["extra-shard"]
    );
    expect(extra).toBe(6);
    expect(loads[extra - 1]).toBe(Math.min(...loads));
    expect(
      shards[extra - 1]?.some((name) => NETWORK_PARTS.includes(name))
    ).toBe(false);
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

  test("the network parts spread over CI shards and run without other long scenarios", () => {
    for (const name of LONG_SCENARIOS) {
      expect(defaultNames).toContain(name);
    }
    const shards = partitionScenarios({ names: defaultNames, count: 4 });
    const home = (name: string) =>
      shards.findIndex((shard) => shard.includes(name));
    const networkHomes = NETWORK_PARTS.map(home);
    // The parts used to be one scenario that set the docker-e2e wall time.
    expect(new Set(networkHomes).size).toBe(NETWORK_PARTS.length);
    for (const index of networkHomes) {
      expect(
        shards[index]?.filter((name) => LONG_SCENARIOS.includes(name))
      ).toHaveLength(1);
    }
    expect(networkHomes).not.toContain(home("native-config-compose"));
    expect(networkHomes).not.toContain(home("native-config-routing"));
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
    const steps = await sharedSteps();
    const run = steps.find(
      (step) => step.name === "Run local and Docker E2E shard"
    );
    expect(shardJob?.steps.at(-1)?.with).toEqual({
      shard: "${{ matrix.shard }}",
      count: "4",
      "extra-shard": "4",
    });
    expect(run?.env?.HACK_E2E_SHARD).toBe(
      "${{ inputs.shard }}/${{ inputs.count }}"
    );
    expect(run?.shell).toBe("bash");
    expect(run?.id).toBe("e2e");
    const smoke = steps.find((step) => step.id === "smoke");
    expect(smoke?.name).toBe(
      "Smoke container resource metadata without optional fields"
    );
    const summary = steps.find(
      (step) =>
        step.name === "Summarize shard elapsed time and scenario results"
    );
    expect(summary?.["continue-on-error"]).toBe(true);
    expect(summary?.env?.E2E_SUCCEEDED).toBe(
      "${{ steps.e2e.outcome == 'success' && (inputs.shard != inputs.extra-shard || steps.smoke.outcome == 'success') }}"
    );
    expect(run?.run).toContain(
      'HACK_E2E_REQUIRE_DOCKER=1 HACK_E2E_REQUIRE_TMUX=1 bun run test:e2e:local:docker --shard="$HACK_E2E_SHARD"'
    );
    const capsule = steps.find(
      (step) =>
        step.name === "Preserve process-policy capsule and startup diagnostic"
    );
    expect(capsule?.with?.name).toBe(
      "process-policy-capsules-${{ inputs.count }}-shards-${{ inputs.shard }}"
    );
    for (let shard = 1; shard <= count; shard += 1) {
      expect(
        shardScenarioNames({ index: shard, count }).length
      ).toBeGreaterThan(0);
    }
  });

  test("trial shares steps but cannot gate aggregate or prerelease", async () => {
    const workflow = await ciWorkflow();
    const trialWorkflow = await ciWorkflow("docker-e2e-trial.yml");
    const trial = trialWorkflow.jobs["docker-e2e-trial"];
    expect(
      Object.keys(workflow.jobs).some((name) => name.includes("trial"))
    ).toBe(false);
    const gate = workflow.jobs["docker-e2e-shard"];
    expect(trial?.name).toBe("docker-e2e trial shard ${{ matrix.shard }}/6");
    expect(trial?.["continue-on-error"]).toBe(true);
    expect(trial?.["runs-on"]).toBe("ubuntu-24.04");
    expect(trial?.strategy?.["fail-fast"]).toBe(false);
    expect(trial?.strategy?.matrix?.shard).toEqual([1, 2, 3, 4, 5, 6]);
    expect(trial?.steps.at(-1)?.with).toEqual({
      shard: "${{ matrix.shard }}",
      count: "6",
      "extra-shard": "6",
    });
    expect(trial?.steps.at(-1)?.uses).toBe(gate?.steps.at(-1)?.uses);
    expect(gate?.steps.at(-1)?.uses).toBe("./.github/actions/docker-e2e-shard");
    expect(trial?.if).toContain("needs.changes.outputs.suite == 'true'");
    expect(trial?.if).toContain("github.event_name == 'push'");
    expect(trial?.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(trial?.if).toContain("github.event_name == 'pull_request'");
    expect(trial?.if).toContain(
      "contains(github.event.pull_request.labels.*.name, 'docker-e2e-trial')"
    );
    expect(trialWorkflow.on.push?.branches).toEqual(["next", "main"]);
    expect(trialWorkflow.on.pull_request?.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "labeled",
    ]);
    expect(trialWorkflow.on).toHaveProperty("workflow_dispatch");
    expect(trialWorkflow.jobs.changes?.if).toContain(
      "contains(github.event.pull_request.labels.*.name, 'docker-e2e-trial')"
    );
    expect(trialWorkflow.jobs.changes?.if).toContain(
      "github.event.action != 'labeled' || github.event.label.name == 'docker-e2e-trial'"
    );
    expect(trialWorkflow.concurrency?.group).toContain(
      "github.event.action != 'labeled' || github.event.label.name == 'docker-e2e-trial'"
    );
    expect(trialWorkflow.concurrency?.group).toContain(
      "format('run-{0}', github.run_id)"
    );
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(trialWorkflow.jobs.changes?.steps.at(-1)).toEqual(
      workflow.jobs.changes?.steps.at(-1)
    );
    for (const step of await sharedSteps()) {
      if (step.run) {
        expect(step.shell).toBe("bash");
      }
    }
    expect(gate?.steps.at(-1)?.with?.["extra-shard"]).toBe("4");
    const extras = (await sharedSteps()).filter(
      (step) =>
        step.name?.startsWith("Verify ") ||
        step.name?.startsWith("Smoke container resource")
    );
    expect(extras).toHaveLength(6);
    for (const step of extras ?? []) {
      expect(step).toHaveProperty("if", "inputs.shard == inputs.extra-shard");
    }
    expect(workflow.jobs["docker-e2e"]?.needs).toEqual([
      "changes",
      "docker-e2e-shard",
    ]);
    expect(CI_JOBS.filter((name) => name.startsWith("docker-e2e"))).toEqual([
      "docker-e2e shard 1/4",
      "docker-e2e shard 2/4",
      "docker-e2e shard 3/4",
      "docker-e2e shard 4/4",
      "docker-e2e",
    ]);
  });

  test("docker-e2e accepts success, cancellation or an out-of-scope skip and never hides failures", async () => {
    const workflow = await ciWorkflow();
    const fanIn = workflow.jobs["docker-e2e"];
    expect(fanIn?.name ?? "docker-e2e").toBe("docker-e2e");
    expect(fanIn?.needs).toEqual(["changes", "docker-e2e-shard"]);
    expect(fanIn?.if).toBe("${{ always() }}");
    const shardJob = workflow.jobs["docker-e2e-shard"];
    expect(shardJob?.needs).toBe("changes");
    expect(shardJob?.if).toBe("${{ needs.changes.outputs.suite == 'true' }}");
    const gate = fanIn?.steps.find(
      (step) => step.name === "Reject failed or skipped docker-e2e shards"
    );
    expect(gate?.env).toEqual({
      CHANGES_RESULT: "${{ needs.changes.result }}",
      SCOPE: "${{ needs.changes.outputs.scope }}",
      SUITE: "${{ needs.changes.outputs.suite }}",
      SHARD_RESULT: "${{ needs.docker-e2e-shard.result }}",
    });
    expect(gate?.run).toContain('if [ "$SHARD_RESULT" != "success" ]; then');
    expect(gate?.run).toContain("exit 1");
    if (!gate?.run) {
      throw new Error("Missing aggregate shell gate");
    }
    // [scope result, suite in scope, shard result, exit code]
    for (const [changes, suite, result, exitCode] of [
      ["success", "true", "success", 0],
      ["success", "true", "cancelled", 0],
      ["success", "true", "failure", 1],
      ["success", "true", "skipped", 1],
      ["success", "true", "", 1],
      ["success", "true", "unexpected", 1],
      // Out of scope: skipped shards pass, anything that ran must still pass.
      ["success", "false", "skipped", 0],
      ["success", "false", "failure", 1],
      ["success", "", "skipped", 1],
      // A failed or skipped scope fails closed; a cancelled run does not.
      ["failure", "false", "skipped", 1],
      ["skipped", "false", "skipped", 1],
      ["", "false", "skipped", 1],
      ["cancelled", "", "skipped", 0],
    ] as const) {
      const run = Bun.spawnSync(["bash", "-e", "-c", gate.run], {
        env: {
          ...process.env,
          CHANGES_RESULT: changes,
          SCOPE: "fixture",
          SUITE: suite,
          SHARD_RESULT: result,
        },
        stdout: "ignore",
        timeout: 5000,
      });
      expect(
        run.exitCode,
        `changes=${changes} suite=${suite} shards=${result}`
      ).toBe(exitCode);
    }
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
