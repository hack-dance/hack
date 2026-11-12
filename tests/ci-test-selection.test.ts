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
  test("the actual repository graph can select a proper subset", () => {
    const result = selectTests({
      repoRoot,
      changed: ["docs/reference/ci-test-selection.md"],
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
      changed: ["src/lib/cli-result.ts"],
      draft: false,
      full: false,
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
  test("empty PR diffs preserve the full native job fallback", async () => {
    const plan = await planPullRequest({
      repoRoot,
      changed: [],
      draft: false,
      full: false,
      selection: { mode: "full", reason: "empty diff", files: [] },
    });
    expect(plan.runtime_core).toBe(true);
    expect(JSON.parse(plan.compiler_hosts)).toEqual(COMPILER_HOSTS);
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
