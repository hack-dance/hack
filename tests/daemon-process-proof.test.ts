import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DaemonIdentityExpectation,
  type DaemonProcessProbe,
  findDaemonSocketOwnersFromProc,
  findOrphanDaemonProcesses,
  isHackDaemonImage,
  isHackDaemonProcess,
  type OwnedDaemonProof,
  proveOwnedDaemonProcess,
  readDaemonPid,
  removeDaemonFilesIfStale,
  terminateProvenDaemon,
} from "../src/daemon/process.ts";
import type { ProcessImage } from "../src/daemon/process-image.ts";
import { restoreEnv } from "./helpers/env.ts";
import { spawnHackdLikeFixture } from "./helpers/hackd-fixture.ts";

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

const BIRTH = "Wed Nov 11 10:00:00 2026";
const HACK_IMAGE: ProcessImage = {
  executable: "/usr/local/bin/hack",
  argv: ["/usr/local/bin/hack", "daemon", "start", "--foreground"],
};
const NO_ENTRIES: DaemonIdentityExpectation = { entryFiles: new Set() };

function probe(
  overrides: Partial<DaemonProcessProbe> = {}
): DaemonProcessProbe {
  return {
    birth: () => Promise.resolve(BIRTH),
    image: () => Promise.resolve(HACK_IMAGE),
    socketOwners: ({ pids }) => Promise.resolve(new Set(pids)),
    ...overrides,
  };
}

function ownedProof(pid: number, birth = BIRTH): OwnedDaemonProof {
  return { kind: "owned", pid, birth, image: HACK_IMAGE };
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
  ).toEqual(ownedProof(pid));
});

test.skipIf(process.platform !== "linux" && !Bun.which("lsof"))(
  "the proof refuses a real hackd-like process that holds another root's socket",
  async () => {
    const foreignRoot = join(root, "foreign");
    const ownRoot = join(root, "own");
    await mkdir(foreignRoot);
    await mkdir(ownRoot);
    const socket = join(foreignRoot, "hackd.sock");
    const ready = join(foreignRoot, "ready");
    const { child, expectation } = await spawnHackdLikeFixture({
      dir: root,
      socket,
      ready,
    });
    children.push(child);
    for (let i = 0; i < 100 && !(await Bun.file(ready).exists()); i++) {
      await Bun.sleep(20);
    }
    expect(
      await proveOwnedDaemonProcess({
        pid: child.pid,
        daemonRoot: ownRoot,
        expectation,
      })
    ).toEqual({ kind: "refused", reason: "foreign-socket" });
    const own = await proveOwnedDaemonProcess({
      pid: child.pid,
      daemonRoot: foreignRoot,
      expectation,
    });
    expect(own.kind).toBe("owned");
    // The same process is not this CLI's daemon when its entry file is not
    // this checkout's (`bun /other/index.ts daemon start --foreground`).
    expect(
      await proveOwnedDaemonProcess({
        pid: child.pid,
        daemonRoot: foreignRoot,
        expectation: NO_ENTRIES,
      })
    ).toEqual({ kind: "refused", reason: "not-hackd" });
    expect(child.exitCode).toBeNull();
  },
  10_000
);

test("terminate does not signal a pid whose start time no longer matches", async () => {
  const sleeper = spawnSleeper();
  expect(
    await terminateProvenDaemon({
      proof: ownedProof(sleeper.pid, "a different process"),
      daemonRoot: root,
      probe: probe({ birth: () => Promise.resolve("the current process") }),
    })
  ).toEqual({ kind: "exited" });
  await Bun.sleep(100);
  expect(sleeper.exitCode).toBeNull();
  expect(process.kill(sleeper.pid, 0)).toBe(true);
});

test("terminate stops the proven process", async () => {
  const sleeper = spawnSleeper();
  expect(
    await terminateProvenDaemon({
      proof: ownedProof(sleeper.pid),
      daemonRoot: root,
      probe: probe(),
    })
  ).toEqual({ kind: "exited" });
  await sleeper.exited;
  expect(sleeper.signalCode).toBe("SIGTERM");
});

test("terminate does not signal a process that exec'd another program (same pid and start time)", async () => {
  // Review r2 #2: exec keeps the pid and start time; only the image shows
  // the change. Not hackd any more, or hackd with other arguments.
  const replaced: readonly ProcessImage[] = [
    { executable: "/usr/bin/python3", argv: ["python3", "-c", "pass"] },
    {
      executable: "/usr/local/bin/hack",
      argv: [
        "/usr/local/bin/hack",
        "--no-interactive",
        "daemon",
        "start",
        "--foreground",
      ],
    },
  ];
  for (const image of replaced) {
    const sleeper = spawnSleeper();
    const signals: string[] = [];
    expect(
      await terminateProvenDaemon({
        proof: ownedProof(sleeper.pid),
        daemonRoot: root,
        probe: probe({ image: () => Promise.resolve(image) }),
        sendSignal: (_pid, signal) => {
          signals.push(signal);
        },
      })
    ).toEqual({ kind: "not-confirmed", reason: "changed" });
    expect(signals).toEqual([]);
    expect(process.kill(sleeper.pid, 0)).toBe(true);
  }
});

test("terminate re-proves identity before SIGKILL too", async () => {
  const sleeper = spawnSleeper();
  let images = 0;
  const signals: string[] = [];
  const termination = await terminateProvenDaemon({
    proof: ownedProof(sleeper.pid),
    daemonRoot: root,
    timeoutMs: 100,
    probe: probe({
      // Proven before SIGTERM; another program by the SIGKILL check.
      image: () => {
        images += 1;
        return Promise.resolve(
          images === 1
            ? HACK_IMAGE
            : { executable: "/usr/bin/vim", argv: ["vim"] }
        );
      },
    }),
    // SIGTERM is "ignored": nothing is delivered.
    sendSignal: (_pid, signal) => {
      signals.push(signal);
    },
  });
  expect(termination).toEqual({ kind: "not-confirmed", reason: "changed" });
  expect(signals).toEqual(["SIGTERM"]);
  expect(process.kill(sleeper.pid, 0)).toBe(true);
});

test("terminate reports a hackd that survives SIGKILL as still running", async () => {
  const sleeper = spawnSleeper();
  const signals: string[] = [];
  expect(
    await terminateProvenDaemon({
      proof: ownedProof(sleeper.pid),
      daemonRoot: root,
      timeoutMs: 100,
      killTimeoutMs: 100,
      probe: probe(),
      sendSignal: (_pid, signal) => {
        signals.push(signal);
      },
    })
  ).toEqual({ kind: "not-confirmed", reason: "still-running" });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("terminate does not signal when identity cannot be read again", async () => {
  const sleeper = spawnSleeper();
  const signals: string[] = [];
  expect(
    await terminateProvenDaemon({
      proof: ownedProof(sleeper.pid),
      daemonRoot: root,
      probe: probe({ image: () => Promise.resolve(null) }),
      sendSignal: (_pid, signal) => {
        signals.push(signal);
      },
    })
  ).toEqual({ kind: "not-confirmed", reason: "identity-unknown" });
  expect(signals).toEqual([]);
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

test("stale cleanup keeps the socket when a starter writes a new pid file during cleanup", async () => {
  // Review r2 #3: the pid file changed after the first checks; the socket
  // now belongs to the new starter.
  const pidPath = join(root, "hackd.pid");
  const socketPath = join(root, "hackd.sock");
  await writeFile(pidPath, "999999\n");
  await writeFile(socketPath, "");
  const live = spawnSleeper();
  const result = await removeDaemonFilesIfStale({
    pidPath,
    socketPath,
    observedPid: 999_999,
    isAccepting: () => Promise.resolve(false),
    beforeRemove: async () => {
      await writeFile(pidPath, `${live.pid}\n`);
    },
  });
  expect(result).toEqual({
    removedPid: false,
    removedSocket: false,
    newerOwner: true,
  });
  expect((await readFile(pidPath, "utf8")).trim()).toBe(String(live.pid));
  expect(await Bun.file(socketPath).exists()).toBe(true);
});

test("stale cleanup keeps a socket that was replaced during cleanup", async () => {
  const pidPath = join(root, "hackd.pid");
  const socketPath = join(root, "hackd.sock");
  await writeFile(socketPath, "old");
  const result = await removeDaemonFilesIfStale({
    pidPath,
    socketPath,
    observedPid: null,
    isAccepting: () => Promise.resolve(false),
    beforeRemove: async () => {
      // A starter replaced the socket with a new directory entry (written
      // first, so it has its own inode).
      await writeFile(`${socketPath}.next`, "new");
      await rename(`${socketPath}.next`, socketPath);
    },
  });
  expect(result).toEqual({
    removedPid: false,
    removedSocket: false,
    newerOwner: true,
  });
  expect(await readFile(socketPath, "utf8")).toBe("new");
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
): Promise<Awaited<ReturnType<typeof spawnHackdLikeFixture>>> {
  const socket = join(socketRoot, "hackd.sock");
  const ready = join(socketRoot, "ready");
  const fixture = await spawnHackdLikeFixture({ dir: root, socket, ready });
  children.push(fixture.child);
  for (let i = 0; i < 100 && !(await Bun.file(ready).exists()); i++) {
    await Bun.sleep(20);
  }
  return fixture;
}

test.skipIf(process.platform !== "linux")(
  "Linux socket ownership comes from /proc without lsof",
  async () => {
    const ownRoot = join(root, "own");
    const otherRoot = join(root, "other");
    await mkdir(ownRoot);
    await mkdir(otherRoot);
    const { child } = await startForeignFixture(ownRoot);
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

test("the identity rule uses the resolved executable and exact argv", () => {
  const entry = "/src/hack repo/index.ts";
  const expectation: DaemonIdentityExpectation = {
    entryFiles: new Set([entry]),
  };
  const matches = (image: ProcessImage) =>
    isHackDaemonImage({ image, expectation });
  const daemonArgs = ["daemon", "start", "--foreground"];
  // A Hack binary, spaces in its path included.
  expect(
    matches({
      executable: "/opt/My Tools/bin/hack",
      argv: ["/opt/My Tools/bin/hack", ...daemonArgs],
    })
  ).toBe(true);
  // This checkout's entry under bun.
  expect(
    matches({
      executable: "/opt/bun/bin/bun",
      argv: ["bun", entry, ...daemonArgs],
    })
  ).toBe(true);
  // Review r2 #1: another program, whatever its arguments say.
  expect(
    matches({
      executable: "/usr/bin/python3",
      argv: ["/usr/bin/python3", "/tmp/hack-fixture", ...daemonArgs],
    })
  ).toBe(false);
  // A script named `hack` resolves to its interpreter.
  expect(
    matches({
      executable: "/usr/bin/dash",
      argv: ["/bin/sh", "/usr/local/bin/hack", ...daemonArgs],
    })
  ).toBe(false);
  // Another checkout's entry.
  expect(
    matches({
      executable: "/usr/bin/bun",
      argv: ["bun", "/other/index.ts", ...daemonArgs],
    })
  ).toBe(false);
  expect(
    matches({ executable: "/usr/bin/sleep", argv: ["/usr/bin/sleep", "30"] })
  ).toBe(false);
});

test("hackd command lines are recognized with options in any supported position", () => {
  const hack = "/usr/local/bin/hack";
  const entry = "/src/hack/index.ts";
  const expectation: DaemonIdentityExpectation = {
    entryFiles: new Set([entry]),
  };
  const matches = (executable: string, argv: readonly string[]) =>
    isHackDaemonImage({ image: { executable, argv }, expectation });
  // The CLI parser accepts these placements (all options here are boolean).
  const placements: readonly (readonly string[])[] = [
    ["daemon", "start", "--no-interactive", "--foreground"],
    ["daemon", "start", "--foreground", "--no-interactive"],
    ["--no-interactive", "daemon", "start", "--foreground"],
    ["daemon", "--foreground", "start"],
    ["--foreground", "daemon", "start"],
  ];
  for (const args of placements) {
    expect(matches(hack, [hack, ...args])).toBe(true);
    expect(matches("/usr/bin/bun", ["bun", entry, ...args])).toBe(true);
  }
  // Not a foreground daemon: no --foreground, other positionals.
  expect(matches(hack, [hack, "daemon", "start"])).toBe(false);
  expect(matches(hack, [hack, "daemon", "stop", "--foreground"])).toBe(false);
  expect(matches(hack, [hack, "up", "daemon", "start", "--foreground"])).toBe(
    false
  );
});

test.skipIf(process.platform !== "linux")(
  "a script named hack that runs another interpreter is not hackd (real observations)",
  async () => {
    const script = join(root, "hack");
    // `: ` after sleep keeps the shell from exec-ing sleep as its last command.
    await writeFile(script, "#!/bin/sh\nsleep 30\n:\n", { mode: 0o755 });
    // The kernel runs the script's interpreter; argv names a `hack`.
    const child = Bun.spawn([script, "daemon", "start", "--foreground"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    children.push(child);
    await Bun.sleep(100);
    expect(await isHackDaemonProcess({ pid: child.pid })).toBe(false);
    expect(
      await proveOwnedDaemonProcess({ pid: child.pid, daemonRoot: root })
    ).toEqual({ kind: "refused", reason: "not-hackd" });
  }
);

test("an unreadable command line is unknown identity, not 'not hackd'", async () => {
  const sleeper = spawnSleeper();
  expect(
    await proveOwnedDaemonProcess({
      pid: sleeper.pid,
      daemonRoot: root,
      probe: probe({ image: () => Promise.resolve(null) }),
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
    const { child, expectation } = await startForeignFixture(ownRoot);
    const own = await findOrphanDaemonProcesses({
      trackedPid: null,
      daemonRoot: ownRoot,
      expectation,
    });
    expect(own.orphans.map((orphan) => orphan.pid)).toContain(child.pid);
    const other = await findOrphanDaemonProcesses({
      trackedPid: null,
      daemonRoot: otherRoot,
      expectation,
    });
    expect(other.orphans.map((orphan) => orphan.pid)).not.toContain(child.pid);
    expect(other.refused).toContainEqual({
      pid: child.pid,
      reason: "foreign-socket",
    });
    expect(child.exitCode).toBeNull();
  },
  10_000
);
