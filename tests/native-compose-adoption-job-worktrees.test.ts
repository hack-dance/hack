import { expect, spyOn, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureCompletedJobFixtureCommand,
  captureCompletedJobFixtureInterrupt,
  completedJobFixtureAppAttempts,
  completedJobFixtureFreshExit,
  completedJobFixtureNoDependentStart,
  completedJobFixtureObject,
  completedJobFixtureResource,
  createCompletedJobFixturePhases,
  createCompletedJobFixtureSettlement,
} from "./e2e/scenarios/native-compose-adoption-job-worktrees.ts";

const ID = "a".repeat(64);
const IMAGE = `sha256:${"d".repeat(64)}`;
const NETWORK = "b".repeat(64);
const INSTANCE = {
  root: "/private/fixture",
  name: "completed-alpha",
  marker: "alpha-original-seed",
};
const STATE = {
  id: ID,
  running: false,
  paused: false,
  status: "exited",
  exitCode: 0,
  startedAt: "2026-10-08T01:02:04.123456789Z",
  finishedAt: "2026-10-08T01:02:05Z",
};
const CONTAINER = {
  id: ID,
  image: IMAGE,
  name: "/completed-alpha-seed-1",
  project: INSTANCE.name,
  nativeNames: ["com.docker.compose.project", "hack.service.one-shot"],
  service: "seed",
  number: "1",
  oneoff: "False",
  workingDir: "/private/fixture/.hack",
  configFiles: "/private/fixture/.hack/docker-compose.yml",
  ports: {},
  publishAll: false,
  runtimePorts: { "5432/tcp": null },
  mounts: [
    {
      type: "volume",
      name: "completed-alpha_data",
      target: "/var/lib/postgresql/data",
      rw: false,
    },
  ],
  networks: [{ name: "completed-alpha_default", id: NETWORK }],
};

test("fixture diagnostics keep the failed phase separate from later cleanup", () => {
  const messages: string[] = [];
  const phases = createCompletedJobFixturePhases((message) =>
    messages.push(message)
  );
  phases.mark("alpha-start-2");
  phases.failed();
  phases.mark("cleanup");
  expect(messages).toEqual([
    "phase=alpha-start-2 status=enter",
    "phase=alpha-start-2 status=failed",
    "phase=cleanup status=enter",
  ]);
});

test("fixture diagnostics neither quote unknown values nor interrupt cleanup on logging failure", () => {
  const messages: string[] = [];
  const phases = createCompletedJobFixturePhases((message) =>
    messages.push(message)
  );
  phases.mark("alpha-adopt");
  for (const value of [
    "private-diagnostic-canary",
    "constructor",
    null,
    17,
    {},
  ]) {
    expect(() => phases.mark(value)).not.toThrow();
  }
  phases.failed();
  expect(messages).toEqual([
    "phase=alpha-adopt status=enter",
    "phase=alpha-adopt status=failed",
  ]);
  const broken = createCompletedJobFixturePhases(() => {
    throw new Error("private-log-failure-canary");
  });
  expect(() => broken.mark("cleanup")).not.toThrow();
  expect(() => broken.failed()).not.toThrow();
});

test("private observation parsing refuses malformed values without quoting them", () => {
  expect(() => completedJobFixtureObject("private-invalid-canary")).toThrow(
    "Completed-job worktree acceptance refused; values omitted."
  );
});
test("dependent attempts correspond exactly to successful job attempts rather than only row count", () => {
  expect(() =>
    completedJobFixtureAppAttempts({
      expected: [1, 2, 3, 4, 7],
      observed: "1,2,3,4,7",
    })
  ).not.toThrow();
  for (const observed of ["1,2,3,4,4", "1,2,3,4,6", "1,2,3,4", "1,2,3,4,7,7"]) {
    expect(() =>
      completedJobFixtureAppAttempts({ expected: [1, 2, 3, 4, 7], observed })
    ).toThrow("values omitted");
  }
});

async function waitForFile(path: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Synthetic owned child did not become ready");
}
function absent(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return true;
    }
    throw error;
  }
}
async function waitForAbsent(pid: number) {
  const deadline = Date.now() + 2000;
  while (!absent(pid) && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  expect(absent(pid)).toBe(true);
}

test.each([
  0, 17,
])("ordinary captured job command records real exit%d, both EOFs and fresh leader/group absence", async (exitCode) => {
  const root = await mkdtemp(join(tmpdir(), "completed-job-command-"));
  const captures = join(root, "capture");
  const originalKill = process.kill.bind(process);
  const groups: number[] = [];
  const signals = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0 && signal !== 0) {
      groups.push(pid);
    }
    return originalKill(pid, signal);
  });
  let unconfirmed = false;
  try {
    const result = await captureCompletedJobFixtureCommand({
      argv: [
        process.execPath,
        "-e",
        `console.log('captured-output'); console.error('captured-error'); process.exit(${exitCode});`,
      ],
      cwd: root,
      env: {},
      captures,
      timeoutMs: 2000,
      onUnconfirmed: () => {
        unconfirmed = true;
      },
    });
    const owner = JSON.parse(await Bun.file(`${captures}.owner.json`).text());
    const receipt = JSON.parse(
      await Bun.file(`${captures}.settlement.json`).text()
    );
    expect(Number.isSafeInteger(owner.pid) && owner.pid > 0).toBe(true);
    expect(owner.pgid).toBe(owner.pid);
    expect(owner.executable).toBe(process.execPath);
    expect(receipt).toEqual({
      authority: "observation-only",
      completionRequires: "successful-return-and-live-settlement-gate",
      pid: owner.pid,
      pgid: owner.pgid,
      exitCode,
      exitSignal: null,
      leaderExited: true,
      stdoutEof: true,
      stderrEof: true,
      capturedLeaderAbsent: true,
      capturedGroupAbsent: true,
      scope: "captured-child-group",
      interrupted: false,
      callbackSettled: true,
    });
    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toBe("captured-output\n");
    expect(result.stderr).toBe("captured-error\n");
    expect(result.timedOut).toBe(false);
    expect(absent(owner.pid)).toBe(true);
    expect(absent(-owner.pgid)).toBe(true);
    expect(groups).toEqual([]);
    expect(unconfirmed).toBe(false);
  } finally {
    signals.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary capture refuses a still-present captured group even after leader exit and both EOFs", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "completed-job-group-observation-")
  );
  const captures = join(root, "capture");
  const originalKill = process.kill.bind(process);
  const groups: number[] = [];
  const signals = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0 && signal === 0) {
      return true;
    }
    if (pid < 0) {
      groups.push(pid);
    }
    return originalKill(pid, signal);
  });
  const settlement = createCompletedJobFixtureSettlement();
  let cleanup = 0;
  try {
    await expect(
      captureCompletedJobFixtureCommand({
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: root,
        env: {},
        captures,
        timeoutMs: 2000,
        onUnconfirmed: settlement.markUnconfirmed,
      })
    ).rejects.toThrow("settlement refused");
    expect(await Bun.file(`${captures}.settlement.json`).exists()).toBe(false);
    expect(() => {
      settlement.assertConfirmed();
      cleanup += 1;
    }).toThrow("values omitted");
    expect(cleanup).toBe(0);
    expect(groups).toEqual([]);
  } finally {
    signals.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("a delayed capture write cannot extend settlement or release teardown after late completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "completed-job-delayed-write-"));
  const captures = join(root, "capture");
  const handle = await open(join(root, "prototype-owner"), "wx", 0o600);
  // This is the same trusted Node FileHandle prototype used by the real capture handles.
  const prototype: FileHandle = Object.getPrototypeOf(handle);
  const originalWrite: (
    this: FileHandle,
    buffer: Buffer
  ) => Promise<{ bytesWritten: number; buffer: Buffer }> = prototype.write;
  let lateWrite: Promise<unknown> | undefined;
  let writeFinished = false;
  function delayedWrite<TBuffer extends NodeJS.ArrayBufferView>(
    this: FileHandle,
    buffer: TBuffer,
    offset?: number | null,
    length?: number | null,
    position?: number | null
  ): Promise<{ bytesWritten: number; buffer: TBuffer }>;
  function delayedWrite<TBuffer extends Uint8Array>(
    this: FileHandle,
    buffer: TBuffer,
    options?: { offset?: number; length?: number; position?: number }
  ): Promise<{ bytesWritten: number; buffer: TBuffer }>;
  function delayedWrite(
    this: FileHandle,
    data: string,
    position?: number | null,
    encoding?: BufferEncoding | null
  ): Promise<{ bytesWritten: number; buffer: string }>;
  function delayedWrite(
    this: FileHandle,
    data: unknown,
    ...rest: unknown[]
  ): Promise<unknown> {
    // The owning capture writes only one Buffer argument; unrelated overload calls are outside this control.
    if (!Buffer.isBuffer(data) || rest.length !== 0) {
      throw new Error("Synthetic delayed capture write refused");
    }
    if (data.toString().includes("delayed-owned-write") && !lateWrite) {
      const pending = (async () => {
        await Bun.sleep(2600);
        return await originalWrite.call(this, data);
      })().finally(() => {
        writeFinished = true;
      });
      lateWrite = pending;
      return pending;
    }
    return originalWrite.call(this, data);
  }
  const writes = spyOn(prototype, "write").mockImplementation(delayedWrite);
  const settlement = createCompletedJobFixtureSettlement();
  let cleanup = 0;
  const started = Date.now();
  try {
    await expect(
      captureCompletedJobFixtureCommand({
        argv: [process.execPath, "-e", "console.log('delayed-owned-write')"],
        cwd: root,
        env: {},
        captures,
        timeoutMs: 250,
        onUnconfirmed: settlement.markUnconfirmed,
      })
    ).rejects.toThrow("settlement refused");
    expect(Date.now() - started).toBeLessThan(2500);
    expect(lateWrite).toBeDefined();
    expect(writeFinished).toBe(false);
    expect(() => {
      settlement.assertConfirmed();
      cleanup += 1;
    }).toThrow("values omitted");
    expect(cleanup).toBe(0);
    await lateWrite;
    expect(writeFinished).toBe(true);
    expect(() => settlement.assertConfirmed()).toThrow("values omitted");
    expect(await Bun.file(`${captures}.settlement.json`).exists()).toBe(false);
  } finally {
    await lateWrite?.catch(() => undefined);
    writes.mockRestore();
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a late settlement observation never overrides failed capture or its persistent teardown veto", async () => {
  const root = await mkdtemp(join(tmpdir(), "completed-job-delayed-receipt-"));
  const captures = join(root, "capture");
  const originalWrite = Bun.write;
  let lateWrite: Promise<number> | undefined;
  const receipts = spyOn(Bun, "write").mockImplementation(
    (destination, data, options) => {
      // This capture publishes JSON strings to private paths with no optional writer settings.
      if (
        typeof destination !== "string" ||
        typeof data !== "string" ||
        options !== undefined
      ) {
        throw new Error("Synthetic delayed settlement write refused");
      }
      if (destination === `${captures}.settlement.json` && !lateWrite) {
        const pending = (async () => {
          await Bun.sleep(2600);
          return await originalWrite(destination, data);
        })();
        lateWrite = pending;
        return pending;
      }
      return originalWrite(destination, data);
    }
  );
  const settlement = createCompletedJobFixtureSettlement();
  let cleanup = 0;
  const started = Date.now();
  try {
    await expect(
      captureCompletedJobFixtureCommand({
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: root,
        env: {},
        captures,
        timeoutMs: 5000,
        onUnconfirmed: settlement.markUnconfirmed,
      })
    ).rejects.toThrow("settlement refused");
    expect(Date.now() - started).toBeLessThan(2500);
    expect(lateWrite).toBeDefined();
    expect(await Bun.file(`${captures}.settlement.json`).exists()).toBe(false);
    expect(() => {
      settlement.assertConfirmed();
      cleanup += 1;
    }).toThrow("values omitted");
    expect(cleanup).toBe(0);
    await lateWrite;
    const receipt = JSON.parse(
      await Bun.file(`${captures}.settlement.json`).text()
    );
    expect(receipt.authority).toBe("observation-only");
    expect(receipt.completionRequires).toBe(
      "successful-return-and-live-settlement-gate"
    );
    expect(receipt.exitCode).toBe(0);
    expect(() => settlement.assertConfirmed()).toThrow("values omitted");
  } finally {
    await lateWrite?.catch(() => undefined);
    receipts.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("an exited leader with closed pipes receives zero former-group signals", async () => {
  const root = await mkdtemp(join(tmpdir(), "completed-job-exited-"));
  const ready = join(root, "ready");
  const originalKill = process.kill.bind(process),
    groups: number[] = [];
  const signals = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0 && signal !== 0) {
      groups.push(pid);
    }
    return originalKill(pid, signal);
  });
  let unconfirmed = false;
  try {
    await expect(
      captureCompletedJobFixtureInterrupt({
        argv: [
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(ready)},'ready');`,
        ],
        cwd: root,
        env: {},
        captures: join(root, "capture"),
        timeoutMs: 1000,
        beforeInterrupt: async () => {
          await waitForFile(ready);
          await Bun.sleep(80);
        },
        onUnconfirmed: () => {
          unconfirmed = true;
        },
      })
    ).rejects.toThrow("values omitted");
    expect(groups).toEqual([]);
    expect(unconfirmed).toBe(false);
  } finally {
    signals.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("inherited-pipe descendants withhold cancellation settlement without signaling a former group", async () => {
  const root = await mkdtemp(join(tmpdir(), "completed-job-descendant-"));
  const ready = join(root, "descendant");
  const descendant = `await Bun.write(${JSON.stringify(ready)},String(process.pid)); await Bun.sleep(650);`;
  const leader = `process.on('SIGINT',()=>process.exit(130)); const child=Bun.spawn([process.execPath,'-e',${JSON.stringify(descendant)}],{stdout:'inherit',stderr:'inherit'}); await child.exited;`;
  const originalKill = process.kill.bind(process),
    groups: number[] = [];
  const signals = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0 && signal !== 0) {
      groups.push(pid);
    }
    return originalKill(pid, signal);
  });
  let finished = false,
    unconfirmed = false,
    leaderPid = 0;
  let operation: Promise<void> | undefined;
  try {
    operation = captureCompletedJobFixtureInterrupt({
      argv: [process.execPath, "-e", leader],
      cwd: root,
      env: {},
      captures: join(root, "capture"),
      timeoutMs: 250,
      beforeInterrupt: async ({ pid }) => {
        leaderPid = pid;
        await waitForFile(ready);
      },
      onUnconfirmed: () => {
        unconfirmed = true;
      },
    });
    operation.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      }
    );
    await waitForFile(ready);
    const descendantPid = Number(await Bun.file(ready).text());
    expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
    expect(Number.isSafeInteger(leaderPid) && leaderPid > 0).toBe(true);
    await waitForAbsent(leaderPid);
    expect(finished).toBe(false);
    expect(absent(descendantPid)).toBe(false);
    await expect(operation).rejects.toThrow("deadline expired");
    await waitForAbsent(descendantPid);
    expect(groups).toEqual([]);
    expect(unconfirmed).toBe(false);
  } finally {
    await operation?.catch(() => undefined);
    signals.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("expired readiness is canceled and cannot deliver late SIGINT or release teardown", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "completed-job-delayed-readiness-")
  );
  const ready = join(root, "ready");
  const originalKill = ChildProcess.prototype.kill;
  const interrupts: number[] = [];
  const signals = spyOn(ChildProcess.prototype, "kill").mockImplementation(
    function (this: ChildProcess, signal) {
      if (signal === "SIGINT") {
        interrupts.push(Date.now());
      }
      return originalKill.call(this, signal);
    }
  );
  const settlement = createCompletedJobFixtureSettlement();
  let callback: Promise<void> | undefined;
  let callbackFinished = false;
  let callbackAborted = false;
  let cleanup = 0;
  let leaderPid = 0;
  try {
    await expect(
      captureCompletedJobFixtureInterrupt({
        argv: [
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(ready)},'ready'); await Bun.sleep(10_000);`,
        ],
        cwd: root,
        env: {},
        captures: join(root, "capture"),
        timeoutMs: 250,
        beforeInterrupt: ({ pid, signal }) => {
          leaderPid = pid;
          callback = (async () => {
            await waitForFile(ready);
            await Bun.sleep(700);
            callbackAborted = signal.aborted;
            callbackFinished = true;
          })();
          return callback;
        },
        onUnconfirmed: settlement.markUnconfirmed,
      })
    ).rejects.toThrow("deadline expired");
    expect(callbackFinished).toBe(false);
    expect(callback).toBeDefined();
    expect(leaderPid > 0).toBe(true);
    expect(absent(leaderPid)).toBe(true);
    expect(() => {
      settlement.assertConfirmed();
      cleanup += 1;
    }).toThrow("values omitted");
    expect(cleanup).toBe(0);
    await callback;
    expect(callbackAborted).toBe(true);
    expect(interrupts).toEqual([]);
    expect(() => settlement.assertConfirmed()).toThrow("values omitted");
  } finally {
    await callback?.catch(() => undefined);
    signals.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("real SIGINT exit and both EOFs settle without signaling the retired group", async () => {
  const root = await mkdtemp(join(tmpdir(), "completed-job-interrupt-"));
  const ready = join(root, "ready");
  const originalKill = process.kill.bind(process),
    groups: number[] = [];
  const signals = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0 && signal !== 0) {
      groups.push(pid);
    }
    return originalKill(pid, signal);
  });
  let unconfirmed = false;
  try {
    await captureCompletedJobFixtureInterrupt({
      argv: [
        process.execPath,
        "-e",
        `process.once('SIGINT',()=>process.exit(130)); await Bun.write(${JSON.stringify(ready)},'ready'); await Bun.sleep(10_000);`,
      ],
      cwd: root,
      env: {},
      captures: join(root, "capture"),
      timeoutMs: 1000,
      beforeInterrupt: async () => await waitForFile(ready),
      onUnconfirmed: () => {
        unconfirmed = true;
      },
    });
    expect(unconfirmed).toBe(false);
    expect(groups).toEqual([]);
  } finally {
    signals.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous final child absence retains ownership and blocks fixture teardown", async () => {
  const root = await mkdtemp(join(tmpdir(), "completed-job-ambiguous-"));
  const ready = join(root, "ready");
  const originalKill = process.kill.bind(process),
    groups: number[] = [];
  const signals = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === 0) {
      return true;
    }
    if (pid < 0 && signal !== 0) {
      groups.push(pid);
    }
    return originalKill(pid, signal);
  });
  let unconfirmed = false;
  try {
    await expect(
      captureCompletedJobFixtureInterrupt({
        argv: [
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(ready)},'ready');`,
        ],
        cwd: root,
        env: {},
        captures: join(root, "capture"),
        timeoutMs: 1000,
        beforeInterrupt: async () => {
          await waitForFile(ready);
          await Bun.sleep(80);
        },
        onUnconfirmed: () => {
          unconfirmed = true;
        },
      })
    ).rejects.toThrow("settlement refused");
    expect(unconfirmed).toBe(true);
    expect(groups).toEqual([]);
  } finally {
    signals.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("job fixture cleanup accepts only a complete original role/network/read-only mount", () => {
  expect(
    completedJobFixtureResource({
      instance: INSTANCE,
      image: IMAGE,
      kind: "container",
      row: CONTAINER,
    })
  ).toEqual({
    id: ID,
    service: "seed",
    networkId: NETWORK,
  });
});
test.each([
  { ...CONTAINER, id: "a".repeat(12) },
  { ...CONTAINER, image: `sha256:${"e".repeat(64)}` },
  { ...CONTAINER, service: "other" },
  { ...CONTAINER, oneoff: "True" },
  { ...CONTAINER, configFiles: "/different/docker-compose.yml" },
  { ...CONTAINER, nativeNames: ["io.hack.native-config.version"] },
  { ...CONTAINER, ports: undefined },
  { ...CONTAINER, publishAll: true },
  {
    ...CONTAINER,
    runtimePorts: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "15432" }] },
  },
  { ...CONTAINER, mounts: [{ ...CONTAINER.mounts[0], rw: true }] },
  {
    ...CONTAINER,
    mounts: [
      ...CONTAINER.mounts,
      { type: "volume", name: "anonymous", target: "/other", rw: true },
    ],
  },
  { ...CONTAINER, networks: [{ name: "foreign_default", id: NETWORK }] },
])("malformed/foreign/published cleanup observation is never authority %#", (row) => {
  expect(() =>
    completedJobFixtureResource({
      instance: INSTANCE,
      image: IMAGE,
      kind: "container",
      row,
    })
  ).toThrow("values omitted");
});
test("network and volume birth identities survive as exact cleanup facts", () => {
  expect(
    completedJobFixtureResource({
      instance: INSTANCE,
      image: IMAGE,
      kind: "network",
      row: {
        id: NETWORK,
        name: "completed-alpha_default",
        project: INSTANCE.name,
        nativeNames: [],
        createdAt: "2026-10-08T01:02:03Z",
        logical: "default",
        driver: "bridge",
        internal: false,
      },
    })
  ).toEqual({ id: NETWORK, createdAt: "2026-10-08T01:02:03Z" });
  expect(
    completedJobFixtureResource({
      instance: INSTANCE,
      image: IMAGE,
      kind: "volume",
      row: {
        name: "completed-alpha_data",
        project: INSTANCE.name,
        nativeNames: [],
        createdAt: "2026-10-08T01:02:03Z",
        storage: "data",
        driver: "local",
        options: null,
      },
    })
  ).toEqual({ id: "completed-alpha_data", createdAt: "2026-10-08T01:02:03Z" });
});
test("new exact job timestamp and exited-zero state qualify fixture readback", () => {
  expect(() =>
    completedJobFixtureFreshExit({
      id: ID,
      priorStartedAt: "2026-10-08T01:02:03Z",
      observed: STATE,
    })
  ).not.toThrow();
});
test.each([
  { ...STATE, id: "c".repeat(64) },
  { ...STATE, running: true, status: "running" },
  { ...STATE, exitCode: 17 },
  { ...STATE, startedAt: "2026-10-08T01:02:03.000Z" },
  { ...STATE, startedAt: "0001-01-01T00:00:00.000Z" },
  { ...STATE, finishedAt: "0001-01-01T00:00:00Z" },
])("old/failed/foreign job facts cannot satisfy real readback %#", (observed) => {
  expect(() =>
    completedJobFixtureFreshExit({
      id: ID,
      priorStartedAt: "2026-10-08T01:02:03Z",
      observed,
    })
  ).toThrow("values omitted");
});
test("same app instant permits equivalent spelling but a new dependent attempt refuses", () => {
  const before = { ...STATE, startedAt: "2026-10-08T01:02:03Z" };
  expect(() =>
    completedJobFixtureNoDependentStart({
      id: ID,
      before,
      after: { ...before, startedAt: "2026-10-08T01:02:03.000Z" },
    })
  ).not.toThrow();
  expect(() =>
    completedJobFixtureNoDependentStart({ id: ID, before, after: STATE })
  ).toThrow("values omitted");
  expect(() =>
    completedJobFixtureNoDependentStart({
      id: ID,
      before,
      after: { ...before, running: true },
    })
  ).toThrow("values omitted");
});
