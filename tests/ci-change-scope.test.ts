import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type ChangeScope,
  COMPILER_HOSTS,
  changeScope,
  pathKind,
  planScope,
  pullRequestPaths,
  scopeOutputs,
  touchesDocsSite,
} from "../scripts/ci-change-scope.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";

const repoRoot = resolve(import.meta.dir, "..");
const owned: string[] = [];

afterAll(async () => {
  await Promise.all(
    owned.map((path) => rm(path, { recursive: true, force: true }))
  );
});

type Workflow = {
  readonly jobs: Record<
    string,
    {
      readonly name?: string;
      readonly needs?: string | readonly string[];
      readonly if?: string;
      readonly outputs?: Record<string, string>;
      readonly strategy?: {
        readonly matrix?: { readonly include?: unknown };
      };
      readonly steps?: readonly {
        readonly name?: string;
        readonly if?: string;
        readonly run?: string;
        readonly with?: Record<string, unknown>;
      }[];
    }
  >;
};

async function ciWorkflow(): Promise<Workflow> {
  return Bun.YAML.parse(
    await Bun.file(resolve(repoRoot, ".github/workflows/ci.yml")).text()
  ) as Workflow;
}

describe("change scope classification", () => {
  test("classifies paths by what can read them", () => {
    for (const [path, kind] of [
      ["docs/guides/prereleases.md", "docs"],
      ["site/app/page.tsx", "docs"],
      ["site/package.json", "docs"],
      // The docs site tooling is read only by the docs site job.
      ["scripts/docs/prepare.ts", "docs"],
      ["scripts/docs/versions.json", "docs"],
      ["scripts/docs.ts", "typescript"],
      ["scripts/build-release.ts", "typescript"],
      ["README.md", "docs"],
      ["LICENSE", "docs"],
      ["packages/runtime-core/src/main.rs", "runtime-core"],
      ["packages/relay-guest/src/main.zig", "runtime-core"],
      ["scripts/build-hack-local.sh", "runtime-core"],
      // The checkout launcher: local_contract.rs copies it, CI runs it.
      ["hack-local", "runtime-core"],
      [".hack-local/target/x", "typescript"],
      ["packages/config-compiler/src/lib.rs", "rust"],
      ["packages/runtime-core/Cargo.lock", "runtime-core"],
      ["Cargo.toml", "rust"],
      ["mise.toml", "rust"],
      [".github/workflows/ci.yml", "rust"],
      ["scripts/build-config-compiler.ts", "rust"],
      ["src/commands/project.ts", "typescript"],
      ["tests/e2e/shard.ts", "typescript"],
      ["package.json", "typescript"],
      ["bun.lock", "typescript"],
      // Agent guidance and nested docs feed generators and tests.
      ["AGENTS.md", "typescript"],
      ["plugins/hack/README.md", "typescript"],
      ["skills/hack-cli/SKILL.md", "typescript"],
      ["packages/cli/README.md", "typescript"],
      ["docs", "typescript"],
    ] as const) {
      expect(pathKind(path), path).toBe(kind);
    }
  });

  test("derives the narrowest safe scope", () => {
    for (const [paths, scope] of [
      [[], "full"],
      [["docs/a.md", "README.md"], "docs"],
      [["scripts/docs/smoke.ts", "site/app/global.css", "docs/a.md"], "docs"],
      [["scripts/docs/smoke.ts", "scripts/test-shard.ts"], "typescript"],
      [["packages/runtime-core/src/a.rs"], "runtime-core"],
      [["packages/runtime-core/src/a.rs", "docs/a.md"], "runtime-core"],
      [["src/a.ts", "tests/a.test.ts", "docs/a.md"], "typescript"],
      [["src/a.ts", "packages/runtime-core/src/a.rs"], "code"],
      [["src/a.ts", "hack-local"], "code"],
      [["packages/config-compiler/src/a.rs"], "code"],
      [["docs/a.md", ".github/workflows/ci.yml"], "code"],
    ] as const) {
      expect(changeScope(paths), paths.join(",")).toBe(scope as ChangeScope);
    }
  });

  test("only full scope runs every compiler host; every scope pools the shards", () => {
    const full = scopeOutputs("full");
    expect(JSON.parse(full.compiler_hosts)).toEqual(COMPILER_HOSTS);
    expect(full).toMatchObject({
      compiler_rust: true,
      runtime_core: true,
      suite: true,
      test_layout: "pooled",
      test_focus: "",
    });
    expect(COMPILER_HOSTS.map((host) => host.os)).toEqual([
      "ubuntu-latest",
      "macos-latest",
      "ubuntu-24.04-arm",
      "macos-15-intel",
    ]);
    const linux = [{ os: "ubuntu-latest", platform: "linux", arch: "x64" }];
    expect(scopeOutputs("code")).toMatchObject({
      compiler_rust: true,
      runtime_core: true,
      suite: true,
      test_layout: "pooled",
      test_focus: "",
    });
    expect(JSON.parse(scopeOutputs("code").compiler_hosts)).toEqual(linux);
    expect(scopeOutputs("typescript")).toMatchObject({
      compiler_rust: false,
      runtime_core: false,
      suite: true,
      test_layout: "pooled",
    });
    expect(JSON.parse(scopeOutputs("typescript").compiler_hosts)).toEqual(
      linux
    );
    for (const scope of ["docs", "runtime-core"] as const) {
      const outputs = scopeOutputs(scope);
      expect(outputs.compiler_hosts).toBe("[]");
      expect(outputs.suite).toBe(false);
      // A scope without the suite always has a focus to gate on.
      expect(outputs.test_focus).not.toBe("");
    }
    expect(scopeOutputs("runtime-core").runtime_core).toBe(true);
    expect(scopeOutputs("docs").runtime_core).toBe(false);
  });

  test("the docs site job follows its own inputs, whatever the scope", () => {
    for (const [path, expected] of [
      ["docs/guides/prereleases.md", true],
      ["docs/versions/v5/install.md", true],
      ["site/app/page.tsx", true],
      ["scripts/docs/prepare.ts", true],
      [".github/workflows/ci.yml", true],
      // Root documents are not published by the site.
      ["README.md", false],
      ["scripts/docs-other.ts", false],
      [".github/workflows/release.yml", false],
      ["src/commands/project.ts", false],
      ["docs", false],
    ] as const) {
      expect(touchesDocsSite(path), path).toBe(expected);
    }
    // Pushes and an unavailable diff are `full` and always build the site.
    expect(scopeOutputs("full").docs_site).toBe(true);
    expect(planScope([]).docs_site).toBe(true);
    expect(planScope(["docs/a.md"])).toMatchObject({
      scope: "docs",
      docs_site: true,
    });
    expect(planScope(["README.md"])).toMatchObject({
      scope: "docs",
      docs_site: false,
    });
    expect(planScope(["src/a.ts", "site/app/page.tsx"])).toMatchObject({
      scope: "typescript",
      docs_site: true,
    });
    expect(
      planScope(["packages/runtime-core/src/a.rs", "docs/a.md"])
    ).toMatchObject({ test_focus: "docs,runtime-core", docs_site: true });
    expect(planScope(["src/a.ts"]).docs_site).toBe(false);
    expect(planScope(["packages/runtime-core/src/a.rs"]).docs_site).toBe(false);
  });

  test("a runtime-core change with docs focuses on both sets of tests", () => {
    expect(planScope(["packages/runtime-core/src/a.rs"]).test_focus).toBe(
      "runtime-core"
    );
    expect(
      planScope(["packages/runtime-core/src/a.rs", "docs/a.md"]).test_focus
    ).toBe("docs,runtime-core");
    expect(planScope(["docs/a.md"]).test_focus).toBe("docs");
  });
});

describe("pull request diff", () => {
  function git(cwd: string, args: readonly string[]): string {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env: fixtureGitEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    }
    return result.stdout.toString().trim();
  }

  async function commitFile(root: string, path: string): Promise<void> {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), `${path}\n`);
    git(root, ["add", "--", path]);
    git(root, ["commit", "--quiet", "--message", path]);
  }

  test("reads what a merge commit changes against its first parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-ci-change-scope-"));
    owned.push(root);
    git(root, ["init", "--quiet", "--initial-branch=base"]);
    await commitFile(root, "src/base.ts");
    git(root, ["checkout", "--quiet", "-b", "topic"]);
    await commitFile(root, "docs/topic.md");
    git(root, ["checkout", "--quiet", "base"]);
    // A base-only change must not count as the pull request's change.
    await commitFile(root, "src/later-on-base.ts");
    // Not a merge commit yet: the diff is unavailable, so the scope is full.
    expect(pullRequestPaths(root)).toBeNull();
    git(root, ["merge", "--quiet", "--no-ff", "--no-edit", "topic"]);
    expect(pullRequestPaths(root)).toEqual(["docs/topic.md"]);
    expect(changeScope(pullRequestPaths(root) ?? [])).toBe("docs");
  });

  test("the CLI requires an event and reports full scope outside pull requests", () => {
    const script = resolve(repoRoot, "scripts/ci-change-scope.ts");
    const missing = Bun.spawnSync([process.execPath, script], {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(missing.exitCode).toBe(2);
    const push = Bun.spawnSync([process.execPath, script, "--event=push"], {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(push.exitCode).toBe(0);
    expect(push.stdout.toString()).toContain("scope=full\n");
    expect(push.stdout.toString()).toContain("test_layout=pooled\n");
  });
});

describe("CI workflow wiring", () => {
  test("the changes job exposes every scope output and checks out the merge parent", async () => {
    const changes = (await ciWorkflow()).jobs.changes;
    const keys = Object.keys(scopeOutputs("full")).sort();
    expect(Object.keys(changes?.outputs ?? {}).sort()).toEqual(keys);
    for (const key of keys) {
      expect(changes?.outputs?.[key]).toBe(
        `\${{ steps.scope.outputs.${key} }}`
      );
    }
    const checkout = changes?.steps?.find((step) =>
      String((step as { uses?: string }).uses).startsWith("actions/checkout")
    );
    expect(checkout?.with?.["fetch-depth"]).toBe(2);
    expect(changes?.steps?.at(-1)?.run).toBe(
      'bun scripts/ci-change-scope.ts --event="$EVENT_NAME"'
    );
  });

  test("scoped jobs follow the change scope outputs", async () => {
    const jobs = (await ciWorkflow()).jobs;
    expect(jobs["config-compiler"]?.if).toBe(
      "${{ needs.changes.outputs.compiler_hosts != '[]' }}"
    );
    expect(jobs["config-compiler"]?.strategy?.matrix?.include).toBe(
      "${{ fromJSON(needs.changes.outputs.compiler_hosts) }}"
    );
    expect(
      jobs["config-compiler"]?.steps?.find(
        (step) => step.name === "Check and test the compiler crate"
      )?.if
    ).toBe("${{ needs.changes.outputs.compiler_rust == 'true' }}");
    expect(jobs["runtime-core"]?.if).toBe(
      "${{ needs.changes.outputs.runtime_core == 'true' }}"
    );
    for (const name of [
      "runtime-images",
      "docker-e2e-shard",
      "test-shard",
      "linux-process-lifetime",
    ]) {
      expect(jobs[name]?.needs, name).toBe("changes");
      expect(jobs[name]?.if, name).toBe(
        "${{ needs.changes.outputs.suite == 'true' }}"
      );
    }
    // `docs site` is a required check: the job always runs, and every step
    // after the scope report is gated, so it passes as a no-op when unneeded.
    expect(jobs["docs-site"]?.needs).toBe("changes");
    expect(jobs["docs-site"]?.if).toBe("${{ always() }}");
    const docsSteps = jobs["docs-site"]?.steps ?? [];
    expect(docsSteps[0]?.name).toBe("Report scope");
    expect(docsSteps[0]?.if).toBeUndefined();
    // A failed scope fails the check; only a cancelled one is a no-op.
    expect(docsSteps[0]?.run).toContain(
      'if [ "$CHANGES_RESULT" != "success" ]; then'
    );
    expect(docsSteps[0]?.run).toContain("exit 1");
    expect(docsSteps.length).toBeGreaterThan(5);
    for (const step of docsSteps.slice(1)) {
      expect(step.if, step.name ?? step.run).toBe(
        "${{ needs.changes.outputs.docs_site == 'true' }}"
      );
    }
    // Jobs that do not depend on the scope keep running on every event.
    for (const name of ["state-models", "secret-scan"]) {
      expect(jobs[name]?.needs, name).toBeUndefined();
      expect(jobs[name]?.if, name).toBeUndefined();
    }
  });
});
