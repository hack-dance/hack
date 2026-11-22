import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  dockerJobInputs,
  matchesDockerJobInput,
} from "../scripts/ci-docker-inputs.ts";
import { planPullRequest } from "../scripts/ci-pr-plan.ts";
import { requiresWorkflowFull } from "../scripts/ci-workflow-guard.ts";

const repoRoot = resolve(import.meta.dir, "..");
const workflow = `jobs:
  docker-e2e-shard:
    steps:
      - run: bun tests/e2e/run.ts
`;
const sources = {
  ".github/workflows/ci.yml": workflow,
  "tests/e2e/run.ts": 'import "./scenarios/base.ts";',
  "tests/e2e/scenarios/base.ts": "export {};",
};

test("a newly registered scenario brings its transitive helper into Docker qualification", () => {
  const path = "tests/fixtures/new-helper.ts";
  const before = dockerJobInputs({ repoRoot: "/fixture", sources });
  const after = dockerJobInputs({
    repoRoot: "/fixture",
    sources: {
      ...sources,
      "tests/e2e/run.ts":
        'import "./scenarios/base.ts"; import "./scenarios/new.ts";',
      "tests/e2e/scenarios/new.ts": 'import "../../fixtures/new-helper.ts";',
      [path]: "export {};",
    },
  });
  expect(before?.has(path)).toBe(false);
  expect(after?.has(path)).toBe(true);
});

test("literal executed helpers and compiled crates are dependencies without an import edge", () => {
  const inputs = dockerJobInputs({
    repoRoot: "/fixture",
    sources: {
      ...sources,
      "tests/e2e/scenarios/base.ts":
        'const entry=resolve(import.meta.dir,"../../fixtures/runner.ts"); const manifest=resolve("packages","config-compiler","Cargo.toml");',
      "tests/fixtures/runner.ts": 'import "./transitive.ts";',
      "tests/fixtures/transitive.ts": "export {};",
      "packages/config-compiler/Cargo.toml": "[package]",
    },
  });
  expect(inputs?.has("tests/fixtures/runner.ts")).toBe(true);
  expect(inputs?.has("tests/fixtures/transitive.ts")).toBe(true);
  expect(
    inputs &&
      matchesDockerJobInput({
        path: "packages/config-compiler/src/lib.rs",
        inputs,
      })
  ).toBe(true);
});

test("workflow package commands follow workspace build scripts", () => {
  const inputs = dockerJobInputs({
    repoRoot: "/fixture",
    sources: {
      ...sources,
      ".github/workflows/ci.yml": workflow.replace(
        "bun tests/e2e/run.ts",
        "bun run build"
      ),
      "package.json": JSON.stringify({
        scripts: { build: "bun run --cwd packages/cli build" },
      }),
      "packages/cli/package.json": JSON.stringify({
        scripts: { build: "bun ../../scripts/build-cli.ts" },
      }),
      "scripts/build-cli.ts": 'import "../src/cli.ts";',
      "src/cli.ts": "export {};",
    },
  });
  expect(inputs?.has("src/cli.ts")).toBe(true);
});

test("real shard execution inputs retain Docker when paired with the model registry", async () => {
  const inputs = dockerJobInputs({ repoRoot });
  expect(inputs).not.toBeNull();
  for (const path of [
    "tests/fixtures/shared-host-helper.ts",
    "packages/config-compiler/src/lib.rs",
    "tests/docker-context.test.ts",
  ]) {
    expect(inputs && matchesDockerJobInput({ path, inputs }), path).toBe(true);
    const plan = await planPullRequest({
      repoRoot,
      changed: ["scripts/lib/tla-runtime-models.ts", path],
      draft: false,
      full: false,
      selection: { mode: "selected", reason: "fixture", files: [] },
    });
    expect(plan.docker_suite, path).toBe(true);
    expect(plan.state_models, path).toBe(true);
  }
  expect(
    inputs &&
      matchesDockerJobInput({
        path: "scripts/lib/tla-runtime-models.ts",
        inputs,
      })
  ).toBe(false);
});

test("unknown paths widen every job tier rather than only unit files", async () => {
  expect(requiresWorkflowFull(["future/engine.bin"])).toBe(true);
  const plan = await planPullRequest({
    repoRoot,
    changed: ["future/engine.bin"],
    draft: false,
    full: false,
    selection: { mode: "full", reason: "unknown", files: [] },
  });
  expect(plan).toMatchObject({
    scope: "full",
    docker_suite: true,
    state_models: true,
    build_smoke: true,
    runtime_core: true,
  });
});

test("missing workflow input evidence is unavailable rather than an empty dependency set", () => {
  expect(dockerJobInputs({ repoRoot: "/fixture", sources: {} })).toBeNull();
});
