import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeAuthoredReceipt } from "../src/backends/native-authored-graph-protocol.ts";
import {
  nativeAuthoredProjectLogs,
  parseNativeAuthoredLogs,
} from "../src/backends/native-authored-project-logs.ts";
import {
  nativeAuthoredProjectNamespace,
  saveNativeAuthoredProjectRun,
} from "../src/backends/native-authored-project-run.ts";
import { invokeNativeRuntime } from "../src/backends/native-runtime-client.ts";
import { tryNativeAuthoredCommand } from "../src/lib/native-authored-command.ts";
import type { NativeComposeCommandOptions } from "../src/lib/native-compose-command.ts";

const roots: string[] = [];
let uncertain = false;
afterEach(async () => {
  if (!uncertain) {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  }
});
async function fixture(saved = true) {
  if (uncertain) {
    throw new Error(
      "Prior synthetic lifetime is unconfirmed; evidence retained."
    );
  }
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-authored-logs-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack"),
    nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir, { mode: 0o700 });
  await mkdir(nativeHome, { mode: 0o700 });
  const scope = { projectRoot, projectDir, nativeHome, branch: null };
  const provenance = {
    version: 1,
    kind: "native",
    namespace: nativeAuthoredProjectNamespace(scope),
    run: "a".repeat(32),
    input: {
      semantic_hash: "b".repeat(64),
      local_resolution_hash: "c".repeat(64),
      environment_policy_hash: "d".repeat(64),
      selected_profiles: [],
    },
  };
  const review = {
    provenance,
    review_id: createHash("sha256")
      .update("hack.native-graph-review/v1\0")
      .update(JSON.stringify(provenance))
      .digest("hex"),
  };
  const receipt = parseNativeAuthoredReceipt({
    version: 2,
    kind: "native-graph-runtime",
    owner: "e".repeat(32),
    boot: "00000000-0000-0000-0000-000000000001",
    review,
    phase: "ready-observed",
    readiness: { web: "healthy" },
    resources: {
      "network:default": {
        kind: "network",
        key: "default",
        name: `hkn-${provenance.run}-network-0`,
        id: "1".repeat(64),
        image: null,
        phase: "created",
        outbound: true,
      },
      "container:web": {
        kind: "container",
        key: "web",
        name: `hkn-${provenance.run}-container-0`,
        id: "2".repeat(64),
        image: `sha256:${"3".repeat(64)}`,
        phase: "started",
        networks: ["default"],
      },
    },
  });
  if (saved) {
    await saveNativeAuthoredProjectRun({
      ...scope,
      record: { version: 2, kind: "native-authored-project-run", receipt },
    });
  }
  const reply = {
    version: 2,
    kind: "native-graph-control-reply",
    run: provenance.run,
    review: review.review_id,
    result: {
      outcome: "logs",
      logs: {
        receipt,
        service: "web",
        container: "2".repeat(64),
        stdout: "literal stdout\n",
        stderr: "literal stderr\n",
        truncated: true,
      },
    },
  };
  const runtime = { binary: join(nativeHome, "native"), home: nativeHome };
  await Bun.write(
    runtime.binary,
    `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(reply))});\n`
  );
  await chmod(runtime.binary, 0o700);
  const mapping = join(
    projectDir,
    ".internal/native-authored-runs",
    `${createHash("sha256").update("null").digest("hex")}.json`
  );
  const args = [
    "graph",
    "native",
    "logs",
    "--run-id",
    provenance.run,
    "--service",
    "web",
    "--tail",
    "17",
    "--json",
  ];
  return { scope, runtime, receipt, reply, mapping, args };
}
test("finite authored logs invoke the exact live-owner argv and preserve both bounded streams", async () => {
  const f = await fixture();
  let calls = 0;
  const result = await nativeAuthoredProjectLogs({
    ...f,
    service: "web",
    tail: 17,
    invoke: async (input) => {
      calls++;
      expect(input.args).toEqual(f.args);
      expect(input.boundNativeAuthoredLogsDrain).toBe(true);
      expect(input.privateInput).toBeUndefined();
      expect(input.timeoutMs).toBe(15_000);
      return f.reply;
    },
  });
  expect(calls).toBe(1);
  expect(result).toEqual({
    backend: "native",
    run: "a".repeat(32),
    service: "web",
    container: "2".repeat(64),
    stdout: "literal stdout\n",
    stderr: "literal stderr\n",
    truncated: true,
  });
  expect(
    await nativeAuthoredProjectLogs({ ...f, service: "web", tail: 17 })
  ).toEqual(result);
});
test.each([
  "absent",
  "foreign",
  "canceled",
])("%s selection invokes nothing", async (kind) => {
  const f = await fixture(kind !== "absent");
  let calls = 0;
  const controller = new AbortController();
  if (kind === "canceled") {
    controller.abort();
  }
  await expect(
    nativeAuthoredProjectLogs({
      ...f,
      service: kind === "foreign" ? "other" : "web",
      signal: controller.signal,
      invoke: async () => {
        calls++;
        return f.reply;
      },
    })
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
test.each([
  "mapping",
  "executable",
])("%s replacement while reading withholds output", async (kind) => {
  const f = await fixture();
  await expect(
    nativeAuthoredProjectLogs({
      ...f,
      service: "web",
      invoke: async () => {
        const path = kind === "mapping" ? f.mapping : f.runtime.binary;
        const bytes = await readFile(path);
        await rename(path, `${path}.old`);
        await Bun.write(path, bytes);
        if (kind === "executable") {
          await chmod(path, 0o700);
        }
        return f.reply;
      },
    })
  ).rejects.toThrow();
});
test.each([
  "container",
  "service",
  "owner",
  "run",
  "review",
  "extra",
  "overflow",
  "legacy",
])("reply %s cannot substitute log authority", async (kind) => {
  const f = await fixture();
  const value = structuredClone(f.reply);
  if (kind === "container") {
    value.result.logs.container = "f".repeat(64);
  }
  if (kind === "service") {
    value.result.logs.service = "other";
  }
  if (kind === "owner") {
    value.result.logs.receipt.owner = "f".repeat(32);
  }
  if (kind === "run") {
    value.run = "f".repeat(32);
  }
  if (kind === "review") {
    value.review = "f".repeat(64);
  }
  if (kind === "overflow") {
    value.result.logs.stdout = "x".repeat(16_385);
  }
  if (kind === "legacy") {
    value.kind = "graph-control-reply";
  }
  const decoded: unknown = kind === "extra" ? { ...value, extra: true } : value;
  expect(() => parseNativeAuthoredLogs(decoded, f.receipt, "web")).toThrow();
});
const unsupported: readonly Partial<NativeComposeCommandOptions>[] = [
  { follow: true },
  { follow: undefined },
  { service: undefined },
  { service: "../web" },
  { tail: 0 },
  { tail: 1001 },
  { tail: 1.5 },
  { profiles: [] },
  { overlay: null },
  { services: [] },
  { command: [] },
  { workdir: "/" },
  { logFormat: "pretty" },
  { recover: true },
  { detach: true },
  { unsupportedOptions: true },
];
test.each([
  ...unsupported,
])("unsupported logs %j refuse before runtime or input", async (options) => {
  let calls = 0;
  await expect(
    tryNativeAuthoredCommand({
      selected: { kind: "native", projectRoot: "/absent-authored-logs" },
      options: {
        cwd: "/absent-authored-logs",
        operation: "logs",
        service: "web",
        follow: false,
        ...options,
      },
      env: {
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: "/absent-native",
        HACK_NATIVE_HOME: "/absent-home",
      },
      logs: async () => {
        calls++;
        throw new Error("must not run");
      },
    })
  ).rejects.toMatchObject({ code: "E_NATIVE_PROJECT_UNSUPPORTED" });
  expect(calls).toBe(0);
});
test("logs drain domain refuses mutations, follow, private input and noncanonical tail before spawn", async () => {
  const f = await fixture();
  for (const args of [
    f.args.slice(0, -1),
    [...f.args, "--follow"],
    f.args.map((value) => (value === "logs" ? "cleanup" : value)),
    f.args.map((value) => (value === "17" ? "017" : value)),
  ]) {
    await expect(
      invokeNativeRuntime({
        runtime: { binary: "/absent-native", home: "/absent-home" },
        cwd: "/absent-home",
        args,
        boundNativeAuthoredLogsDrain: true,
      })
    ).rejects.toThrow("budget");
  }
  await expect(
    invokeNativeRuntime({
      ...f,
      cwd: f.scope.projectRoot,
      args: f.args,
      privateInput: new Uint8Array([1]),
      boundNativeAuthoredLogsDrain: true,
    })
  ).rejects.toThrow("budget");
});
test("logs cancellation settles its read child and returns no captured bytes", async () => {
  const f = await fixture();
  await Bun.write(
    f.runtime.binary,
    `#!${process.execPath}\nconsole.log('private-log-canary'); await Bun.sleep(60000);\n`
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await expect(
      invokeNativeRuntime({
        ...f,
        cwd: f.scope.projectRoot,
        args: f.args,
        signal: controller.signal,
        boundNativeAuthoredLogsDrain: true,
      })
    ).rejects.toThrow("canceled");
  } finally {
    clearTimeout(timer);
  }
});
async function joinKeeper(pidPath: string) {
  const pid = Number(await readFile(pidPath, "utf8")),
    deadline = performance.now() + 3000;
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Invalid synthetic PID");
  }
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        uncertain = false;
        break;
      }
      throw error;
    }
    if (performance.now() >= deadline) {
      throw new Error("Synthetic keeper remains unconfirmed");
    }
    await Bun.sleep(10);
  }
}
test("leader exit with an inherited pipe refuses output; the exact finite keeper is joined", async () => {
  const f = await fixture(),
    pidPath = join(f.runtime.home, "keeper.pid");
  await Bun.write(
    f.runtime.binary,
    `#!${process.execPath}\nconst c=Bun.spawn([process.execPath,'--eval','await Bun.sleep(800)'],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});await Bun.write(${JSON.stringify(pidPath)},String(c.pid));console.log('{}');process.exit(0);\n`
  );
  uncertain = true;
  try {
    await expect(
      invokeNativeRuntime({
        ...f,
        cwd: f.scope.projectRoot,
        args: f.args,
        boundNativeAuthoredLogsDrain: true,
      })
    ).rejects.toThrow("did not settle");
  } finally {
    await joinKeeper(pidPath);
  }
}, 10_000);
