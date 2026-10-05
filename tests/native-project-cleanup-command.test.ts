import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectNativeProjectCleanup } from "../src/backends/native-project-cleanup-command.ts";
import { saveNativeProjectRun } from "../src/backends/native-project-run.ts";

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
};
async function fixture() {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-cleanup-doctor-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack"),
    nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir);
  await mkdir(nativeHome, { mode: 0o700 });
  await Bun.write(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "cleanup-fixture" })
  );
  await Bun.write(join(projectDir, "docker-compose.yml"), "services: {}\n");
  const scope = { projectRoot, projectDir, nativeHome, branch: "feature-api" };
  await saveNativeProjectRun({ ...scope, run });
  return {
    scope,
    runtime: { home: nativeHome, binary: join(projectRoot, "native") },
  };
}
function snapshot() {
  return {
    receipt: {
      ...run,
      plan_id: run.planId,
      phase: "cleanup-intent",
      relay_cleanup: { phase: "pending" },
      resources: {
        "container:web": { kind: "container", key: "web", phase: "started" },
        "container:ws": { kind: "container", key: "ws", phase: "started" },
        "volume:data": { kind: "volume", key: "data", phase: "created" },
      },
    },
    journal_incomplete: false,
    interrupted_start_cleanup_incomplete: false,
    pending_cleanup: { version: 1, kind: "partial_shutdown" },
    observations: {
      "container:web": { state: "exited", code: 0 },
      "container:ws": { state: "running", health: "healthy" },
      "volume:data": { state: "present" },
    },
    synthetic_private_value: "synthetic-private-canary",
  };
}

test("cleanup doctor inspects one mapped branch without requesting recovery and omits peer values", async () => {
  const opts = await fixture(),
    calls: string[][] = [];
  const result = await inspectNativeProjectCleanup({
    ...opts,
    invoke: async ({ args }) => {
      calls.push([...args]);
      return snapshot();
    },
  });
  expect(result).toMatchObject({
    state: "partial_shutdown",
    pending: true,
    run: run.run,
    counts: {
      running: 1,
      exited: 1,
      created: 0,
      absent: 0,
      volumesPresent: 1,
      volumesAbsent: 0,
    },
  });
  expect(result.guidance).toContain("review every graph sharing the pool");
  expect(calls).toEqual([["graph", "inspect", "--run-id", run.run, "--json"]]);
  expect(JSON.stringify(result)).not.toContain("synthetic-private-canary");
  expect(JSON.stringify(result)).not.toContain(opts.scope.projectRoot);
});

test("legacy hints and missing volumes report observations without inventing recovery authority", async () => {
  const opts = await fixture();
  const legacy = snapshot();
  Reflect.deleteProperty(legacy, "pending_cleanup");
  legacy.observations["volume:data"].state = "absent";
  const result = await inspectNativeProjectCleanup({
    ...opts,
    invoke: async () => legacy,
  });
  expect(result).toMatchObject({
    state: "unclassified",
    pending: true,
    counts: { volumesAbsent: 1, volumesPresent: 0 },
  });
  expect(result.guidance).toContain("explicit owned recovery");
});

test("foreign, incomplete and malformed graph observations refuse without raw values or mutations", async () => {
  const opts = await fixture();
  for (const fault of [
    "owner",
    "run",
    "namespace",
    "plan",
    "journal",
    "observation",
  ]) {
    const value = snapshot();
    if (fault === "owner") {
      value.receipt.owner = "changed";
    }
    if (fault === "run") {
      value.receipt.run = "changed";
    }
    if (fault === "namespace") {
      value.receipt.namespace = "changed";
    }
    if (fault === "plan") {
      value.receipt.plan_id = "changed";
    }
    if (fault === "journal") {
      value.journal_incomplete = true;
    }
    if (fault === "observation") {
      value.observations["container:ws"].state = "synthetic-private-canary";
    }
    let calls = 0;
    const failure = await inspectNativeProjectCleanup({
      ...opts,
      invoke: async () => {
        calls++;
        return value;
      },
    }).catch((error: unknown) => error);
    expect(String(failure)).toContain("inspection is unconfirmed");
    expect(Bun.inspect(failure)).not.toContain("synthetic-private-canary");
    expect(calls).toBe(1);
  }
});

test("source CLI selects cleanup doctor with an explicit branch and refuses repair mixtures", async () => {
  const opts = await fixture();
  await Bun.write(
    join(opts.scope.projectRoot, "snapshot.json"),
    JSON.stringify(snapshot())
  );
  await Bun.write(
    opts.runtime.binary,
    `#!${process.execPath}
import {appendFileSync} from "node:fs";
appendFileSync("attempts", JSON.stringify(process.argv.slice(2))+"\\n");
console.log(await Bun.file("snapshot.json").text());
`
  );
  await chmod(opts.runtime.binary, 0o700);
  const invoke = async (extra: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "index.ts",
        "doctor",
        "--native-cleanup",
        "inspect",
        "--path",
        opts.scope.projectRoot,
        "--branch",
        "feature-api",
        "--json",
        ...extra,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: opts.scope.projectRoot,
          HACK_RUNTIME_BACKEND: "native",
          HACK_NATIVE_BINARY: opts.runtime.binary,
          HACK_NATIVE_HOME: opts.runtime.home,
          HACK_NO_INTERACTIVE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  const result = await invoke([]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { state: "partial_shutdown", pending: true },
  });
  const calls = await Bun.file(join(opts.scope.projectRoot, "attempts")).text();
  expect(calls.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(calls.trim())).toEqual([
    "--candidate-root",
    opts.runtime.home,
    "graph",
    "inspect",
    "--run-id",
    run.run,
    "--json",
  ]);
  for (const extra of [
    ["--fix"],
    ["--domain-migration", "apply"],
    ["--native-run-mapping", "inspect"],
    ["--expect-selection", "e".repeat(64)],
  ]) {
    const refused = await invoke(extra);
    expect(refused.code).toBe(1);
    expect(refused.stdout + refused.stderr).toContain(
      "recovery is explicit and separate"
    );
  }
  expect(await Bun.file(join(opts.scope.projectRoot, "attempts")).text()).toBe(
    calls
  );
});
