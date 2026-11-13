import { describe, expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import { COMPILER_HOSTS } from "../scripts/ci-change-scope.ts";
import {
  fullPushPlan,
  planPullRequest,
  touchesCandidate,
  touchesCompilerHost,
} from "../scripts/ci-pr-plan.ts";
import { selectTests } from "../scripts/ci-test-selection.ts";
import {
  buildVerifiedPlan,
  classifyTestPools,
  discoverTestFiles,
} from "../scripts/test-shard-plan.ts";
import { isRecord } from "../src/lib/guards.ts";

const repoRoot = resolve(import.meta.dir, "..");
const sources = {
  "src/leaf.ts": "export const value = 1;",
  "src/barrel.ts": 'export * from "./leaf.ts";',
  "src/cycle.ts": 'export * from "./barrel.ts"; export * from "./cycle.ts";',
  "src/other.ts": "export const other = 2;",
  "tests/a.test.ts": 'import {value} from "../src/cycle.ts";',
  "tests/b.test.ts": 'import {other} from "../src/other.ts";',
  "tests/docs.test.ts":
    'import {readFileSync as read} from "node:fs"; read("docs/a.md");',
  "tests/service-contract.test.ts": "export {};",
  "tests/opaque.test.ts": 'const path = "dynamic"; import(path);',
  "tests/helper.ts": 'export const source = Bun.file("generated.json");',
  "tests/generated.test.ts": 'import {source} from "./helper.ts";',
  "packages/db/drizzle.config.ts": "export const config = {};",
  "src/client.config.ts": "export const config = {};",
  // Present files ensure these tests exercise their own rule, not deletion.
  "bun.lock": "{}",
  "package.json": "{}",
  "tsconfig.json": "{}",
  ".github/workflows/ci.yml": "name: fixture",
  "scripts/helper.ts": "export {};",
  "tests/fixtures/input.ts": "export {};",
  "tests/e2e/run.ts": "export {};",
  "tests/models/input.ts": "export {};",
  "tests/__fixtures__/input.ts": "export {};",
  "packages/config-compiler/src/lib.rs": "",
  "docs/examples/compose.yml": "services: {}",
  "unknown.txt": "fixture",
} as const;
const tests = Object.keys(sources).filter((file) => file.endsWith(".test.ts"));
function select(changed: readonly string[] | null) {
  return selectTests({ repoRoot: "/fixture", sources, tests, changed });
}

describe("conservative dependency selection", () => {
  test("follows exports, cycles and transitive imports; does not select unrelated pure tests", () => {
    expect(select(["src/leaf.ts"]).files).toEqual([
      "tests/a.test.ts",
      "tests/docs.test.ts",
      "tests/generated.test.ts",
      "tests/opaque.test.ts",
      "tests/service-contract.test.ts",
    ]);
    expect(select(["src/other.ts"]).files).toContain("tests/b.test.ts");
    expect(select(["tests/b.test.ts"]).files).toContain("tests/b.test.ts");
  });
  test("docs select every source reader, contract and opaque test", () => {
    expect(select(["docs/a.md"]).files).toEqual([
      "tests/docs.test.ts",
      "tests/generated.test.ts",
      "tests/opaque.test.ts",
      "tests/service-contract.test.ts",
    ]);
  });
  for (const changed of [
    null,
    [],
    ["bun.lock"],
    ["package.json"],
    ["packages/db/drizzle.config.ts"],
    ["src/client.config.ts"],
    ["tsconfig.json"],
    [".github/workflows/ci.yml"],
    ["scripts/helper.ts"],
    ["tests/fixtures/input.ts"],
    ["tests/e2e/run.ts"],
    ["tests/models/input.ts"],
    ["tests/__fixtures__/input.ts"],
    ["packages/config-compiler/src/lib.rs"],
    ["src/deleted.ts"],
    ["docs/examples/compose.yml"],
    ["unknown.txt"],
  ]) {
    test(`widens non-graph/unknown inputs: ${JSON.stringify(changed)}`, () => {
      const plan = select(changed);
      expect(plan.mode).toBe("full");
      expect(plan.files).toEqual([...tests].sort());
    });
  }
  test("full override cannot be narrowed by a small change", () => {
    expect(
      selectTests({
        repoRoot: "/fixture",
        sources,
        tests,
        changed: ["src/leaf.ts"],
        full: true,
      }).mode
    ).toBe("full");
  });
  test("the hand-maintained always-run rule is independent of reader and contract rules", () => {
    const file = "tests/ci-change-scope.test.ts";
    expect(
      selectTests({
        repoRoot: "/fixture",
        changed: ["docs/a.md"],
        tests: [file],
        sources: { [file]: "export {};" },
      }).files
    ).toEqual([file]);
  });
  test.each([
    'const data = Bun.file("docs/a.md");',
    'import {open as load} from "node:fs/promises"; load("docs/a.md");',
  ])("source readers remain always-run without contract names: %s", (source) => {
    expect(
      selectTests({
        repoRoot: "/fixture",
        changed: ["docs/a.md"],
        tests: ["tests/a.test.ts"],
        sources: { "tests/a.test.ts": source },
      }).files
    ).toEqual(["tests/a.test.ts"]);
  });
  test.each([
    'const entry = "../index.ts";',
    "const entry = `${root}/index.ts`;",
    'const binary = "../dist/hack";',
    'const binary = join(root, "dist", "hack");',
    'Bun.spawn(["fixture"]);',
    'import {spawn as launch} from "node:child_process"; launch(["fixture"]);',
    'export {spawn as run} from "node:child_process";',
    'const {spawn: run} = Bun; run(["fixture"]);',
    'const cp = await import("node:child_process"); cp.exec("fixture");',
    'require("node:child_process").exec("fixture");',
    'const runtime = Bun; const {spawn: run} = runtime; run(["fixture"]);',
    'exec("fixture");',
    'fork("fixture");',
    'new Worker("fixture");',
    'const Thread=Worker; new Thread("fixture");',
    'import {Worker as Thread} from "node:worker_threads"; new Thread("fixture");',
    'import {$ as shell} from "bun"; shell`fixture`;',
    "Bun.$`fixture`;",
    'Bun["$"]`fixture`;',
  ])("source indirection makes its transitive callers depend on all changes: %s", (source) => {
    const result = selectTests({
      repoRoot: "/fixture",
      changed: ["src/unrelated.ts"],
      tests: ["tests/a.test.ts", "tests/b.test.ts"],
      sources: {
        "src/unrelated.ts": "export {};",
        "src/launch.ts": source,
        "src/barrel.ts": 'export * from "./launch.ts";',
        "tests/a.test.ts": 'import "../src/barrel.ts";',
        "tests/b.test.ts": "export {};",
      },
    });
    expect(result.files).toEqual(["tests/a.test.ts"]);
  });
  test("suite preloads and their transitive helpers affect every test without explicit edges", () => {
    const implicit = {
      ...sources,
      "bunfig.toml": '[test]\npreload=["./tests/preload.ts"]',
      "tests/preload.ts": 'import "./helpers/preload-guard.ts";',
      "tests/helpers/preload-guard.ts": 'import "../../src/preload-leaf.ts";',
      "src/preload-leaf.ts": "export const value=1;",
    };
    for (const path of [
      "tests/preload.ts",
      "tests/helpers/preload-guard.ts",
      "src/preload-leaf.ts",
    ]) {
      const result = selectTests({
        repoRoot: "/fixture",
        sources: implicit,
        tests,
        changed: [path],
      });
      expect(result.mode).toBe("full");
      expect(result.files).toEqual([...tests].sort());
    }
    expect(
      selectTests({
        repoRoot: "/fixture",
        sources: implicit,
        tests,
        changed: ["src/leaf.ts"],
      }).files
    ).not.toContain("tests/b.test.ts");
  });
  test("workspace preload dependencies also force the full set", () => {
    const result = selectTests({
      repoRoot: "/fixture",
      tests,
      sources: {
        ...sources,
        "packages/db/bunfig.toml": '[test]\npreload="./preload.ts"',
        "packages/db/preload.ts": 'import "./src/guard.ts";',
        "packages/db/src/guard.ts": "export {};",
      },
      changed: ["packages/db/src/guard.ts"],
    });
    expect(result.mode).toBe("full");
    expect(result.files).toEqual([...tests].sort());
  });
  test("a production process launcher imported by a preload depends on all changes", () => {
    expect(
      selectTests({
        repoRoot: "/fixture",
        tests,
        sources: {
          ...sources,
          "bunfig.toml": '[test]\npreload="./tests/preload.ts"',
          "tests/preload.ts": 'import "../src/launcher.ts";',
          "src/launcher.ts": 'Bun.spawn(["fixture"]);',
        },
        changed: ["docs/a.md"],
      }).mode
    ).toBe("full");
  });
  test.each([
    "[test",
    "[test]\npreload=42",
    "[test]\npreload=[42]",
    '[test]\npreload="../outside.ts"',
  ])("invalid preload configuration independently selects all files: %s", (config) => {
    expect(
      selectTests({
        repoRoot: "/fixture",
        tests,
        sources: { ...sources, "bunfig.toml": config },
        changed: ["docs/a.md"],
      }).mode
    ).toBe("full");
  });
  test.each([
    undefined,
    'import "./missing.ts";',
    'const path="dynamic"; import(path);',
  ])("opaque preload inputs independently select all files: %s", (source) => {
    const input: Record<string, string> = {
      ...sources,
      "bunfig.toml": '[test]\npreload="./tests/preload.ts"',
    };
    if (source !== undefined) {
      input["tests/preload.ts"] = source;
    }
    expect(
      selectTests({
        repoRoot: "/fixture",
        tests,
        sources: input,
        changed: ["docs/a.md"],
      }).mode
    ).toBe("full");
  });
  test("the Bun builtin is a known preload input rather than an opaque package", () => {
    const result = selectTests({
      repoRoot: "/fixture",
      tests,
      sources: {
        ...sources,
        "bunfig.toml": '[test]\npreload="./tests/preload.ts"',
        "tests/preload.ts": 'import {secrets} from "bun";',
      },
      changed: ["docs/a.md"],
    });
    expect(result.mode).toBe("selected");
    expect(result.files).not.toContain("tests/b.test.ts");
  });
  test.each([
    "docs/reference/ci-test-selection.md",
    "src/commands/env.ts",
  ])("the actual repository graph selects a proper subset for %s", (path) => {
    const result = selectTests({
      repoRoot,
      changed: [path],
    });
    expect(result.mode).toBe("selected");
    expect(result.files.length).toBeLessThan(
      discoverTestFiles({ repoRoot }).length
    );
    expect(result.files).toContain("tests/cli-reference-docs.test.ts");
  });
  test.each([
    'import type {Value} from "@lib/leaf";',
    'export {value} from "@/lib/leaf.ts";',
    'const x = import("../src/lib/leaf.ts");',
    'const x = require("../src/lib/leaf.ts");',
    'import x = require("../src/lib/leaf.ts");',
  ])("resolves supported imports: %s", (source) => {
    const plan = selectTests({
      repoRoot: "/fixture",
      changed: ["src/lib/leaf.ts"],
      tests: ["tests/a.test.ts", "tests/b.test.ts"],
      sources: {
        "src/lib/leaf.ts": "export {};",
        "tests/a.test.ts": source,
        "tests/b.test.ts": "export {};",
      },
    });
    expect(plan.files).toEqual(["tests/a.test.ts"]);
  });
  test("workspace aliases resolve in their own suite rather than the root suite", () => {
    const plan = selectTests({
      repoRoot: "/fixture",
      changed: ["packages/db/src/value.ts"],
      tests: ["packages/db/tests/a.test.ts"],
      sources: {
        "packages/db/src/value.ts": "export {};",
        "src/value.ts": "export {};",
        "packages/db/tests/a.test.ts": 'import {value} from "@/value";',
      },
    });
    expect(plan.files).toEqual(["packages/db/tests/a.test.ts"]);
  });
  test("comments, strings and regexes cannot invent imports or hide real imports", () => {
    const plan = selectTests({
      repoRoot: "/fixture",
      changed: ["src/leaf.ts"],
      tests: ["tests/a.test.ts", "tests/b.test.ts"],
      sources: {
        "src/leaf.ts": "export {};",
        "tests/a.test.ts": '/* import "missing" */ import "../src/leaf.ts";',
        "tests/b.test.ts": 'const text = `import "../src/leaf.ts"`;',
      },
    });
    expect(plan.files).toEqual(["tests/a.test.ts"]);
  });
  test("unresolved local imports and unknown aliases run conservatively", () => {
    for (const source of [
      'import "./missing";',
      'import "@unknown/value";',
      'import "packages/db/src/value.ts";',
      'import "unknown-module";',
    ]) {
      expect(
        selectTests({
          repoRoot: "/fixture",
          changed: ["docs/a.md"],
          tests: ["tests/a.test.ts"],
          sources: { "tests/a.test.ts": source },
        }).files
      ).toEqual(["tests/a.test.ts"]);
    }
  });
});

describe("PR matrix policy", () => {
  test("ordinary light PRs defer platform and Docker inputs until opt-in or integration", async () => {
    const selection = {
      mode: "selected",
      reason: "fixture",
      files: [
        "packages/db/tests/smoke.test.ts",
        "tests/native-authored-project-start.test.ts",
      ],
    } as const;
    for (const changed of [
      ["docs/a.md"],
      ["src/a.ts"],
      ["packages/runtime-core/README.md"],
    ]) {
      const plan = await planPullRequest({
        repoRoot,
        changed,
        draft: false,
        full: false,
        selection,
      });
      expect(plan).toMatchObject({
        compiler_hosts: "[]",
        runtime_core: false,
        docker_suite: false,
        defer_macos: true,
        build_smoke: false,
        test_shards: "[4,5,6,7,8]",
        test_files: JSON.stringify(selection.files),
      });
    }
    const input = {
      repoRoot,
      changed: ["packages/config-compiler/src/lib.rs"],
      draft: false,
      full: false,
      selection,
    };
    expect(await planPullRequest({ ...input, mac: true })).toMatchObject({
      defer_macos: false,
      runtime_core: true,
      docker_suite: false,
      build_smoke: false,
      test_shards: "[1,2,3,4,5,6,7,8]",
    });
    expect(await planPullRequest({ ...input, e2e: true })).toMatchObject({
      defer_macos: true,
      runtime_core: true,
      docker_suite: true,
      build_smoke: false,
      test_shards: "[4,5,6,7,8]",
    });
    expect(await planPullRequest({ ...input, full: true })).toMatchObject({
      defer_macos: false,
      runtime_core: true,
      docker_suite: true,
      build_smoke: true,
      test_shards: "[1,2,3,4,5,6,7,8]",
    });
    expect(
      await planPullRequest({ ...input, pullRequest: false })
    ).toMatchObject({
      defer_macos: false,
      runtime_core: true,
      docker_suite: true,
      build_smoke: true,
      test_shards: "[1,2,3,4,5,6,7,8]",
    });
  });
  test.each([
    "packages/runtime-core/src/provider/setup.rs",
    "packages/relay-guest/src/main.rs",
    "packages/config-compiler/src/lib.rs",
    "packages/config-compiler/build.rs",
    "packages/runtime-core/provider-pins.json",
    "packages/config-compiler/tests/fixtures/schema-corpus.json",
    "packages/relay-guest/README.md",
  ])("light Rust input retains Linux candidate and compiler legs: %s", async (path) => {
    const input = { repoRoot, changed: [path], draft: false, full: false };
    const plan = await planPullRequest(input);
    expect(plan).toMatchObject({
      runtime_core: true,
      compiler_rust: true,
      compiler_hosts: JSON.stringify(
        COMPILER_HOSTS.filter((host) => host.platform === "linux")
      ),
      defer_macos: true,
      docker_suite: false,
      build_smoke: false,
      test_shards: "[4,5,6,7,8]",
    });
    expect(await planPullRequest({ ...input, draft: true })).toMatchObject({
      runtime_core: false,
      compiler_hosts: "[]",
      defer_macos: true,
    });
  });
  test("protected inputs and main PRs automatically run full tiers", async () => {
    for (const input of [
      { changed: [".github/workflows/ci.yml"] },
      { changed: ["scripts/ci-test-selection.ts"] },
      { changed: ["docs/a.md"], baseRef: "main" },
    ]) {
      const plan = await planPullRequest({
        repoRoot,
        ...input,
        draft: false,
        full: false,
      });
      expect(plan).toMatchObject({
        selection_mode: "full",
        runtime_core: true,
        test_shards: "[1,2,3,4,5,6,7,8]",
        docker_suite: true,
        defer_macos: false,
        build_smoke: true,
        compiler_hosts: fullPushPlan({ releaseHosts: input.baseRef === "main" })
          .compiler_hosts,
      });
    }
  });
  test("drafts keep Linux shards but suppress native jobs, even with ci:full", async () => {
    const plan = await planPullRequest({
      repoRoot,
      changed: [".github/workflows/ci.yml"],
      draft: true,
      full: true,
      selection: { mode: "full", reason: "fixture", files: [] },
    });
    expect(plan).toMatchObject({
      draft: true,
      compiler_hosts: "[]",
      runtime_core: false,
      test_shards: "[4,5,6,7,8]",
      suite: true,
      test_focus: "",
    });
  });
  test("only selected macOS files admit macOS unit jobs", async () => {
    const input = {
      repoRoot,
      changed: ["src/a.ts"],
      draft: false,
      full: false,
      mac: true,
    };
    const linux = await planPullRequest({
      ...input,
      selection: {
        mode: "selected",
        reason: "fixture",
        files: ["packages/db/tests/smoke.test.ts"],
      },
    });
    expect(JSON.parse(linux.test_shards)).toEqual([4, 5, 6, 7, 8]);
    const native = await planPullRequest({
      ...input,
      selection: {
        mode: "selected",
        reason: "fixture",
        files: ["tests/native-authored-project-start.test.ts"],
      },
    });
    expect(JSON.parse(native.test_shards)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  test("pushes retain every host and shard with no subset", () => {
    expect(fullPushPlan()).toMatchObject({
      scope: "full",
      draft: false,
      test_files: "",
      test_shards: "[1,2,3,4,5,6,7,8]",
      runtime_core: true,
      compiler_hosts: JSON.stringify(COMPILER_HOSTS),
    });
  });
  test("ordinary full runs defer Intel qualification to releases", () => {
    expect(
      JSON.parse(fullPushPlan({ releaseHosts: false }).compiler_hosts)
    ).toEqual(COMPILER_HOSTS.filter((host) => host.os !== "macos-15-intel"));
  });
  test("coarse full fallbacks also respect nonrelease compiler hosts", async () => {
    const plan = await planPullRequest({
      repoRoot,
      changed: ["other/rust-toolchain"],
      draft: false,
      full: false,
      releaseHosts: false,
      pullRequest: false,
      selection: { mode: "full", reason: "fixture", files: [] },
    });
    expect(JSON.parse(plan.compiler_hosts)).toEqual(
      COMPILER_HOSTS.filter((host) => host.os !== "macos-15-intel")
    );
  });
  test("empty PR diffs fail safe to full tiers", async () => {
    const plan = await planPullRequest({
      repoRoot,
      changed: [],
      draft: false,
      full: false,
      selection: { mode: "full", reason: "empty diff", files: [] },
    });
    expect(plan.runtime_core).toBe(true);
    expect(plan.compiler_hosts).toBe(
      fullPushPlan({ releaseHosts: false }).compiler_hosts
    );
    expect(plan.defer_macos).toBe(false);
    expect(plan.docker_suite).toBe(true);
  });
  test("candidate inputs include the compiler consumer dependency", () => {
    expect(touchesCandidate("packages/config-compiler/src/lib.rs")).toBe(true);
    expect(touchesCandidate("packages/runtime-core/src/main.rs")).toBe(true);
    expect(touchesCompilerHost("packages/config-compiler/src/lib.rs")).toBe(
      true
    );
    expect(touchesCompilerHost("packages/runtime-core/src/main.rs")).toBe(
      false
    );
    for (const path of ["mise.toml", ".github/workflows/ci.yml"]) {
      expect(touchesCandidate(path)).toBe(true);
      expect(touchesCompilerHost(path)).toBe(true);
    }
  });
  test("every declared local candidate crate dependency is an admitted input", async () => {
    const source = await Bun.file(
      resolve(repoRoot, "packages/runtime-core/Cargo.toml")
    ).text();
    const cargo: unknown = Bun.TOML.parse(source);
    const paths: string[] = [];
    function visit(value: unknown): void {
      if (!isRecord(value)) {
        return;
      }
      if (typeof value.path === "string" && value.path.startsWith("..")) {
        paths.push(
          relative(
            repoRoot,
            resolve(repoRoot, "packages/runtime-core", value.path)
          )
        );
      }
      for (const child of Object.values(value)) {
        visit(child);
      }
    }
    visit(cargo);
    expect(paths).toContain("packages/config-compiler");
    for (const path of paths) {
      expect(touchesCandidate(`${path}/Cargo.toml`), path).toBe(true);
    }
  });
  test("subset partition retains all selected files and rejects invalid selections", async () => {
    const all = discoverTestFiles({ repoRoot });
    const selected = [
      "tests/ci-test-selection.test.ts",
      "tests/native-authored-project-start.test.ts",
    ] as const;
    const pools = await classifyTestPools({ repoRoot, files: all });
    const linux = await buildVerifiedPlan({
      repoRoot,
      count: 5,
      pool: "linux",
      selectedFiles: selected,
    });
    const mac = await buildVerifiedPlan({
      repoRoot,
      count: 3,
      pool: "macos",
      selectedFiles: selected,
    });
    expect([...linux.shards.flat(), ...mac.shards.flat()].sort()).toEqual(
      [...selected].sort()
    );
    expect(pools.macos).toContain(selected[1]);
    await expect(
      buildVerifiedPlan({
        repoRoot,
        count: 5,
        selectedFiles: ["tests/missing.test.ts"],
      })
    ).rejects.toThrow("undiscovered");
    await expect(
      buildVerifiedPlan({
        repoRoot,
        count: 5,
        selectedFiles: [selected[0]!, selected[0]!],
      })
    ).rejects.toThrow("duplicate");
  });
});

test("draft fan-ins fail explicitly even when the light set passes or scope is cancelled", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(resolve(repoRoot, ".github/workflows/ci.yml")).text()
  ) as {
    on: { pull_request: { types: string[] } };
    jobs: Record<
      string,
      { steps: { name?: string; run?: string; env?: Record<string, string> }[] }
    >;
  };
  expect(workflow.on.pull_request.types).toEqual(
    expect.arrayContaining([
      "ready_for_review",
      "converted_to_draft",
      "labeled",
      "unlabeled",
    ])
  );
  for (const job of ["test", "docker-e2e"]) {
    const gate = workflow.jobs[job]?.steps.find((step) =>
      step.name?.startsWith("Reject failed")
    );
    expect(gate?.env?.PR_DRAFT).toContain("github.event.pull_request.draft");
    if (!gate?.run) {
      throw new Error("missing fan-in gate");
    }
    for (const changes of ["success", "cancelled", "failure"]) {
      const result = Bun.spawnSync(["bash", "-e", "-u", "-c", gate.run], {
        env: {
          ...process.env,
          PR_DRAFT: "true",
          CHANGES_RESULT: changes,
          SUITE: "true",
          SHARD_RESULT: "success",
          FOCUS_RESULT: "success",
          TEST_FOCUS: "",
          SCOPE: "full",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toContain("skipped: draft");
    }
  }
});
