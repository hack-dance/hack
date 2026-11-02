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
  nativeAuthoredProjectRun,
  parseNativeAuthoredOneOff,
} from "../src/backends/native-authored-project-oneoff.ts";
import {
  nativeAuthoredProjectNamespace,
  saveNativeAuthoredProjectRun,
  withNativeAuthoredProjectStatus,
} from "../src/backends/native-authored-project-run.ts";
import { NATIVE_RUN_EMPTY_SELECTION_REFUSAL } from "../src/backends/native-project-one-off.ts";
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
    throw new Error("Synthetic run case expired/unknown; refuse child spawn.");
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
    throw new Error("Prior run lifetime is unconfirmed; evidence retained.");
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
const RUN = "a".repeat(32);
const MEMBER = "2".repeat(64);
const ONE_OFF = "9".repeat(64);
const NAME = `hkn-${RUN}-oneoff-${"5".repeat(32)}`;
async function fixture(saved = true) {
  if (uncertain) {
    throw new Error(
      "Prior synthetic lifetime is unconfirmed; evidence retained."
    );
  }
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-authored-oneoff-"))
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
    run: RUN,
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
        id: MEMBER,
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
      outcome: "one-off",
      one_off: {
        receipt,
        service: "web",
        member: MEMBER,
        container: ONE_OFF,
        name: NAME,
        exit_code: 3,
        stdout_base64: Buffer.from([0, 255, 65]).toString("base64"),
        stderr_base64: Buffer.from("literal stderr\n").toString("base64"),
        truncated: true,
      },
    },
  };
  if (uncertain) {
    throw new Error("Prior run lifetime is unconfirmed; refuse fixture setup.");
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
    "one-off",
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
  { command: undefined },
  { command: [] },
  { command: [""] },
  { command: ["true", "bad\0arg"] },
  { command: ["x".repeat(16 * 1024 + 1)] },
  { workdir: "relative" },
  { profiles: [] },
  { profiles: ["dev"] },
  { overlay: null },
  { overlay: "base" },
  { services: [] },
  { json: true },
  { detach: true },
  { follow: false },
  { tail: 10 },
  { logFormat: "plain" },
  { recover: true },
  { unsupportedOptions: true },
])("unsupported run %j refuses before selected input or runtime", async (extra) => {
  let calls = 0;
  await expect(
    tryNativeAuthoredCommand({
      selected: { kind: "native", projectRoot: "/must-not-read" },
      options: {
        cwd: "/must-not-read",
        operation: "run",
        service: "web",
        command,
        ...extra,
      },
      env: { HACK_RUNTIME_BACKEND: "native" },
      run: async () => {
        calls++;
        throw new Error("Must not invoke");
      },
      exec: async () => {
        calls++;
        throw new Error("Must not invoke");
      },
    })
  ).rejects.toMatchObject({ code: "E_NATIVE_PROJECT_UNSUPPORTED" });
  expect(calls).toBe(0);
});
test("finite authored run preserves literal argv, binary streams and nonzero exit through the saved owner", async () =>
  owned(async () => {
    const f = await fixture();
    let calls = 0;
    const result = await nativeAuthoredProjectRun({
      ...f,
      service: "web",
      command,
      workdir: "/app",
      invoke: async (input) => {
        calls++;
        expect(input.args).toEqual(f.args);
        expect(input.privateInput).toBeUndefined();
        expect(input.boundNativeAuthoredOneOffDrain).toBe(true);
        expect(input.boundNativeAuthoredExecDrain).toBeUndefined();
        expect(input.timeoutMs).toBe(45_000);
        return f.reply;
      },
    });
    expect(calls).toBe(1);
    expect(result.exitCode).toBe(3);
    expect(result.member).toBe(MEMBER);
    expect(result.container).toBe(ONE_OFF);
    expect(result.stdout).toEqual(new Uint8Array([0, 255, 65]));
    expect(new TextDecoder().decode(result.stderr)).toBe("literal stderr\n");
    expect(result.truncated).toBe(true);
    caseAdmission();
    expect(
      await nativeAuthoredProjectRun({
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
])("run %s admission makes zero runtime calls", async (kind) =>
  owned(async () => {
    const f = await fixture(kind !== "absent"),
      controller = new AbortController();
    if (kind === "cancelled") {
      controller.abort();
    }
    let calls = 0;
    await expect(
      nativeAuthoredProjectRun({
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
])("run %s incarnation replacement after dispatch withholds output without replay", async (kind) =>
  owned(async () => {
    const f = await fixture();
    let calls = 0;
    await expect(
      nativeAuthoredProjectRun({
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

test("run cancellation after the real held owner closes admits no output", async () =>
  owned(async () => {
    const f = await fixture(),
      controller = new AbortController();
    let closed = false;
    await expect(
      nativeAuthoredProjectRun({
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
      nativeAuthoredProjectRun({
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
  "member",
  "member-is-one-off",
  "container-is-member",
  "container",
  "name",
  "name-run",
  "service",
  "owner",
  "run",
  "review",
  "extra",
  "exec-outcome",
  "base64",
  "overflow",
  "exit",
  "phase",
])("run reply %s cannot replace authority or completion", async (kind) =>
  owned(async () => {
    const f = await fixture(),
      value = structuredClone(f.reply);
    const oneOff = value.result.one_off;
    if (kind === "member") {
      oneOff.member = "f".repeat(64);
    }
    if (kind === "member-is-one-off") {
      oneOff.member = ONE_OFF;
    }
    if (kind === "container-is-member") {
      oneOff.container = MEMBER;
    }
    if (kind === "container") {
      oneOff.container = "not-hex";
    }
    if (kind === "name") {
      oneOff.name = `hkn-${RUN}-container-0`;
    }
    if (kind === "name-run") {
      oneOff.name = `hkn-${"f".repeat(32)}-oneoff-${"5".repeat(32)}`;
    }
    if (kind === "service") {
      oneOff.service = "foreign";
    }
    if (kind === "owner") {
      oneOff.receipt = { ...oneOff.receipt, owner: "f".repeat(32) };
    }
    if (kind === "run") {
      value.run = "f".repeat(32);
    }
    if (kind === "review") {
      value.review = "f".repeat(64);
    }
    if (kind === "base64") {
      oneOff.stdout_base64 = "AA";
    }
    if (kind === "overflow") {
      oneOff.stdout_base64 = Buffer.alloc(1024 * 1024 + 1).toString("base64");
    }
    if (kind === "exit") {
      oneOff.exit_code = 256;
    }
    if (kind === "phase") {
      oneOff.receipt = { ...oneOff.receipt, phase: "removed" };
    }
    const replaced =
      kind === "exec-outcome"
        ? {
            ...value,
            result: {
              outcome: "exec",
              exec: { ...oneOff, member: undefined, name: undefined },
            },
          }
        : kind === "extra"
          ? { ...value, private: "must-not-render" }
          : value;
    expect(() =>
      parseNativeAuthoredOneOff(replaced, f.receipt, "web")
    ).toThrow();
  }));

test("run drain refuses the exec action, private input and malformed selection before spawn", async () => {
  const args = [
    "graph",
    "native",
    "one-off",
    "--run-id",
    RUN,
    "--service",
    "web",
    "--json",
    "--",
    "true",
  ];
  for (const changed of [
    args.slice(0, -1),
    args.map((v) => (v === "one-off" ? "exec" : v)),
    args.map((v) => (v === "one-off" ? "cleanup" : v)),
    [...args.slice(0, 7), "--workdir", "relative", ...args.slice(7)],
  ]) {
    await expect(
      invokeNativeRuntime({
        runtime: { binary: "/absent-native", home: "/absent-home" },
        cwd: "/absent-home",
        args: changed,
        boundNativeAuthoredOneOffDrain: true,
      })
    ).rejects.toThrow("budget");
  }
  await expect(
    invokeNativeRuntime({
      runtime: { binary: "/absent-native", home: "/absent-home" },
      cwd: "/absent-home",
      args,
      boundNativeAuthoredExecDrain: true,
    })
  ).rejects.toThrow("budget");
  await expect(
    invokeNativeRuntime({
      runtime: { binary: "/absent-native", home: "/absent-home" },
      cwd: "/absent-home",
      args,
      boundNativeAuthoredOneOffDrain: true,
      boundNativeAuthoredExecDrain: true,
    })
  ).rejects.toThrow("budget");
  await expect(
    invokeNativeRuntime({
      runtime: { binary: "/absent-native", home: "/absent-home" },
      cwd: "/absent-home",
      args,
      privateInput: new Uint8Array([1]),
      boundNativeAuthoredOneOffDrain: true,
    })
  ).rejects.toThrow("budget");
});

test(
  "run cancellation joins the runtime request child and never admits captured bytes",
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
      // Cancel only once the request child has published its identity, so the
      // control proves the join of a live child rather than a never-started one.
      const abortWhenStarted = (async () => {
        const deadline = performance.now() + 2500;
        while (!(await Bun.file(marker).exists())) {
          if (performance.now() >= deadline) {
            break;
          }
          await Bun.sleep(10);
        }
        controller.abort();
      })();
      try {
        await expect(
          invokeNativeRuntime({
            runtime: f.runtime,
            cwd: f.scope.projectRoot,
            args: f.args,
            signal: controller.signal,
            boundNativeAuthoredOneOffDrain: true,
          })
        ).rejects.toThrow("canceled");
        await abortWhenStarted;
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
        controller.abort();
        await abortWhenStarted;
      }
    }),
  10_000
);

const macTest = process.platform === "darwin" ? test : test.skip;
// An empty selection is refused as E_USAGE before authored dispatch; a
// non-empty selection reaches dispatch and is refused there.
const unsupportedSelection = "E_NATIVE_PROJECT_UNSUPPORTED";
macTest.each([
  { extra: [], code: 3, refusal: undefined },
  {
    extra: ["--profile", ""],
    code: 1,
    refusal: `ERROR: E_USAGE: ${NATIVE_RUN_EMPTY_SELECTION_REFUSAL}`,
  },
  ...[
    ["--profile", "dev"],
    ["--env", "base"],
  ].map((extra) => ({ extra, code: 1, refusal: unsupportedSelection })),
])(
  "source CLI run %j preserves omitted options and exact completion",
  async ({ extra, code, refusal }) =>
    owned(async () => {
      const f = await fixture(),
        attempts = join(f.runtime.home, "run-attempts");
      await Bun.write(
        join(f.scope.projectDir, "hack.project.json"),
        JSON.stringify({
          version: 1,
          services: { web: { image: "synthetic:test" } },
        })
      );
      f.reply.result.one_off.stdout_base64 =
        Buffer.from("literal stdout\n").toString("base64");
      f.reply.result.one_off.truncated = false;
      const expected = ["--candidate-root", f.runtime.home, ...f.args];
      await Bun.write(
        f.runtime.binary,
        `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';if(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(expected))})process.exit(97);appendFileSync(${JSON.stringify(attempts)},'one-off\\n');console.log(${JSON.stringify(JSON.stringify(f.reply))});\n`
      );
      caseAdmission();
      const result = await captureCompletedJobFixtureCommand({
        argv: [
          process.execPath,
          "--no-env-file",
          resolve(import.meta.dir, "../index.ts"),
          "--path",
          f.scope.projectRoot,
          "run",
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
      if (refusal) {
        expect(result.combined).toContain(refusal);
        expect(await Bun.file(attempts).exists()).toBe(false);
      } else {
        expect(await Bun.file(attempts).text()).toBe("one-off\n");
        expect(result.stdout).toBe("literal stdout\n");
        expect(result.stderr).toBe("literal stderr\n");
      }
    }, 19_000),
  20_000
);

macTest(
  "public cancellation after run completion returns130 without rendering or replay",
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
              operation: "run",
              service: "web",
              command,
            },
            env: {
              HACK_RUNTIME_BACKEND: "native",
              HACK_NATIVE_BINARY: f.runtime.binary,
              HACK_NATIVE_HOME: f.runtime.home,
            },
            run: async () => {
              calls++;
              process.emit("SIGINT");
              return {
                backend: "native",
                run: RUN,
                service: "web",
                member: MEMBER,
                container: ONE_OFF,
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

macTest("unconfirmed run completion maps to the closed run refusal", async () =>
  owned(async () => {
    const f = await fixture();
    const result = await tryNativeAuthoredCommand({
      selected: { kind: "native", projectRoot: f.scope.projectRoot },
      options: {
        cwd: f.scope.projectRoot,
        operation: "run",
        service: "web",
        command,
      },
      env: {
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: f.runtime.binary,
        HACK_NATIVE_HOME: f.runtime.home,
      },
      run: async () => {
        throw new Error("private one-off failure detail");
      },
    }).catch((error: unknown) => error);
    expect(result).toMatchObject({ code: "E_LIFECYCLE_FAILED" });
    expect(String(result)).toContain("one-off container may remain");
    expect(String(result)).not.toContain("private one-off failure detail");
  })
);
