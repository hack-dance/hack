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
  findDaemonSocketOwnersFromProc,
  findOrphanDaemonProcesses,
  isHackDaemonCommandLine,
  isHackDaemonProcess,
  proveOwnedDaemonProcess,
  readDaemonPid,
  removeDaemonFilesIfStale,
  terminateProvenDaemon,
} from "../src/daemon/process.ts";
import { restoreEnv } from "./helpers/env.ts";

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

/**
 * Runs `fn` with these process.env values, restoring each key afterwards.
 * Saves and restores one key at a time, so no copy of the runner's
 * environment or HOME is made.
 */
async function withCliEnv(
  values: Readonly<Record<string, string>>,
  fn: () => Promise<void>
): Promise<void> {
  const keys = Object.keys(values);
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) {
    process.env[key] = values[key];
  }
  try {
    await fn();
  } finally {
    keys.forEach((key, index) => {
      restoreEnv(key, previous[index]);
    });
  }
}

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

test.skipIf(process.platform !== "linux" && !Bun.which("lsof"))(
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

async function startForeignFixture(
  socketRoot: string
): Promise<ReturnType<typeof Bun.spawn>> {
  const binary = join(root, "hack-fixture");
  await symlink(process.execPath, binary).catch(() => undefined);
  const socket = join(socketRoot, "hackd.sock");
  const ready = join(socketRoot, "ready");
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
  return child;
}

test.skipIf(process.platform !== "linux")(
  "Linux socket ownership comes from /proc without lsof",
  async () => {
    const ownRoot = join(root, "own");
    const otherRoot = join(root, "other");
    await mkdir(ownRoot);
    await mkdir(otherRoot);
    const child = await startForeignFixture(ownRoot);
    const sleeper = spawnSleeper();
    const owners = await findDaemonSocketOwnersFromProc({
      daemonRoot: ownRoot,
      pids: [child.pid, sleeper.pid],
    });
    expect(owners).toEqual(new Set([child.pid]));
    expect(
      await findDaemonSocketOwnersFromProc({
        daemonRoot: otherRoot,
        pids: [child.pid],
      })
    ).toEqual(new Set());
  },
  10_000
);

test("a live pid that is not hackd is not treated as a running daemon", async () => {
  const sleeper = spawnSleeper();
  expect(await isHackDaemonProcess({ pid: sleeper.pid })).toBe(false);
  expect(
    await isHackDaemonProcess({
      pid: sleeper.pid,
      probe: probe(),
    })
  ).toBe(true);
  // Its pid file is stale although the pid runs (a reused pid after reboot).
  const pidPath = join(root, "hackd.pid");
  const socketPath = join(root, "hackd.sock");
  await writeFile(pidPath, `${sleeper.pid}\n`);
  expect(
    (
      await removeDaemonFilesIfStale({
        pidPath,
        socketPath,
        observedPid: sleeper.pid,
      })
    ).newerOwner
  ).toBe(true);
  expect(
    await removeDaemonFilesIfStale({
      pidPath,
      socketPath,
      observedPid: sleeper.pid,
      observedPidIsDaemon: false,
    })
  ).toEqual({ removedPid: true, removedSocket: false, newerOwner: false });
  expect(sleeper.exitCode).toBeNull();
});

test("hack daemon stop leaves a non-hackd pid alone and removes the stale pid file", async () => {
  const sleeper = spawnSleeper();
  const home = join(root, "home");
  const daemonDir = join(home, ".hack", "daemon");
  await mkdir(daemonDir, { recursive: true });
  await writeFile(join(daemonDir, "hackd.pid"), `${sleeper.pid}\n`);
  await withCliEnv({ HOME: home, HACK_LOGGER: "console" }, async () => {
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["daemon", "stop"])).toBe(0);
    expect(await Bun.file(join(daemonDir, "hackd.pid")).exists()).toBe(false);
  });
  await Bun.sleep(100);
  expect(sleeper.exitCode).toBeNull();
  expect(process.kill(sleeper.pid, 0)).toBe(true);
});

test("a detached hackd does not inherit doctor's read-only service flag", async () => {
  const out = join(root, "env-out");
  const saved = process.env.HACK_DAEMON_SERVICE_READ_ONLY;
  process.env.HACK_DAEMON_SERVICE_READ_ONLY = "1";
  try {
    const { spawnDetachedDaemon } = await import("../src/daemon/spawn.ts");
    spawnDetachedDaemon({
      argv: [
        "/bin/sh",
        "-c",
        `printf '%s' "\${HACK_DAEMON_SERVICE_READ_ONLY:-unset}" > ${JSON.stringify(out)}`,
      ],
    });
  } finally {
    restoreEnv("HACK_DAEMON_SERVICE_READ_ONLY", saved);
  }
  for (let i = 0; i < 100 && !(await Bun.file(out).exists()); i++) {
    await Bun.sleep(20);
  }
  await Bun.sleep(50);
  expect(await readFile(out, "utf8")).toBe("unset");
});

test("/proc parsing matches a daemon socket path that contains a space", async () => {
  const proc = join(root, "proc");
  // Runs of spaces must survive: the kernel prints the path verbatim.
  const daemonRoot = join(root, "a  home", ".hack", "daemon");
  await mkdir(join(proc, "net"), { recursive: true });
  await mkdir(join(proc, "4242", "fd"), { recursive: true });
  await mkdir(daemonRoot, { recursive: true });
  await writeFile(
    join(proc, "net", "unix"),
    [
      "Num       RefCount Protocol Flags    Type St Inode Path",
      `0000000000000000: 00000002 00000000 00010000 0001 01 777 ${join(daemonRoot, "hackd.sock")}`,
      "",
    ].join("\n")
  );
  await symlink("socket:[777]", join(proc, "4242", "fd", "3"));
  expect(
    await findDaemonSocketOwnersFromProc({
      daemonRoot,
      pids: [4242],
      procRoot: proc,
    })
  ).toEqual(new Set([4242]));
});

test("the proof waits briefly for a hackd that has not bound its socket yet", async () => {
  const sleeper = spawnSleeper();
  let calls = 0;
  const proof = await proveOwnedDaemonProcess({
    pid: sleeper.pid,
    daemonRoot: root,
    probe: probe({
      socketOwners: ({ pids }) => {
        calls += 1;
        return Promise.resolve(calls < 3 ? new Set<number>() : new Set(pids));
      },
    }),
  });
  expect(proof.kind).toBe("owned");
  expect(calls).toBe(3);
  expect(
    await proveOwnedDaemonProcess({
      pid: sleeper.pid,
      daemonRoot: root,
      socketRetries: 0,
      probe: probe({ socketOwners: () => Promise.resolve(new Set<number>()) }),
    })
  ).toEqual({ kind: "refused", reason: "foreign-socket" });
});

test("hack daemon restart replaces a stale pid file without signalling its pid", async () => {
  const sleeper = spawnSleeper();
  const home = join(root, "home");
  const daemonDir = join(home, ".hack", "daemon");
  await mkdir(daemonDir, { recursive: true });
  // The pid is not hackd: stop leaves it alone and drops the stale pid
  // file, then start spawns a daemon. HACK_MCP_COMMAND points that spawn at
  // /bin/false, so no real hackd starts (and start reports not ready).
  await writeFile(join(daemonDir, "hackd.pid"), `${sleeper.pid}\n`);
  await withCliEnv(
    {
      HOME: home,
      HACK_LOGGER: "console",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_MCP_COMMAND: "/bin/false",
    },
    async () => {
      const { runCli } = await import("../src/cli/run.ts");
      expect(await runCli(["daemon", "restart"])).toBe(1);
      expect(await Bun.file(join(daemonDir, "hackd.pid")).exists()).toBe(false);
    }
  );
  expect(sleeper.exitCode).toBeNull();
  expect(process.kill(sleeper.pid, 0)).toBe(true);
}, 20_000);

test("hackd command lines with spaces in the executable path are recognized", () => {
  const spaced = "/opt/My Tools/bin/hack";
  // argv (Linux /proc/<pid>/cmdline): exact boundaries.
  expect(
    isHackDaemonCommandLine([spaced, "daemon", "start", "--foreground"])
  ).toBe(true);
  expect(
    isHackDaemonCommandLine([
      "/usr/bin/bun",
      "/src/hack repo/index.ts",
      "daemon",
      "start",
      "--foreground",
    ])
  ).toBe(true);
  expect(
    isHackDaemonCommandLine(["/usr/bin/vim", "daemon", "start", "--foreground"])
  ).toBe(false);
  expect(isHackDaemonCommandLine(["/usr/bin/sleep", "30"])).toBe(false);
  // ps output: boundaries lost, the executable is the prefix.
  expect(isHackDaemonCommandLine(`${spaced} daemon start --foreground`)).toBe(
    true
  );
  expect(
    isHackDaemonCommandLine("/usr/local/bin/hack daemon start --foreground")
  ).toBe(true);
  expect(isHackDaemonCommandLine("/opt/notes daemon start --foreground")).toBe(
    false
  );
  expect(isHackDaemonCommandLine("sleep 30")).toBe(false);
});

test("an unreadable command line is unknown identity, not 'not hackd'", async () => {
  const sleeper = spawnSleeper();
  expect(
    await proveOwnedDaemonProcess({
      pid: sleeper.pid,
      daemonRoot: root,
      probe: probe({ command: () => Promise.resolve(null) }),
    })
  ).toEqual({ kind: "refused", reason: "identity-unknown" });
});

test.skipIf(process.platform !== "linux")(
  "the orphan sweep finds a socket-holding hackd through /proc",
  async () => {
    const ownRoot = join(root, "own-orphan");
    const otherRoot = join(root, "other-orphan");
    await mkdir(ownRoot);
    await mkdir(otherRoot);
    const child = await startForeignFixture(ownRoot);
    expect(
      await findOrphanDaemonProcesses({ trackedPid: null, daemonRoot: ownRoot })
    ).toContain(child.pid);
    expect(
      await findOrphanDaemonProcesses({
        trackedPid: null,
        daemonRoot: otherRoot,
      })
    ).not.toContain(child.pid);
    expect(child.exitCode).toBeNull();
  },
  10_000
);
