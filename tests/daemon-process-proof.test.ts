import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DaemonProcessProbe,
  proveOwnedDaemonProcess,
  readDaemonPid,
  removeDaemonFilesIfStale,
  terminateProvenDaemon,
} from "../src/daemon/process.ts";

/**
 * HACK-2052: nothing signals a pid from the hackd pid file on liveness
 * alone, and stale-file cleanup never deletes a newer owner's files.
 */

let root: string;
const children: ReturnType<typeof Bun.spawn>[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-proof-"));
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  await rm(root, { recursive: true, force: true });
});

function spawnSleeper(): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn(["sleep", "30"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(child);
  return child;
}

function probe(
  overrides: Partial<DaemonProcessProbe> = {}
): DaemonProcessProbe {
  return {
    birth: () => Promise.resolve("Wed Nov 11 10:00:00 2026"),
    command: () =>
      Promise.resolve("/usr/local/bin/hack daemon start --foreground"),
    socketOwners: ({ pids }) => Promise.resolve(new Set(pids)),
    ...overrides,
  };
}

test("a pid file holding 0 or a negative value reads as no pid", async () => {
  const pidPath = join(root, "hackd.pid");
  for (const value of ["0", "-1", "-4242", "abc", "1.5e3x"]) {
    await writeFile(pidPath, `${value}\n`);
    const pid = await readDaemonPid({ pidPath });
    expect(pid === null || pid > 0).toBe(true);
  }
  await writeFile(pidPath, "0\n");
  expect(await readDaemonPid({ pidPath })).toBeNull();
  await writeFile(pidPath, "-4242\n");
  expect(await readDaemonPid({ pidPath })).toBeNull();
});

test("the proof refuses invalid pids, dead pids and this process", async () => {
  for (const pid of [0, -1, Number.NaN, process.pid]) {
    expect(
      await proveOwnedDaemonProcess({ pid, daemonRoot: root, probe: probe() })
    ).toEqual({ kind: "refused", reason: "invalid-pid" });
  }
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  expect(
    await proveOwnedDaemonProcess({
      pid: gone.pid,
      daemonRoot: root,
      probe: probe(),
    })
  ).toEqual({ kind: "refused", reason: "not-running" });
});

test("the proof refuses a live process that is not hackd (real observations)", async () => {
  const sleeper = spawnSleeper();
  expect(
    await proveOwnedDaemonProcess({ pid: sleeper.pid, daemonRoot: root })
  ).toEqual({ kind: "refused", reason: "not-hackd" });
});

test("the proof refuses another state root's hackd, unknown identity and a reused pid", async () => {
  const sleeper = spawnSleeper();
  const pid = sleeper.pid;
  expect(
    await proveOwnedDaemonProcess({
      pid,
      daemonRoot: root,
      probe: probe({ socketOwners: () => Promise.resolve(new Set<number>()) }),
    })
  ).toEqual({ kind: "refused", reason: "foreign-socket" });
  expect(
    await proveOwnedDaemonProcess({
      pid,
      daemonRoot: root,
      probe: probe({ socketOwners: () => Promise.resolve(null) }),
    })
  ).toEqual({ kind: "refused", reason: "identity-unknown" });
  expect(
    await proveOwnedDaemonProcess({
      pid,
      daemonRoot: root,
      probe: probe({ birth: () => Promise.resolve(null) }),
    })
  ).toEqual({ kind: "refused", reason: "identity-unknown" });
  let reads = 0;
  expect(
    await proveOwnedDaemonProcess({
      pid,
      daemonRoot: root,
      probe: probe({
        birth: () => {
          reads += 1;
          return Promise.resolve(reads === 1 ? "first" : "second");
        },
      }),
    })
  ).toEqual({ kind: "refused", reason: "identity-changed" });
  expect(
    await proveOwnedDaemonProcess({ pid, daemonRoot: root, probe: probe() })
  ).toEqual({ kind: "owned", pid, birth: "Wed Nov 11 10:00:00 2026" });
});

test.skipIf(!Bun.which("lsof"))(
  "the proof refuses a real hackd-like process that holds another root's socket",
  async () => {
    const foreignRoot = join(root, "foreign");
    const ownRoot = join(root, "own");
    await mkdir(foreignRoot);
    await mkdir(ownRoot);
    const binary = join(root, "hack-foreign-fixture");
    await symlink(process.execPath, binary);
    const socket = join(foreignRoot, "hackd.sock");
    const ready = join(foreignRoot, "ready");
    const child = Bun.spawn(
      [
        binary,
        "-e",
        `Bun.serve({ unix: ${JSON.stringify(socket)}, fetch() { return new Response("x"); } }); await Bun.write(${JSON.stringify(ready)}, "ready");`,
        "--",
        "daemon",
        "start",
        "--foreground",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    children.push(child);
    for (let i = 0; i < 100 && !(await Bun.file(ready).exists()); i++) {
      await Bun.sleep(20);
    }
    expect(
      await proveOwnedDaemonProcess({ pid: child.pid, daemonRoot: ownRoot })
    ).toEqual({ kind: "refused", reason: "foreign-socket" });
    const own = await proveOwnedDaemonProcess({
      pid: child.pid,
      daemonRoot: foreignRoot,
    });
    expect(own.kind).toBe("owned");
    expect(child.exitCode).toBeNull();
  },
  10_000
);

test("terminate does not signal a pid whose start time no longer matches", async () => {
  const sleeper = spawnSleeper();
  expect(
    await terminateProvenDaemon({
      proof: { pid: sleeper.pid, birth: "a different process" },
      probe: probe({ birth: () => Promise.resolve("the current process") }),
    })
  ).toBe(true);
  await Bun.sleep(100);
  expect(sleeper.exitCode).toBeNull();
  expect(process.kill(sleeper.pid, 0)).toBe(true);
});

test("terminate stops the proven process", async () => {
  const sleeper = spawnSleeper();
  expect(
    await terminateProvenDaemon({
      proof: { pid: sleeper.pid, birth: "same" },
      probe: probe({ birth: () => Promise.resolve("same") }),
    })
  ).toBe(true);
  await sleeper.exited;
  expect(sleeper.signalCode).toBe("SIGTERM");
});

test("stale cleanup keeps files a newer owner wrote", async () => {
  const pidPath = join(root, "hackd.pid");
  const socketPath = join(root, "hackd.sock");
  await writeFile(pidPath, "999999\n");
  await writeFile(socketPath, "");
  // Between observation (999999) and cleanup, a new start wrote its pid.
  const live = spawnSleeper();
  await writeFile(pidPath, `${live.pid}\n`);
  const result = await removeDaemonFilesIfStale({
    pidPath,
    socketPath,
    observedPid: 999_999,
    isAccepting: () => Promise.resolve(false),
  });
  expect(result).toEqual({
    removedPid: false,
    removedSocket: false,
    newerOwner: true,
  });
  expect((await readFile(pidPath, "utf8")).trim()).toBe(String(live.pid));
  expect(await Bun.file(socketPath).exists()).toBe(true);
});

test("stale cleanup keeps a socket that something accepts on", async () => {
  const pidPath = join(root, "hackd.pid");
  const socketPath = join(root, "hackd.sock");
  await writeFile(pidPath, "999999\n");
  const server = Bun.listen({
    unix: socketPath,
    socket: { data() {} },
  });
  try {
    const result = await removeDaemonFilesIfStale({
      pidPath,
      socketPath,
      observedPid: 999_999,
    });
    expect(result.newerOwner).toBe(true);
    expect(await Bun.file(pidPath).exists()).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("stale cleanup removes a dead pid and an unanswered socket", async () => {
  const pidPath = join(root, "hackd.pid");
  const socketPath = join(root, "hackd.sock");
  await writeFile(pidPath, "999999\n");
  await writeFile(socketPath, "");
  const result = await removeDaemonFilesIfStale({
    pidPath,
    socketPath,
    observedPid: 999_999,
  });
  expect(result).toEqual({
    removedPid: true,
    removedSocket: true,
    newerOwner: false,
  });
  expect(await Bun.file(pidPath).exists()).toBe(false);
  expect(await Bun.file(socketPath).exists()).toBe(false);
});
