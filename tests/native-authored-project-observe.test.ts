import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseNativeAuthoredReceipt } from "../src/backends/native-authored-graph-protocol.ts";
import { nativeAuthoredProjectPs } from "../src/backends/native-authored-project-observe.ts";
import {
  nativeAuthoredProjectNamespace,
  saveNativeAuthoredProjectRun,
  withNativeAuthoredProjectAdmission,
  withNativeAuthoredProjectStatus,
} from "../src/backends/native-authored-project-run.ts";
import { captureCompletedJobFixtureCommand } from "./e2e/scenarios/native-compose-adoption-job-worktrees.ts";

let active = 0,
  unknown = false;
const roots: string[] = [];
afterEach(async () => {
  if (active) {
    unknown = true;
  }
  if (!unknown) {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  }
});
async function owned(body: () => Promise<void>) {
  if (unknown) {
    throw new Error(
      "Prior status case lifetime is unconfirmed; fixtures retained."
    );
  }
  active++;
  try {
    await body();
  } finally {
    active--;
  }
}
async function fixture(saved = true, branch: string | null = null) {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-authored-ps-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack"),
    nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir, { mode: 0o700 });
  await mkdir(nativeHome, { mode: 0o700 });
  // Invalid authored bytes deliberately prove ps does not parse or compile them.
  await Bun.write(
    join(projectDir, "hack.project.json"),
    "not valid authored JSON"
  );
  const scope = { projectRoot, projectDir, nativeHome, branch };
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
      outcome: "status",
      snapshot: {
        receipt,
        observations: { web: { state: "running", health: "healthy" } },
      },
    },
  };
  const runtime = { binary: join(nativeHome, "native"), home: nativeHome };
  const attempts = join(nativeHome, "status-attempts");
  await Bun.write(
    runtime.binary,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst expected=${JSON.stringify(["--candidate-root", nativeHome, "graph", "native", "control", "--run-id", provenance.run, "--action", "status", "--json"])};if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(expected))process.exit(97);appendFileSync(${JSON.stringify(attempts)},'status\\n');console.log(${JSON.stringify(JSON.stringify(reply))});\n`
  );
  await chmod(runtime.binary, 0o700);
  const mapping = join(
    projectDir,
    ".internal",
    "native-authored-runs",
    `${createHash("sha256").update(JSON.stringify(branch)).digest("hex")}.json`
  );
  return { scope, runtime, receipt, reply, mapping, attempts };
}

test("clean absence and retained start are distinct, readonly and invoke nothing", () =>
  owned(async () => {
    const f = await fixture(false);
    const before = await readdir(f.scope.projectDir);
    let calls = 0;
    const invoke = async () => {
      calls++;
      throw new Error("Unexpected runtime");
    };
    expect(await nativeAuthoredProjectPs({ ...f, invoke })).toMatchObject({
      status: "not_started",
      items: [],
    });
    expect(await readdir(f.scope.projectDir)).toEqual(before);
    await withNativeAuthoredProjectAdmission(f.scope, async (admission) => {
      await admission.reserve({ review: f.receipt.review });
    });
    expect(await nativeAuthoredProjectPs({ ...f, invoke })).toMatchObject({
      status: "pending",
      items: [],
      run: null,
    });
    expect(calls).toBe(0);
  }));

test.each([
  false,
  true,
])("status retains absence/pending selection when a ready mapping appears (pending=%s)", (pending) =>
  owned(async () => {
    const f = await fixture(false);
    if (pending) {
      await withNativeAuthoredProjectAdmission(f.scope, async (admission) => {
        await admission.reserve({ review: f.receipt.review });
      });
    }
    await expect(
      withNativeAuthoredProjectStatus(f.scope, async (selected) => {
        expect(selected.ready).toBeNull();
        expect(selected.pending).toBe(pending);
        await saveNativeAuthoredProjectRun({
          ...f.scope,
          record: {
            version: 2,
            kind: "native-authored-project-run",
            receipt: f.receipt,
          },
        });
      })
    ).rejects.toThrow();
  }));

test.each([
  { state: "running", health: "unhealthy" },
  { state: "created" },
  { state: "exited", code: 17 },
  null,
])("status reports fresh member observation %j rather than saved readiness", (observation) =>
  owned(async () => {
    const f = await fixture();
    let calls = 0;
    const result = await nativeAuthoredProjectPs({
      ...f,
      invoke: async (request) => {
        calls++;
        expect(request.args).toEqual([
          "graph",
          "native",
          "control",
          "--run-id",
          f.receipt.review.provenance.run,
          "--action",
          "status",
          "--json",
        ]);
        expect(request.boundNativeStatusDrain).toBe(true);
        expect(request.privateInput).toBeUndefined();
        return {
          ...f.reply,
          result: {
            outcome: "status",
            snapshot: {
              receipt: f.receipt,
              observations: { web: observation },
            },
          },
        };
      },
    });
    expect(calls).toBe(1);
    expect(result.items[0]?.state).toBe(observation?.state ?? "absent");
    expect(result.items[0]?.health).toBe(
      observation?.state === "running" ? observation.health : null
    );
    expect(result.items[0]?.exitCode).toBe(
      observation?.state === "exited" ? observation.code : null
    );
  }));

test.each([
  "run",
  "owner",
  "member",
  "source",
  "storage",
  "malformed",
] as const)("status refuses %s reply drift without fallback", (fault) =>
  owned(async () => {
    const f = await fixture();
    const snapshot = f.reply.result.snapshot;
    const invalid = {
      run: { ...f.reply, run: "4".repeat(32) },
      owner: {
        ...f.reply,
        result: {
          outcome: "status",
          snapshot: {
            ...snapshot,
            receipt: { ...f.receipt, owner: "4".repeat(32) },
          },
        },
      },
      member: {
        ...f.reply,
        result: {
          outcome: "status",
          snapshot: {
            ...snapshot,
            observations: { foreign: { state: "dead" } },
          },
        },
      },
      source: {
        ...f.reply,
        result: {
          outcome: "status",
          snapshot: { ...snapshot, receipt: { ...f.receipt, source: {} } },
        },
      },
      storage: {
        ...f.reply,
        result: {
          outcome: "status",
          snapshot: { ...snapshot, receipt: { ...f.receipt, data: {} } },
        },
      },
      malformed: {
        ...f.reply,
        result: {
          outcome: "status",
          snapshot: {
            ...snapshot,
            observations: {
              web: {
                state: "running",
                health: "healthy",
                private: "private-status-canary",
              },
            },
          },
        },
      },
    };
    const reply: unknown = invalid[fault];
    let calls = 0;
    await expect(
      nativeAuthoredProjectPs({
        ...f,
        invoke: async () => {
          calls++;
          return reply;
        },
      })
    ).rejects.toThrow(
      "Native authored run artifact is unsafe, changed, or owned by another run"
    );
    expect(calls).toBe(1);
  }));

test.each([
  "rebirth",
  "content",
  "binary",
  "recovery",
])("status refuses %s drift across its awaited request", (fault) =>
  owned(async () => {
    const f = await fixture();
    await expect(
      nativeAuthoredProjectPs({
        ...f,
        invoke: async () => {
          if (fault === "rebirth") {
            await rename(f.mapping, `${f.mapping}.original`);
            await Bun.write(
              f.mapping,
              await Bun.file(`${f.mapping}.original`).text()
            );
            await chmod(f.mapping, 0o600);
          }
          if (fault === "content") {
            await Bun.write(f.mapping, "{}");
          }
          if (fault === "binary") {
            await Bun.write(f.runtime.binary, "changed");
          }
          if (fault === "recovery") {
            await Bun.write(`${f.mapping}.recovery.json`, "{}");
          }
          return f.reply;
        },
      })
    ).rejects.toThrow();
  }));

test.each([
  false,
  true,
])("primary mutation recovery marker refuses before/during status (during=%s)", (during) =>
  owned(async () => {
    const f = await fixture();
    const marker = `${f.mapping.slice(0, -".json".length)}.recovery`;
    if (!during) {
      await mkdir(marker, { mode: 0o700 });
    }
    let calls = 0;
    await expect(
      nativeAuthoredProjectPs({
        ...f,
        invoke: async () => {
          calls++;
          await mkdir(marker, { mode: 0o700 });
          return f.reply;
        },
      })
    ).rejects.toThrow();
    expect(calls).toBe(during ? 1 : 0);
  }));

test.each([
  "absent",
  "pending",
  "observed",
] as const)("final held-status return cannot publish after cancellation (%s)", (state) =>
  owned(async () => {
    const f = await fixture(state === "observed");
    if (state === "pending") {
      await withNativeAuthoredProjectAdmission(f.scope, async (admission) => {
        await admission.reserve({ review: f.receipt.review });
      });
    }
    const controller = new AbortController();
    let completed = false;
    await expect(
      nativeAuthoredProjectPs({
        ...f,
        signal: controller.signal,
        invoke: async () => f.reply,
        withStatus: async (scope, action) => {
          const result = await withNativeAuthoredProjectStatus(scope, action);
          completed = true;
          controller.abort();
          return result;
        },
      })
    ).rejects.toThrow("status is unconfirmed");
    expect(completed).toBe(true);
  }));

test("branch isolation and captured options cannot retarget a pending read", () =>
  owned(async () => {
    const f = await fixture(true, "feature");
    expect(
      await nativeAuthoredProjectPs({
        ...f,
        scope: { ...f.scope, branch: null },
        invoke: async () => {
          throw new Error("No base run");
        },
      })
    ).toHaveProperty("status", "not_started");
    const observing = nativeAuthoredProjectPs({
      ...f,
      invoke: async () => {
        f.scope.branch = "other";
        f.runtime.home = "/changed";
        return f.reply;
      },
    });
    expect(await observing).toHaveProperty("status", "observed");
  }));

test("dead owner refuses and cancellation waits for the owned request", () =>
  owned(async () => {
    const f = await fixture();
    let calls = 0;
    await expect(
      nativeAuthoredProjectPs({
        ...f,
        invoke: async () => {
          calls++;
          throw new Error("Owner unavailable");
        },
      })
    ).rejects.toThrow();
    expect(calls).toBe(1);
    const controller = new AbortController(),
      entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    let settled = false;
    const attempt = nativeAuthoredProjectPs({
      ...f,
      signal: controller.signal,
      invoke: async (request) => {
        expect(request.signal).toBe(controller.signal);
        entered.resolve();
        await finish.promise;
        throw new Error("Canceled owner");
      },
    }).catch(() => {
      settled = true;
    });
    await entered.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish.resolve();
    await attempt;
    expect(settled).toBe(true);
  }));

const macTest = process.platform === "darwin" ? test : test.skip;
macTest.each([
  { json: true, profile: undefined },
  { json: false, profile: undefined },
  { json: true, profile: "" },
  { json: true, profile: "dev" },
])(
  "source CLI native authored ps %j preserves omitted versus explicit profile selection",
  ({ json, profile }) =>
    owned(async () => {
      const f = await fixture();
      const result = await captureCompletedJobFixtureCommand({
        argv: [
          process.execPath,
          resolve(import.meta.dir, "../index.ts"),
          "--path",
          f.scope.projectRoot,
          "ps",
          ...(json ? ["--json"] : []),
          ...(profile === undefined ? [] : ["--profile", profile]),
        ],
        cwd: f.scope.projectRoot,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: f.scope.projectRoot,
          HACK_HOME: join(f.scope.projectRoot, "home"),
          HACK_RUNTIME_BACKEND: "native",
          HACK_NATIVE_BINARY: f.runtime.binary,
          HACK_NATIVE_HOME: f.runtime.home,
          HACK_CONFIG_COMPILER_BINARY: "/must-not-compile",
          HACK_LOGGER: "console",
          HACK_EXECUTION_MODE: "non_interactive",
          CI: "1",
        },
        captures: join(f.scope.projectRoot, "captures"),
        timeoutMs: 15_000,
        onUnconfirmed: () => {
          unknown = true;
        },
      }).catch((error: unknown) => {
        unknown = true;
        throw error;
      });
      if (profile !== undefined) {
        expect(result.exitCode).toBe(1);
        expect(result.combined).toContain("E_NATIVE_PROJECT_UNSUPPORTED");
        expect(await Bun.file(f.attempts).exists()).toBe(false);
        return;
      }
      expect({
        exitCode: result.exitCode,
        output: result.combined,
      }).toMatchObject({ exitCode: 0 });
      expect(await Bun.file(f.attempts).text()).toBe("status\n");
      if (json) {
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: true,
          data: {
            status: "observed",
            items: [{ service: "web", state: "running", health: "healthy" }],
          },
        });
      } else {
        expect(result.stdout).toContain("web");
        expect(result.stdout).toContain("healthy");
      }
    }),
  20_000
);
