import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { CI_JOBS, requireExactHeadCi } from "../scripts/prerelease-plan.ts";
import { selectScenarios } from "./e2e/harness.ts";
import { ALL_SCENARIOS, shardScenarioNames } from "./e2e/run.ts";
import {
  DEFAULT_DURATION_HINT_SECONDS,
  E2E_DURATION_HINTS_SECONDS,
} from "./e2e/shard.ts";

type Step = {
  readonly name?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly shell?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, string>;
  readonly "continue-on-error"?: boolean;
};
type Job = {
  readonly name?: string;
  readonly if?: string;
  readonly needs?: string[];
  readonly "continue-on-error"?: boolean;
  readonly "runs-on"?: string;
  readonly strategy: {
    readonly "fail-fast": boolean;
    readonly matrix: { readonly shard: number[] };
  };
  readonly steps: Step[];
};
type Workflow = {
  readonly on: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly concurrency: { readonly "cancel-in-progress": boolean };
  readonly jobs: Record<string, Job>;
};
const root = resolve(import.meta.dir, "..");
const trial = Bun.YAML.parse(
  await Bun.file(resolve(root, ".github/workflows/docker-e2e-trial.yml")).text()
) as Workflow;
const ci = Bun.YAML.parse(
  await Bun.file(resolve(root, ".github/workflows/ci.yml")).text()
) as Workflow;
const action = Bun.YAML.parse(
  await Bun.file(
    resolve(root, ".github/actions/docker-e2e-shard/action.yml")
  ).text()
) as { readonly runs: { readonly steps: Step[] } };

test("trial is manual-only, advisory, six standard runners with distinct checks", () => {
  expect(Object.keys(trial.on)).toEqual(["workflow_dispatch"]);
  expect(trial.permissions).toEqual({ contents: "read" });
  expect(trial.concurrency["cancel-in-progress"]).toBe(false);
  expect(Object.keys(trial.jobs)).toEqual(["docker-e2e-trial"]);
  const job = trial.jobs["docker-e2e-trial"];
  expect(job?.if).toBe("${{ github.event_name == 'workflow_dispatch' }}");
  expect(job?.["continue-on-error"]).toBe(true);
  expect(job?.["runs-on"]).toBe("ubuntu-24.04");
  expect(job?.strategy).toEqual({
    "fail-fast": false,
    matrix: { shard: [1, 2, 3, 4, 5, 6] },
  });
  expect(job?.name).toBe("docker-e2e trial shard ${{ matrix.shard }}/6");
  expect(job?.needs).toBeUndefined();
  expect(
    job?.steps.find((step) => step.uses === "actions/checkout@v4")?.with
  ).toEqual({ "persist-credentials": false });
  expect(
    job?.steps.find(
      (step) => step.uses === "./.github/actions/docker-e2e-shard"
    )?.with
  ).toEqual({ shard: "${{ matrix.shard }}", count: "6", "extra-shard": "6" });
  for (const ciJob of Object.values(ci.jobs)) {
    expect(ciJob.needs ?? []).not.toContain("docker-e2e-trial");
    expect(
      ciJob.steps.some(
        (step) => step.uses === "./.github/actions/docker-e2e-shard"
      )
    ).toBe(false);
  }
  expect(CI_JOBS.some((name) => name.includes("trial"))).toBe(false);
});

test("trial success cannot replace exact-source CI on either release branch", () => {
  const sha = "a".repeat(40);
  for (const branch of ["next", "main"] as const) {
    expect(() =>
      requireExactHeadCi({
        sourceRevision: sha,
        branch,
        run: {
          head_sha: sha,
          head_branch: branch,
          event: branch === "main" ? "push" : "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          path: ".github/workflows/docker-e2e-trial.yml",
        },
        jobs: [],
      })
    ).toThrow("CI run is required on the exact source SHA");
  }
});

test("six-shard trial covers the unchanged default set exactly once; extras avoid networks", () => {
  const names = selectScenarios({ scenarios: ALL_SCENARIOS }).map(
    (scenario) => scenario.name
  );
  const shards = Array.from({ length: 6 }, (_, index) =>
    shardScenarioNames({ index: index + 1, count: 6 })
  );
  expect(shards.flat().sort()).toEqual([...names].sort());
  expect(new Set(shards.flat()).size).toBe(names.length);
  const totals = shards.map((shard) =>
    shard.reduce(
      (total, name) =>
        total +
        (E2E_DURATION_HINTS_SECONDS[name] ?? DEFAULT_DURATION_HINT_SECONDS),
      0
    )
  );
  expect(totals[5]).toBe(Math.min(...totals));
  expect(
    shards[5]?.some((name) => name.startsWith("native-config-networks-"))
  ).toBe(false);
});

test("trial action retains every required Docker command and supplemental check", () => {
  const base = ci.jobs["docker-e2e-shard"];
  expect(base).toBeDefined();
  for (const step of base?.steps ?? []) {
    if (!step.run) {
      continue;
    }
    const copy = action.runs.steps.find(
      (candidate) => candidate.name === step.name
    );
    expect(copy, step.name).toBeDefined();
    expect(copy?.shell).toBe("bash");
    expect(
      copy?.run?.replace(' 2>&1 | tee "$RUNNER_TEMP/docker-e2e.log"', "")
    ).toBe(step.run);
    expect(copy?.if).toBe(
      step.if?.replace(
        "matrix.shard == 4",
        "inputs.shard == inputs.extra-shard"
      )
    );
    const env = { ...step.env };
    if (env.HACK_E2E_SHARD) {
      env.HACK_E2E_SHARD = "${{ inputs.shard }}/${{ inputs.count }}";
    }
    expect(copy?.env ?? {}).toEqual(env);
  }
  const summary = action.runs.steps.find(
    (step) => step.name === "Summarize shard elapsed time and scenario results"
  );
  expect(summary?.if).toBe("always()");
  expect(summary?.["continue-on-error"]).toBe(true);
  expect(summary?.env?.E2E_SUCCEEDED).toBe(
    "${{ steps.e2e.outcome == 'success' && (inputs.shard != inputs.extra-shard || steps.smoke.outcome == 'success') }}"
  );
  expect(summary?.run).toBe("bun scripts/docker-e2e-summary.ts");
});
