import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  deriveJobInputs,
  dockerJobInputs,
  matchesDockerJobInput,
} from "../scripts/ci-docker-inputs.ts";
import { planPullRequest } from "../scripts/ci-pr-plan.ts";

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
}, 30_000);

test.each([
  "future/engine.bin",
  "tests/future/engine.bin",
])("unknown path %s widens every job tier", async (path) => {
  const plan = await planPullRequest({
    repoRoot,
    changed: [path],
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

test("nested shell files, Compose definitions and unignored context contents are Docker inputs", () => {
  const inputs = dockerJobInputs({
    repoRoot: "/fixture",
    sources: {
      ...sources,
      "tests/e2e/scenarios/base.ts": 'const script = "scripts/outer.sh";',
      "scripts/outer.sh": 'bash "${SCRIPT_DIR}/inner.sh"',
      "scripts/inner.sh": "docker compose -f fixtures/compose.yaml build",
      "fixtures/compose.yaml":
        "services:\n  app:\n    build:\n      context: ./ctx\n      dockerfile: Containerfile\n",
      "fixtures/ctx/Containerfile":
        'COPY ["payload/", "/dest"]\nADD extras /extras\nCOPY --from=other /external /dest\n',
      "fixtures/ctx/.dockerignore": "payload\n",
      "fixtures/ctx/Containerfile.dockerignore":
        "payload/private\npayload/**/*.tmp\n",
    },
  });
  for (const path of [
    "scripts/inner.sh",
    "fixtures/ctx/Containerfile",
    "fixtures/ctx/.dockerignore",
    "fixtures/ctx/Containerfile.dockerignore",
    "fixtures/ctx/payload/deep/data.bin",
    "fixtures/ctx/extras/deleted.bin",
  ]) {
    expect(inputs?.has(path), path).toBe(true);
  }
  for (const path of [
    "fixtures/ctx/payload/private/data.bin",
    "fixtures/ctx/payload/deep/data.tmp",
    "fixtures/ctx/external",
    "fixtures/ctx/unrelated.bin",
  ]) {
    expect(inputs?.has(path), path).toBe(false);
  }
});

test("base-tree dependencies select Docker after an input is deleted or renamed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ci-tier-rename-"));
  try {
    const headRoot = join(root, "head");
    const baseRoot = join(root, "base");
    const definition = `${workflow}
      - run: bun test tests/docker-context.test.ts
      - run: bun tests/e2e/run.ts
  state-models:
    steps:
      - run: bun test tests/tla-result.test.ts
  test-shard:
    steps:
      - if: matrix.shard == 8 && needs.changes.outputs.build_smoke == 'true'
        run: bun run build
  config-compiler:
    steps:
      - if: needs.changes.outputs.compiler_rust == 'true'
        run: echo compiler fixture
  runtime-core:
    steps:
      - run: echo candidate fixture
  docs-site:
    steps:
      - if: needs.changes.outputs.docs_site == 'true'
        run: echo docs fixture
`;
    for (const tree of [headRoot, baseRoot]) {
      await mkdir(join(tree, "packages/db"), { recursive: true });
      await Bun.write(join(tree, ".github/workflows/ci.yml"), definition);
      await Bun.write(join(tree, "tests/tla-result.test.ts"), "export {};");
    }
    const previous = "tests/docker-context.test.ts";
    const renamed = "tests/context-renamed.test.ts";
    await Bun.write(join(baseRoot, previous), "export {};");
    await Bun.write(join(headRoot, renamed), "export {};");
    for (const changes of [[previous], [previous, renamed]]) {
      const plan = await planPullRequest({
        repoRoot: headRoot,
        baseRoot,
        changed: [...changes, "scripts/lib/tla-runtime-models.ts"],
        draft: false,
        full: false,
        selection: { mode: "selected", reason: "fixture", files: [] },
      });
      expect(plan).toMatchObject({
        scope: "typescript",
        docker_suite: true,
        state_models: true,
        build_smoke: false,
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["packages/config-compiler/src/lib.rs", true, true, true],
  ["tests/tla-result.test.ts", false, true, false],
  ["packages/runtime-core/src/lib.rs", false, false, false],
] as const)("consumers select the affected tiers for %s", async (path, docker, models, build) => {
  const plan = await planPullRequest({
    repoRoot,
    changed: models
      ? [path, ...(build ? ["scripts/lib/tla-runtime-models.ts"] : [])]
      : [path],
    draft: false,
    full: false,
    selection: { mode: "selected", reason: "fixture", files: [] },
  });
  expect(plan).toMatchObject({
    docker_suite: docker,
    state_models: models,
    build_smoke: build,
  });
});

test("guard inventory keys do not execute the named tests or their sample crate paths", () => {
  const inputs = dockerJobInputs({
    repoRoot: "/fixture",
    sources: {
      ...sources,
      "tests/e2e/scenarios/base.ts":
        'const inventory={"tests/policy.test.ts":"guard budget"};',
      "tests/policy.test.ts":
        'const manifest=resolve("packages","runtime-core","Cargo.toml");',
      "packages/runtime-core/Cargo.toml": "[package]",
    },
  });
  expect(inputs?.has("tests/policy.test.ts")).toBe(true);
  expect(inputs?.has("packages/runtime-core/")).toBe(false);
});

test("Python model discovery follows literal source and reference inputs", () => {
  const inputs = deriveJobInputs({
    repoRoot: "/fixture",
    tier: "models",
    sources: {
      ".github/workflows/ci.yml": `jobs:
  state-models:
    steps:
      - run: python3 -m unittest discover -s tests/python -p test_contract.py
`,
      "tests/python/test_contract.py":
        'SOURCE = ROOT / "scripts/contract.py"\nDOC = ROOT / "docs/reference/contract.md"',
      "tests/python/test_other.py": 'SOURCE = ROOT / "scripts/excluded.py"',
      "scripts/contract.py": "DATA = Path(__file__).parent / 'contract.json'",
      "scripts/contract.json": "{}",
      "scripts/excluded.py": "# Separate suite",
      "docs/reference/contract.md": "Contract",
    },
  });
  expect(inputs?.has("tests/python/test_contract.py")).toBe(true);
  expect(inputs?.has("scripts/contract.py")).toBe(true);
  expect(inputs?.has("scripts/contract.json")).toBe(true);
  expect(inputs?.has("docs/reference/contract.md")).toBe(true);
  expect(inputs?.has("tests/python/test_other.py")).toBe(false);
  expect(inputs?.has("scripts/excluded.py")).toBe(false);
});

test.each([
  ["docs/reference/application-benchmark-protocol.md", false],
  ["docs/performance.md", false],
  ["packages/runtime-core/src/provider/profile.rs", false],
] as const)(
  "model workflow retains its Python reference input %s",
  async (path, docker) => {
    const plan = await planPullRequest({
      repoRoot,
      changed: [path],
      draft: false,
      full: false,
      selection: { mode: "selected", reason: "fixture", files: [] },
    });
    expect(plan).toMatchObject({
      docker_suite: docker,
      state_models: true,
      build_smoke: false,
    });
  },
  30_000
);

test("generated project paths do not traverse contributor toolchain commands", () => {
  const inputs = dockerJobInputs({
    repoRoot: "/fixture",
    sources: {
      ...sources,
      "tests/e2e/scenarios/base.ts":
        'const example = ".hack/toolchain/run.sh";',
      ".hack/toolchain/run.sh": "sh scripts/private-toolchain.sh",
      "scripts/private-toolchain.sh": "# contributor tooling",
    },
  });
  expect(inputs?.has(".hack/toolchain/run.sh")).toBe(true);
  expect(inputs?.has("scripts/private-toolchain.sh")).toBe(false);
});
