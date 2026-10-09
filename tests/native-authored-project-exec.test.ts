import { afterEach, expect, spyOn, test } from "bun:test";
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
import { join, resolve } from "node:path";
import { parseNativeAuthoredReceipt } from "../src/backends/native-authored-graph-protocol.ts";
import {
  nativeAuthoredProjectExec,
  parseNativeAuthoredExec,
} from "../src/backends/native-authored-project-exec.ts";
import {
  nativeAuthoredProjectNamespace,
  saveNativeAuthoredProjectRun,
  withNativeAuthoredProjectStatus,
} from "../src/backends/native-authored-project-run.ts";
import { invokeNativeRuntime } from "../src/backends/native-runtime-client.ts";
import { tryNativeAuthoredCommand } from "../src/lib/native-authored-command.ts";
import type { NativeComposeCommandOptions } from "../src/lib/native-compose-command.ts";
import { captureCompletedJobFixtureCommand } from "./e2e/scenarios/native-compose-adoption-job-worktrees.ts";

const roots: string[] = [];
let uncertain = false;
let active = 0;
let caseDeadline = 0;
function caseAdmission() {
  if (uncertain || !active || performance.now() >= caseDeadline) {
    uncertain = true;
    throw new Error("Synthetic exec case expired/unknown; refuse child spawn.");
  }
}
afterEach(async () => {
  if (active) {
    uncertain = true;
  }
  if (!uncertain) {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  }
});
async function owned(body: () => Promise<void>, budgetMs = 4000) {
  if (uncertain || active) {
    uncertain = true;
    throw new Error("Prior exec lifetime is unconfirmed; evidence retained.");
  }
  const deadline = performance.now() + budgetMs;
  caseDeadline = deadline;
  active++;
  try {
    await body();
  } catch (error: unknown) {
    uncertain = true;
    throw error;
  } finally {
    if (performance.now() >= deadline) {
      uncertain = true;
    }
    if (!uncertain) {
      active--;
    }
  }
}
async function fixture(saved = true) {
  if (uncertain) {
    throw new Error(
      "Prior synthetic lifetime is unconfirmed; evidence retained."
    );
  }
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-authored-exec-"))
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
      outcome: "exec",
      exec: {
        receipt,
        service: "web",
        container: "2".repeat(64),
        exit_code: 17,
        stdout_base64: Buffer.from([0, 255, 65]).toString("base64"),
        stderr_base64: Buffer.from("literal stderr\n").toString("base64"),
        truncated: true,
      },
    },
  };
  if (uncertain) {
    throw new Error(
      "Prior exec lifetime is unconfirmed; refuse fixture setup."
    );
  }
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
    "exec",
    "--run-id",
    provenance.run,
    "--service",
    "web",
    "--workdir",
    "/app",
    "--json",
    "--",
    "/bin/tool",
    "$literal; space",
    "",
  ];
  return { scope, runtime, receipt, reply, mapping, args };
}

const command = ["/bin/tool", "$literal; space", ""] as const;
test.each<Partial<NativeComposeCommandOptions>>([
  { command: [] },
  { command: [""] },
  { command: ["true", "bad\0arg"] },
  { command: ["x".repeat(16 * 1024 + 1)] },
  { workdir: "relative" },
  { profiles: [] },
  { overlay: null },
  { services: [] },
  { json: true },
  { follow: false },
  { recover: true },
  { unsupportedOptions: true },
])("unsupported exec %j refuses before selected input or runtime", async (extra) => {
  let calls = 0;
  await expect(
    tryNativeAuthoredCommand({
      selected: { kind: "native", projectRoot: "/must-not-read" },
      options: {
        cwd: "/must-not-read",
        operation: "exec",
        service: "web",
        command,
        ...extra,
      },
      env: { HACK_RUNTIME_BACKEND: "native" },
      exec: async () => {
        calls++;
        throw new Error("Must not invoke");
      },
    })
  ).rejects.toMatchObject({ code: "E_NATIVE_PROJECT_UNSUPPORTED" });
  expect(calls).toBe(0);
});
test("finite authored exec preserves literal argv, binary streams and nonzero exit through the saved owner", async () =>
  owned(async () => {
    const f = await fixture();
    let calls = 0;
    const result = await nativeAuthoredProjectExec({
      ...f,
      service: "web",
      command,
      workdir: "/app",
      invoke: async (input) => {
        calls++;
        expect(input.args).toEqual(f.args);
        expect(input.privateInput).toBeUndefined();
        expect(input.boundNativeAuthoredExecDrain).toBe(true);
        expect(input.timeoutMs).toBe(45_000);
        return f.reply;
      },
    });
    expect(calls).toBe(1);
    expect(result.exitCode).toBe(17);
    expect(result.stdout).toEqual(new Uint8Array([0, 255, 65]));
    expect(new TextDecoder().decode(result.stderr)).toBe("literal stderr\n");
    expect(result.truncated).toBe(true);
    caseAdmission();
    expect(
      await nativeAuthoredProjectExec({
        ...f,
        service: "web",
        command,
        workdir: "/app",
      })
    ).toEqual(result);
  }));

test.each([
  "absent",
  "foreign",
  "cancelled",
])("exec %s admission makes zero runtime calls", async (kind) =>
  owned(async () => {
    const f = await fixture(kind !== "absent"),
      controller = new AbortController();
    if (kind === "cancelled") {
      controller.abort();
    }
    let calls = 0;
    await expect(
      nativeAuthoredProjectExec({
        ...f,
        service: kind === "foreign" ? "other" : "web",
        command,
        signal: controller.signal,
        invoke: async () => {
          calls++;
          return f.reply;
        },
      })
    ).rejects.toThrow();
    expect(calls).toBe(0);
  }));

test.each([
  "mapping",
  "executable",
])("exec %s incarnation replacement after dispatch withholds output without replay", async (kind) =>
  owned(async () => {
    const f = await fixture();
    let calls = 0;
    await expect(
      nativeAuthoredProjectExec({
        ...f,
        service: "web",
        command,
        invoke: async () => {
          calls++;
          const path = kind === "mapping" ? f.mapping : f.runtime.binary,
            bytes = await readFile(path);
          await rename(path, `${path}.old`);
          await Bun.write(path, bytes);
          if (kind === "executable") {
            await chmod(path, 0o700);
          }
          return f.reply;
        },
      })
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }));

test("exec cancellation after the real held owner closes admits no output", async () =>
  owned(async () => {
    const f = await fixture(),
      controller = new AbortController();
    let closed = false;
    await expect(
      nativeAuthoredProjectExec({
        ...f,
        service: "web",
        command,
        signal: controller.signal,
        invoke: async () => f.reply,
        withStatus: async (scope, action) => {
          const value = await withNativeAuthoredProjectStatus(scope, action);
          closed = true;
          controller.abort();
          return value;
        },
      })
    ).rejects.toThrow();
    expect(closed).toBe(true);
  }));

test("runtime replacement during the last saved-owner assertion refuses before dispatch", async () =>
  owned(async () => {
    const f = await fixture();
    let invokes = 0,
      assertions = 0;
    await expect(
      nativeAuthoredProjectExec({
        ...f,
        service: "web",
        command,
        withStatus: (scope, action) =>
          withNativeAuthoredProjectStatus(scope, (saved) =>
            action({
              ...saved,
              assertFresh: async () => {
                await saved.assertFresh();
                assertions++;
                const bytes = await readFile(f.runtime.binary);
                await rename(f.runtime.binary, `${f.runtime.binary}.old`);
                await Bun.write(f.runtime.binary, bytes);
                await chmod(f.runtime.binary, 0o700);
              },
            })
          ),
        invoke: async () => {
          invokes++;
          return f.reply;
        },
      })
    ).rejects.toThrow();
    expect(assertions).toBe(1);
    expect(invokes).toBe(0);
  }));

test.each([
  "container",
  "service",
  "owner",
  "run",
  "review",
  "extra",
  "base64",
  "overflow",
  "exit",
  "phase",
])("exec reply %s cannot replace authority or completion", async (kind) =>
  owned(async () => {
    const f = await fixture(),
      value = structuredClone(f.reply);
    if (kind === "container") {
      value.result.exec.container = "f".repeat(64);
    }
    if (kind === "service") {
      value.result.exec.service = "foreign";
    }
    if (kind === "owner") {
      value.result.exec.receipt = {
        ...value.result.exec.receipt,
        owner: "f".repeat(32),
      };
    }
    if (kind === "run") {
      value.run = "f".repeat(32);
    }
    if (kind === "review") {
      value.review = "f".repeat(64);
    }
    if (kind === "base64") {
      value.result.exec.stdout_base64 = "AA";
    }
    if (kind === "overflow") {
      value.result.exec.stdout_base64 = Buffer.alloc(1024 * 1024 + 1).toString(
        "base64"
      );
    }
    if (kind === "exit") {
      value.result.exec.exit_code = 256;
    }
    if (kind === "phase") {
      value.result.exec.receipt = {
        ...value.result.exec.receipt,
        phase: "removed",
      };
    }
    expect(() =>
      parseNativeAuthoredExec(
        kind === "extra" ? { ...value, private: "must-not-render" } : value,
        f.receipt,
        "web"
      )
    ).toThrow();
  }));

test("exec drain refuses unrelated action, private input and malformed selection before spawn", async () => {
  const args = [
    "graph",
    "native",
    "exec",
    "--run-id",
    "a".repeat(32),
    "--service",
    "web",
    "--json",
    "--",
    "true",
  ];
  for (const changed of [
    args.slice(0, -1),
    args.map((v) => (v === "exec" ? "cleanup" : v)),
    [...args.slice(0, 7), "--workdir", "relative", ...args.slice(7)],
  ]) {
    await expect(
      invokeNativeRuntime({
        runtime: { binary: "/absent-native", home: "/absent-home" },
        cwd: "/absent-home",
        args: changed,
        boundNativeAuthoredExecDrain: true,
      })
    ).rejects.toThrow("budget");
  }
  await expect(
    invokeNativeRuntime({
      runtime: { binary: "/absent-native", home: "/absent-home" },
      cwd: "/absent-home",
      args,
      privateInput: new Uint8Array([1]),
      boundNativeAuthoredExecDrain: true,
    })
  ).rejects.toThrow("budget");
});

test(
  "exec cancellation joins the runtime request child and never admits captured bytes",
  async () =>
    owned(async () => {
      const f = await fixture(),
        controller = new AbortController(),
        marker = join(f.runtime.home, "request.pid");
      await Bun.write(
        f.runtime.binary,
        `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)},String(process.pid));console.log('private-command-output');await Bun.sleep(3000);\n`
      );
      caseAdmission();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        await expect(
          invokeNativeRuntime({
            runtime: f.runtime,
            cwd: f.scope.projectRoot,
            args: f.args,
            signal: controller.signal,
            boundNativeAuthoredExecDrain: true,
          })
        ).rejects.toThrow("canceled");
        const pid = Number(await readFile(marker, "utf8"));
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        let absent = false;
        try {
          process.kill(pid, 0);
        } catch (error: unknown) {
          absent = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
        expect(absent).toBe(true);
      } finally {
        clearTimeout(timer);
      }
    }),
  10_000
);

const macTest = process.platform === "darwin" ? test : test.skip;
async function joinKeeper(marker: string) {
  const pid = Number(await readFile(marker, "utf8")),
    deadline = performance.now() + 3000;
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Invalid exact keeper identity");
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
        return;
      }
      throw error;
    }
    if (performance.now() >= deadline) {
      throw new Error("Exact synthetic keeper remains unconfirmed");
    }
    await Bun.sleep(10);
  }
}
test("exited exec request with inherited streams refuses bytes and joins its exact finite keeper", async () =>
  owned(async () => {
    const f = await fixture(),
      marker = join(f.runtime.home, "keeper.pid");
    await Bun.write(
      f.runtime.binary,
      `#!${process.execPath}\nconst child=Bun.spawn([process.execPath,'--eval','await Bun.sleep(800)'],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});await Bun.write(${JSON.stringify(marker)},String(child.pid));console.log('{}');process.exit(0);\n`
    );
    caseAdmission();
    try {
      await expect(
        invokeNativeRuntime({
          runtime: f.runtime,
          cwd: f.scope.projectRoot,
          args: f.args,
          boundNativeAuthoredExecDrain: true,
        })
      ).rejects.toThrow("did not settle");
    } finally {
      await joinKeeper(marker);
    }
  }));
macTest.each([
  { extra: [], code: 17 },
  ...[
    ["--profile", ""],
    ["--profile", "dev"],
    ["--env", "base"],
  ].map((extra) => ({ extra, code: 1 })),
])(
  "source CLI exec %j preserves omitted options and exact completion",
  async ({ extra, code }) =>
    owned(async () => {
      const f = await fixture(),
        attempts = join(f.runtime.home, "exec-attempts");
      await Bun.write(
        join(f.scope.projectDir, "hack.project.json"),
        JSON.stringify({
          version: 1,
          services: { web: { image: "synthetic:test" } },
        })
      );
      f.reply.result.exec.stdout_base64 =
        Buffer.from("literal stdout\n").toString("base64");
      f.reply.result.exec.truncated = false;
      const expected = ["--candidate-root", f.runtime.home, ...f.args];
      await Bun.write(
        f.runtime.binary,
        `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';if(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(expected))})process.exit(97);appendFileSync(${JSON.stringify(attempts)},'exec\\n');console.log(${JSON.stringify(JSON.stringify(f.reply))});\n`
      );
      caseAdmission();
      const result = await captureCompletedJobFixtureCommand({
        argv: [
          process.execPath,
          "--no-env-file",
          resolve(import.meta.dir, "../index.ts"),
          "--path",
          f.scope.projectRoot,
          "exec",
          ...extra,
          "--workdir",
          "/app",
          "web",
          "--",
          ...command,
        ],
        cwd: f.scope.projectRoot,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: f.scope.projectRoot,
          HACK_HOME: join(f.scope.projectRoot, "home"),
          HACK_RUNTIME_BACKEND: "native",
          HACK_NATIVE_BINARY: f.runtime.binary,
          HACK_NATIVE_HOME: f.runtime.home,
          HACK_CONFIG_COMPILER_BINARY:
            process.env.HACK_CONFIG_COMPILER_BINARY ??
            resolve(import.meta.dir, "../dist/hack-config-compiler"),
          HACK_LOGGER: "console",
          HACK_EXECUTION_MODE: "non_interactive",
          CI: "1",
        },
        captures: join(f.scope.projectRoot, "captures"),
        timeoutMs: 15_000,
        onUnconfirmed: () => {
          uncertain = true;
        },
      });
      expect({ code: result.exitCode, output: result.combined }).toMatchObject({
        code,
      });
      if (extra.length) {
        expect(result.combined).toContain("E_NATIVE_PROJECT_UNSUPPORTED");
        expect(await Bun.file(attempts).exists()).toBe(false);
      } else {
        expect(await Bun.file(attempts).text()).toBe("exec\n");
        expect(result.stdout).toBe("literal stdout\n");
        expect(result.stderr).toBe("literal stderr\n");
      }
    }, 19_000),
  20_000
);

macTest(
  "public cancellation after exec completion returns130 without rendering or replay",
  async () =>
    owned(async () => {
      const f = await fixture(),
        write = spyOn(Bun, "write").mockResolvedValue(0);
      let calls = 0;
      try {
        expect(
          await tryNativeAuthoredCommand({
            selected: { kind: "native", projectRoot: f.scope.projectRoot },
            options: {
              cwd: f.scope.projectRoot,
              operation: "exec",
              service: "web",
              command,
            },
            env: {
              HACK_RUNTIME_BACKEND: "native",
              HACK_NATIVE_BINARY: f.runtime.binary,
              HACK_NATIVE_HOME: f.runtime.home,
            },
            exec: async () => {
              calls++;
              process.emit("SIGINT");
              return {
                backend: "native",
                run: "a".repeat(32),
                service: "web",
                container: "2".repeat(64),
                exitCode: 0,
                stdout: new Uint8Array([1]),
                stderr: new Uint8Array(),
                truncated: false,
              };
            },
          })
        ).toBe(130);
        expect(calls).toBe(1);
        expect(write).not.toHaveBeenCalled();
      } finally {
        write.mockRestore();
      }
    })
);

macTest.each([1, 2])(
  "cancellation during admitted local output write%d returns130 without later writes",
  async (cancelAt) =>
    owned(async () => {
      const f = await fixture();
      let writes = 0;
      const writer = spyOn(Bun, "write").mockImplementation(async () => {
        writes++;
        if (writes === cancelAt) {
          process.emit("SIGINT");
        }
        return 1;
      });
      try {
        const result = await tryNativeAuthoredCommand({
          selected: { kind: "native", projectRoot: f.scope.projectRoot },
          options: {
            cwd: f.scope.projectRoot,
            operation: "exec",
            service: "web",
            command,
          },
          env: {
            HACK_RUNTIME_BACKEND: "native",
            HACK_NATIVE_BINARY: f.runtime.binary,
            HACK_NATIVE_HOME: f.runtime.home,
          },
          exec: async () => ({
            backend: "native",
            run: "a".repeat(32),
            service: "web",
            container: "2".repeat(64),
            exitCode: 17,
            stdout: new Uint8Array([1]),
            stderr: new Uint8Array([2]),
            truncated: false,
          }),
        });
        expect(result).toBe(130);
        expect(writes).toBe(cancelAt);
      } finally {
        writer.mockRestore();
      }
    })
);
