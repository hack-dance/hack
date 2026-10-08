import { expect, spyOn, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureCompletedJobFixtureInterrupt,
  completedJobFixtureAppAttempts,
  completedJobFixtureFreshExit,
  completedJobFixtureNoDependentStart,
  completedJobFixtureObject,
  completedJobFixtureResource,
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

test("an exited leader with closed pipes receives zero former-group signals", async () => {
  const root = await mkdtemp(join(tmpdir(), "completed-job-exited-"));
  const ready = join(root, "ready");
  const originalKill = process.kill.bind(process),
    groups: number[] = [];
  const signals = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0) {
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
    if (pid < 0) {
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
    function (signal) {
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
    if (pid < 0) {
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
    if (pid < 0) {
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
