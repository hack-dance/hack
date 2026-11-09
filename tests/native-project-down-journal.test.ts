import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProjectDown } from "../src/backends/native-project-down.ts";
import {
  createNativeForegroundDownHooks,
  loadNativeDownHookRecord,
  NATIVE_DOWN_HOOK_UNKNOWN,
  replaceNativeDownHookRecord,
} from "../src/backends/native-project-down-hooks.ts";
import { beginNativeProjectFinalization } from "../src/backends/native-project-finalization.ts";
import {
  type NativeProjectRunScope,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

// `hack down` honors the foreground stop's down-hook journal: owed phases run
// once, completed ones are skipped and unknown completion refuses.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const run = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
  effectiveEnvName: null,
  profiles: [],
  aws: null,
};
function snapshot(stopped: boolean) {
  return {
    receipt: {
      ...run,
      plan_id: run.planId,
      phase: stopped ? "stopped-data-retained" : "ready-observed",
      resources: {
        "container:web": {
          kind: "container",
          key: "web",
          id: "e".repeat(64),
          phase: "started",
        },
      },
    },
    journal_incomplete: false,
    observations: {
      "container:web": { state: stopped ? "absent" : "running" },
    },
  };
}
async function fixture(): Promise<{
  readonly scope: NativeProjectRunScope;
  readonly runtime: { readonly binary: string; readonly home: string };
}> {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-down-journal-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack"),
    nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir);
  await mkdir(nativeHome, { mode: 0o700 });
  const scope = { projectRoot, projectDir, nativeHome, branch: null };
  await saveNativeProjectRun({ ...scope, run });
  const finalization = await beginNativeProjectFinalization({ scope, run });
  await finalization.complete();
  return { scope, runtime: { binary: "/not-invoked", home: nativeHome } };
}
function recorder(stopped: boolean) {
  const calls: string[] = [];
  let cleaned = stopped;
  return {
    calls,
    hooks: {
      configured: true,
      run: async (phase: { phase: string; graphStopped: boolean }) => {
        calls.push(`${phase.phase}${phase.graphStopped ? ":stopped" : ""}`);
      },
    },
    retireHostProcesses: async () => {
      calls.push("retire-host");
    },
    invoke: async (request: { readonly args: readonly string[] }) => {
      calls.push(request.args[1] ?? "");
      if (request.args[1] === "cleanup") {
        cleaned = true;
        return {};
      }
      return snapshot(cleaned);
    },
  };
}

test("down on a stopped graph runs hooks owed by a crashed frontend once, after finalization", async () => {
  const opts = await fixture();
  await createNativeForegroundDownHooks({
    scope: opts.scope,
    run: run.run,
  }).owe(() => false);
  const first = recorder(true);
  expect((await nativeProjectDown({ ...opts, ...first })).status).toBe(
    "stopped"
  );
  expect(first.calls).toEqual([
    "inspect",
    "retire-host",
    "before:stopped",
    "after:stopped",
  ]);
  const second = recorder(true);
  await nativeProjectDown({ ...opts, ...second });
  expect(second.calls).toEqual(["inspect", "retire-host"]);
});

test("down on a stopped graph refuses unknown hook completion without replaying it", async () => {
  const opts = await fixture();
  await replaceNativeDownHookRecord(opts.scope, null, {
    run: run.run,
    generation: "f".repeat(32),
    state: "before-started",
  });
  const recorded = recorder(true);
  await expect(nativeProjectDown({ ...opts, ...recorded })).rejects.toThrow(
    NATIVE_DOWN_HOOK_UNKNOWN
  );
  expect(recorded.calls).not.toContain("before:stopped");
  expect((await loadNativeDownHookRecord(opts.scope))?.state).toBe(
    "before-started"
  );
});

test("down on a live graph refuses unknown completion before hooks or cleanup", async () => {
  const opts = await fixture();
  await replaceNativeDownHookRecord(opts.scope, null, {
    run: run.run,
    generation: "f".repeat(32),
    state: "after-started",
  });
  const recorded = recorder(false);
  await expect(nativeProjectDown({ ...opts, ...recorded })).rejects.toThrow(
    NATIVE_DOWN_HOOK_UNKNOWN
  );
  expect(recorded.calls).toEqual(["inspect"]);
});

test("down on a live graph skips a down.before the frontend already completed", async () => {
  const opts = await fixture();
  const frontend = createNativeForegroundDownHooks({
    scope: opts.scope,
    run: run.run,
  });
  await frontend.owe(() => false);
  await frontend.before(
    async () => 0,
    () => false
  );
  const recorded = recorder(false);
  await nativeProjectDown({ ...opts, ...recorded });
  expect(recorded.calls).toEqual([
    "inspect",
    "inspect",
    "cleanup",
    "inspect",
    "retire-host",
    // down.after always follows confirmed cleanup.
    "after:stopped",
  ]);
  expect((await loadNativeDownHookRecord(opts.scope))?.state).toBe("complete");
});

test("hack down runs a crashed frontend's owed hooks once through the real CLI", async () => {
  const opts = await fixture();
  await writeFile(
    join(opts.scope.projectDir, "hack.config.json"),
    JSON.stringify({
      name: "fixture",
      lifecycle: {
        down: {
          before: ["echo synthetic-down-before"],
          after: ["echo synthetic-down-after"],
        },
      },
    })
  );
  await writeFile(
    join(opts.scope.projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: fixture\n"
  );
  const binary = join(opts.scope.projectRoot, "fake-native");
  await writeFile(
    binary,
    `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(snapshot(true)))})`,
    { mode: 0o700 }
  );
  await createNativeForegroundDownHooks({
    scope: opts.scope,
    run: run.run,
  }).owe(() => false);
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-down-journal-client-"))
  );
  roots.push(root);
  const down = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "index.ts",
        "down",
        "--json",
        "--path",
        opts.scope.projectRoot,
      ],
      {
        env: privateCliEnv({
          root,
          env: {
            HACK_RUNTIME_BACKEND: "native",
            HACK_NATIVE_HOME: opts.scope.nativeHome,
            HACK_NATIVE_BINARY: binary,
          },
        }),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    } finally {
      clearTimeout(timer);
    }
  };
  const first = await down();
  expect(first.code).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ status: "stopped" });
  expect(first.stderr).toContain("synthetic-down-before");
  expect(first.stderr).toContain("synthetic-down-after");
  const second = await down();
  expect(second.code).toBe(0);
  expect(second.stderr).not.toContain("synthetic-down-before");
  expect(second.stderr).not.toContain("synthetic-down-after");
}, 40_000);
