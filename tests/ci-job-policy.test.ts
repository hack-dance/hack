import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { deriveJobInputs } from "../scripts/ci-docker-inputs.ts";
import {
  CI_JOB_POLICY,
  DERIVED_JOB_ROWS,
  workflowGateKey,
} from "../scripts/ci-job-policy.ts";
import {
  type PullRequestPlan,
  planPullRequest,
} from "../scripts/ci-pr-plan.ts";
import { isRecord } from "../src/lib/guards.ts";

const repoRoot = resolve(import.meta.dir, "..");
const selection = {
  mode: "selected",
  reason: "job policy fixture",
  files: [],
} as const;
const outputReferences =
  /needs(?:\.changes|\[['"]changes['"]\])(?:\.outputs|\[['"]outputs['"]\])(?:\.([\w_]+)|\[['"]([\w_]+)['"]\])?/g;

function gateKeys(workflow: unknown): Set<string> {
  if (!(isRecord(workflow) && isRecord(workflow.jobs))) {
    throw new Error("CI workflow has no jobs");
  }
  const found = new Set<string>();
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (!isRecord(job)) {
      continue;
    }
    const conditions = [{ condition: job.if, steps: false }];
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (isRecord(step)) {
        conditions.push({ condition: step.if, steps: true });
      }
    }
    for (const { condition, steps } of conditions) {
      if (typeof condition !== "string") {
        continue;
      }
      for (const [, property, bracket] of condition.matchAll(
        outputReferences
      )) {
        found.add(
          workflowGateKey(id, property ?? bracket ?? "<computed>", steps)
        );
      }
    }
  }
  return found;
}

test("every scope-conditioned workflow job or step has a policy row", async () => {
  const workflow: unknown = Bun.YAML.parse(
    await Bun.file(resolve(repoRoot, ".github/workflows/ci.yml")).text()
  );
  const declared = CI_JOB_POLICY.flatMap((row) =>
    [row.output, ...("modifiers" in row ? row.modifiers : [])].map((output) =>
      workflowGateKey(row.job, output, "steps" in row)
    )
  );
  expect([...gateKeys(workflow)].sort()).toEqual(declared.sort());
});

async function plan(path: string) {
  return await planPullRequest({
    repoRoot,
    changed: [path],
    draft: false,
    full: false,
    selection,
  });
}

test("every checkout input in a derived tier enables its workflow gate", async () => {
  const tracked = await Bun.spawn(["git", "ls-files", "-z"], {
    cwd: repoRoot,
    stdout: "pipe",
  });
  const paths = (await new Response(tracked.stdout).text())
    .split("\0")
    .filter(Boolean);
  expect(await tracked.exited).toBe(0);
  const plans = new Map<string, PullRequestPlan>();
  for (const { job, output, tier } of DERIVED_JOB_ROWS) {
    const inputs = deriveJobInputs({ repoRoot, tier });
    if (!inputs) {
      throw new Error(`Missing inputs for ${tier}`);
    }
    const inputsInTree = paths.filter((path) => inputs.has(path));
    expect(inputsInTree.length, tier).toBeGreaterThan(0);
    for (const path of inputsInTree) {
      const result = plans.get(path) ?? (await plan(path));
      plans.set(path, result);
      const value = result[output];
      expect(
        value === true || (output === "compiler_hosts" && value !== "[]"),
        `${job} must run for ${path}`
      ).toBe(true);
    }
  }
}, 60_000);

test.each([
  "src/future.wasm",
  "packages/runtime-core/newdir/x.bin",
])("unknown file %s selects the full plan", async (path) => {
  expect(await plan(path)).toMatchObject({
    scope: "full",
    docker_suite: true,
    build_smoke: true,
    state_models: true,
  });
}, 30_000);

test.each([
  "tests/native-compose-file-owner.test.ts",
  "assets/cut.gif",
  "index.ts",
])("compiler qualification keeps both Linux hosts for %s", async (path) => {
  expect(
    JSON.parse((await plan(path)).compiler_hosts).map(
      (host: { os: string }) => host.os
    )
  ).toEqual(["ubuntu-latest", "ubuntu-24.04-arm"]);
}, 30_000);

test("candidate qualification follows its guest launcher fixture", async () => {
  expect(
    (await plan("tests/fixtures/environment-launcher-tty.py")).runtime_core
  ).toBe(true);
}, 30_000);

test.each([
  "tests/fixtures/native-detached-owner.ts",
  "tests/fixtures/text-output/color.txt",
])("named unit fixture %s retains scoped qualification", async (path) => {
  const result = await plan(path);
  expect(result.scope).toBe("typescript");
  expect(result.suite).toBe(true);
  expect(result.docker_suite).toBe(false);
  expect(result.state_models).toBe(false);
}, 30_000);
