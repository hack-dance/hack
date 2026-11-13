import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fullPushPlan } from "../scripts/ci-pr-plan.ts";
import { requiresWorkflowFull } from "../scripts/ci-workflow-guard.ts";
import { fixtureGitEnv, runFixtureGitSync } from "./helpers/fixture-git.ts";

const repository = resolve(import.meta.dir, "..");
const workflow = Bun.YAML.parse(
  await Bun.file(join(repository, ".github/workflows/ci.yml")).text()
) as {
  concurrency: { group: string; "cancel-in-progress": string };
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
  mac?: boolean;
  e2e?: boolean;
  bootstrap?: boolean;
  legacy?: boolean;
  tamper?: boolean;
  noMerge?: boolean;
  emptyDiff?: boolean;
  ref?: string;
  baseRef?: string;
  tierPlan?: boolean;
  before?: string;
  predecessor?: string;
  dispatchFull?: boolean;
  expectedExit?: number;
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
        CI_REF: opts.ref ?? "refs/pull/1/merge",
        DISPATCH_FULL: String(opts.dispatchFull ?? true),
        GITHUB_REPOSITORY: "fixture/repository",
        PR_DRAFT: String(opts.draft ?? false),
        PR_BASE_REF: opts.baseRef ?? "next",
        PR_FULL: String(opts.full ?? false),
        PR_MAC: String(opts.mac ?? false),
        PR_E2E: String(opts.e2e ?? false),
        RUNNER_TEMP: join(root, "runner"),
        GITHUB_WORKSPACE: root,
        GITHUB_OUTPUT: join(root, "outputs"),
        GITHUB_STEP_SUMMARY: join(root, "summary"),
      },
    });
    const git = (...args: string[]) => {
      const result = runFixtureGitSync({
        cwd: root,
        args,
        env,
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr);
      }
    };
    const put = async (path: string, source: string) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    };
    const tierPlan = opts.tierPlan
      ? ` await Bun.write(process.env.GITHUB_OUTPUT!, await Bun.file(process.env.GITHUB_OUTPUT!).text() + ${JSON.stringify(`compiler_hosts=${fullPushPlan({ releaseHosts: false }).compiler_hosts}\nruntime_core=true\ntest_shards=[1,2,3,4,5,6,7,8]\ndocker_suite=true\n`)});`
      : "";
    const policy = opts.legacy
      ? 'throw Error("legacy policy must not execute");'
      : `/* --base-revision= */ const root=process.argv.find(a=>a.startsWith("--repo-root="))?.slice(12); if(!root)throw Error("missing merge data"); await Bun.write(process.env.GITHUB_OUTPUT!, "policy=base\\ndata="+await Bun.file(root+"/src/value.ts").text()+"\\n");${tierPlan}`;
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
    const base = runFixtureGitSync({
      cwd: root,
      args: ["rev-parse", "HEAD"],
      env,
    }).stdout.trim();
    env.BEFORE_SHA = opts.before ?? base;
    git("checkout", "--quiet", "-b", "topic");
    if (!opts.emptyDiff) {
      await put(
        path,
        path === "scripts/ci-change-scope.ts"
          ? `${policy}\n// topic`
          : path.endsWith(".json")
            ? '{"topic":true}'
            : "topic"
      );
    }
    git("add", ".");
    git("commit", "--quiet", "--allow-empty", "-m", "topic");
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
    await put(
      "bin/gh",
      opts.predecessor === "error"
        ? "#!/bin/sh\nexit 1\n"
        : `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({ workflow_runs: opts.predecessor === "missing" ? [] : [{ head_sha: base, head_branch: "next", event: "push", path: ".github/workflows/ci.yml", status: opts.predecessor === "running" ? "in_progress" : "completed", conclusion: opts.predecessor ?? "success" }] })}\nEOF\n`
    );
    await chmod(join(root, "bin/gh"), 0o700);
    const result = Bun.spawnSync(["bash", "-c", script], {
      cwd: root,
      env: { ...env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(
      opts.expectedExit ?? 0
    );
    if (opts.expectedExit) {
      return {};
    }
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
    ci_evidence: "scoped",
    compiler_hosts: "[]",
    runtime_core: "false",
    test_shards: "[4,5,6,7,8]",
    defer_macos: "true",
    docker_suite: "false",
    build_smoke: "false",
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
  "packages/config-compiler/rust-toolchain.toml",
  "packages/runtime-core/Cargo.lock",
]) {
  test(`protected input ${path} automatically qualifies every ordinary PR tier`, async () => {
    const outputs = await scope({ path });
    expect(requiresWorkflowFull([path])).toBe(true);
    expect(outputs.selection_mode).toBe("full");
    expect(outputs.test_files).toBe("");
    expect(outputs.compiler_hosts).toBe(
      fullPushPlan({ releaseHosts: false }).compiler_hosts
    );
    expect(outputs.runtime_core).toBe("true");
    expect(outputs.test_shards).toBe("[1,2,3,4,5,6,7,8]");
    expect(outputs.docker_suite).toBe("true");
    expect(outputs.defer_macos).toBe("false");
    expect(outputs.build_smoke).toBe("true");
    expect(outputs.ci_evidence).toBe("scoped");
  });
}
test("bootstrap, pushes and ci:full never execute a PR selector", async () => {
  for (const options of [
    { bootstrap: true },
    { legacy: true },
    { event: "push" },
    { full: true },
    { noMerge: true },
    { emptyDiff: true },
  ]) {
    expect(await scope(options)).toEqual(
      Object.fromEntries(
        Object.entries({
          ...fullPushPlan({ releaseHosts: false }),
          ci_evidence: "scoped",
        }).map(([key, value]) => [key, String(value)])
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
test("ready PRs into main retain every tier and Intel without release evidence", async () => {
  expect(await scope({ baseRef: "main" })).toEqual(
    Object.fromEntries(
      Object.entries({ ...fullPushPlan(), ci_evidence: "scoped" }).map(
        ([key, value]) => [key, String(value)]
      )
    )
  );
  expect(await scope({ baseRef: "main", draft: true })).toMatchObject({
    compiler_hosts: "[]",
    runtime_core: "false",
    docker_suite: "false",
    build_smoke: "false",
    test_shards: "[4,5,6,7,8]",
    draft: "true",
    ci_evidence: "scoped",
  });
});
for (const path of [
  "packages/runtime-core/src/provider/setup.rs",
  "packages/relay-guest/src/main.rs",
  "packages/config-compiler/src/lib.rs",
  "packages/config-compiler/build.rs",
  "packages/runtime-core/provider-pins.json",
  "packages/config-compiler/tests/fixtures/schema-corpus.json",
  "packages/relay-guest/README.md",
]) {
  test(`light Rust input ${path} retains Linux checks without native Mac tiers`, async () => {
    const outputs = await scope({ path });
    expect(JSON.parse(outputs.compiler_hosts ?? "null")).toEqual(
      JSON.parse(fullPushPlan({ releaseHosts: false }).compiler_hosts).filter(
        (host: { platform: string }) => host.platform === "linux"
      )
    );
    expect(outputs).toMatchObject({
      runtime_core: "true",
      compiler_rust: "true",
      test_shards: "[4,5,6,7,8]",
      defer_macos: "true",
      docker_suite: "false",
      build_smoke: "false",
    });
    expect(await scope({ path, draft: true })).toMatchObject({
      runtime_core: "false",
      compiler_hosts: "[]",
      defer_macos: "true",
    });
    const mac = await scope({ path, tierPlan: true, mac: true });
    expect(
      JSON.parse(mac.compiler_hosts ?? "null")
        .map((host: { os: string }) => host.os)
        .sort()
    ).toEqual(
      JSON.parse(fullPushPlan({ releaseHosts: false }).compiler_hosts)
        .map((host: { os: string }) => host.os)
        .sort()
    );
    expect(mac.runtime_core).toBe("true");
    expect(mac.defer_macos).toBe("false");
  });
}
test("retargeting reclassifies through the ordinary pull_request event", () => {
  expect(workflow.on.pull_request.types).toContain("edited");
});

test("only next pushes share a cancelling group; main and dispatch remain unique", () => {
  expect(workflow.concurrency.group).toBe(
    "${{ github.workflow }}-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || (github.event_name == 'push' && github.ref == 'refs/heads/next' && 'push-next') || format('push-{0}', github.run_id) }}"
  );
  expect(workflow.concurrency["cancel-in-progress"]).toBe(
    "${{ github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/next') }}"
  );
});

test("next push runs trusted before policy only after a successful predecessor", async () => {
  expect(
    await scope({
      event: "push",
      ref: "refs/heads/next",
      noMerge: true,
      tamper: true,
    })
  ).toEqual({
    policy: "base",
    data: "topic",
    ci_evidence: "scoped",
    defer_macos: "false",
    build_smoke: "true",
  });
});

for (const predecessor of [
  "failure",
  "cancelled",
  "running",
  "missing",
  "error",
]) {
  test(`next cannot lose coverage after ${predecessor} predecessor`, async () => {
    expect(
      await scope({
        event: "push",
        ref: "refs/heads/next",
        predecessor,
        noMerge: true,
      })
    ).toMatchObject({
      selection_mode: "full",
      ci_evidence: "scoped",
      test_files: "",
    });
  });
}

for (const before of ["", "0".repeat(40), "f".repeat(40), "HEAD~1", "nope"]) {
  test(`unavailable next before ${before || "missing"} widens to full`, async () => {
    expect(
      await scope({ event: "push", ref: "refs/heads/next", before })
    ).toMatchObject({ selection_mode: "full", ci_evidence: "scoped" });
  });
}

test("main and explicit full dispatch retain all release hosts and certificate", async () => {
  for (const options of [
    { event: "push", ref: "refs/heads/main" },
    { event: "workflow_dispatch", ref: "refs/heads/next" },
  ]) {
    expect(await scope(options)).toEqual(
      Object.fromEntries(
        Object.entries({ ...fullPushPlan(), ci_evidence: "release-full" }).map(
          ([key, value]) => [key, String(value)]
        )
      )
    );
  }
});

test("manual qualification refuses full=false before launching a suite", async () => {
  expect(
    await scope({
      event: "workflow_dispatch",
      dispatchFull: false,
      expectedExit: 2,
    })
  ).toEqual({});
});

test("PR labels opt into independent tiers without widening the other tier", async () => {
  const input = { path: "src/value.ts", tierPlan: true };
  expect(await scope({ ...input, mac: true })).toMatchObject({
    compiler_hosts: fullPushPlan({ releaseHosts: false }).compiler_hosts,
    runtime_core: "true",
    test_shards: "[1,2,3,4,5,6,7,8]",
    docker_suite: "false",
    defer_macos: "false",
    build_smoke: "false",
  });
  expect(await scope({ ...input, e2e: true })).toMatchObject({
    compiler_hosts: "[]",
    runtime_core: "false",
    test_shards: "[4,5,6,7,8]",
    docker_suite: "true",
    defer_macos: "true",
    build_smoke: "false",
  });
  expect(await scope({ ...input, full: true })).toMatchObject({
    compiler_hosts: fullPushPlan({ releaseHosts: false }).compiler_hosts,
    runtime_core: "true",
    test_shards: "[1,2,3,4,5,6,7,8]",
    docker_suite: "true",
    defer_macos: "false",
    build_smoke: "true",
  });
  expect(
    await scope({ ...input, draft: true, full: true, mac: true, e2e: true })
  ).toMatchObject({
    compiler_hosts: "[]",
    runtime_core: "false",
    test_shards: "[4,5,6,7,8]",
    docker_suite: "false",
    defer_macos: "true",
    build_smoke: "false",
  });
});
