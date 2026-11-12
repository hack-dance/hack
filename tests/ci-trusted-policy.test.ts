import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fullPushPlan } from "../scripts/ci-pr-plan.ts";
import { requiresWorkflowFull } from "../scripts/ci-workflow-guard.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";

const repository = resolve(import.meta.dir, "..");
const workflow = Bun.YAML.parse(
  await Bun.file(join(repository, ".github/workflows/ci.yml")).text()
) as {
  on: { pull_request: { types: string[] } };
  jobs: { changes: { steps: { id?: string; run?: string }[] } };
};
const script =
  workflow.jobs.changes.steps.find((step) => step.id === "scope")?.run ?? "";
if (!script) {
  throw new Error("missing scope boundary");
}

async function scope(opts: {
  path?: string;
  draft?: boolean;
  event?: string;
  full?: boolean;
  bootstrap?: boolean;
  legacy?: boolean;
  tamper?: boolean;
  noMerge?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "trusted-ci-policy-"));
  try {
    const env = fixtureGitEnv({
      env: {
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        HACK_DAEMON_AUTOSTART_DISABLE: "1",
        HACK_NO_INTERACTIVE: "1",
        FIXTURE_BUN: process.execPath,
        EVENT_NAME: opts.event ?? "pull_request",
        PR_DRAFT: String(opts.draft ?? false),
        PR_FULL: String(opts.full ?? false),
        RUNNER_TEMP: join(root, "runner"),
        GITHUB_WORKSPACE: root,
        GITHUB_OUTPUT: join(root, "outputs"),
        GITHUB_STEP_SUMMARY: join(root, "summary"),
      },
    });
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString());
      }
    };
    const put = async (path: string, source: string) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    };
    const policy = opts.legacy
      ? 'throw Error("legacy policy must not execute");'
      : 'const root=process.argv.find(a=>a.startsWith("--repo-root="))?.slice(12); if(!root)throw Error("missing merge data"); await Bun.write(process.env.GITHUB_OUTPUT!, "policy=base\\ndata="+await Bun.file(root+"/src/value.ts").text());';
    const path = opts.path ?? "src/value.ts";
    await put(path, path.endsWith(".json") ? "{}" : "# base");
    await put("src/value.ts", "base");
    await put("package.json", '{"type":"module"}');
    if (!opts.bootstrap) {
      await put("scripts/ci-change-scope.ts", policy);
      await put("scripts/ci-pr-plan.ts", "export {};");
    }
    git("init", "--quiet", "--initial-branch=base");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("checkout", "--quiet", "-b", "topic");
    await put(
      path,
      path === "scripts/ci-change-scope.ts"
        ? `${policy}\n// topic`
        : path.endsWith(".json")
          ? '{"topic":true}'
          : "topic"
    );
    git("add", ".");
    git("commit", "--quiet", "-m", "topic");
    if (!opts.noMerge) {
      git("checkout", "--quiet", "base");
      git("merge", "--quiet", "--no-ff", "--no-edit", "topic");
    }
    if (opts.tamper) {
      await put(
        "scripts/ci-change-scope.ts",
        'throw Error("PR selector must never execute");'
      );
    }
    await mkdir(join(root, "runner"));
    await mkdir(join(root, "bin"));
    // No dependency install is needed for this fixture policy; still execute its real Bun code.
    await put(
      "bin/bun",
      '#!/bin/sh\n[ "$1" = "--no-env-file" ] && shift\nif [ "$1" = "install" ]; then exit 0; fi\nexec "$FIXTURE_BUN" --no-env-file "$@"\n'
    );
    await chmod(join(root, "bin/bun"), 0o700);
    const result = Bun.spawnSync(["bash", "-c", script], {
      cwd: root,
      env: { ...env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return Object.fromEntries(
      (await Bun.file(join(root, "outputs")).text())
        .trim()
        .split("\n")
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i), line.slice(i + 1)];
        })
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("trusted base policy executes against merge-tree data, not merge-tree code", async () => {
  expect(requiresWorkflowFull(["src/value.ts"])).toBe(false);
  expect(await scope({ tamper: true })).toEqual({
    policy: "base",
    data: "topic",
  });
});
for (const path of [
  "scripts/ci-test-selection.ts",
  "scripts/ci-change-scope.ts",
  "scripts/ci-pr-plan.ts",
  "scripts/test-shard-plan.ts",
  "scripts/test-shard-durations.json",
  ".github/workflows/other.yml",
  "bun.lock",
  "package.json",
  "packages/cli/package.json",
  "bunfig.toml",
  "packages/db/bunfig.toml",
  "tsconfig.json",
  "packages/db/tsconfig.json",
  "tests/preload.ts",
  "tests/helpers/preload-input.ts",
  "src/lib/guards.ts",
  "src/lib/cli-result.ts",
  "packages/config-compiler/Cargo.toml",
  "packages/runtime-core/Cargo.lock",
]) {
  test(`workflow independently forces every job for present protected input ${path}`, async () => {
    const outputs = await scope({ path });
    expect(requiresWorkflowFull([path])).toBe(true);
    expect(outputs.selection_mode).toBe("full");
    expect(outputs.test_files).toBe("");
    expect(JSON.parse(outputs.compiler_hosts ?? "null")).toEqual(
      JSON.parse(fullPushPlan().compiler_hosts)
    );
    expect(outputs.test_shards).toBe("[1,2,3,4,5,6,7,8]");
  });
}
test("bootstrap, pushes and ci:full never execute a PR selector", async () => {
  for (const options of [
    { bootstrap: true },
    { legacy: true },
    { event: "push" },
    { full: true },
    { noMerge: true },
  ]) {
    expect(await scope(options)).toEqual(
      Object.fromEntries(
        Object.entries(fullPushPlan()).map(([key, value]) => [
          key,
          String(value),
        ])
      )
    );
  }
});
test("independent full guard preserves the non-mergeable draft tier", async () => {
  expect(await scope({ path: "bun.lock", draft: true })).toMatchObject({
    scope: "full",
    draft: "true",
    compiler_hosts: "[]",
    runtime_core: "false",
    test_shards: "[4,5,6,7,8]",
    test_files: "",
  });
});
test("retargeting reclassifies through the ordinary pull_request event", () => {
  expect(workflow.on.pull_request.types).toContain("edited");
});
