import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { probeDaemonApi } from "../src/daemon/client.ts";

/**
 * HACK-2052 regression: `hack daemon start` must leave hackd in its own
 * session and process group, so killing the caller's process group (what an
 * agent harness or a closing terminal does) does not take hackd with it.
 *
 * Runs the source CLI through a `hack` wrapper on PATH, in a private HOME,
 * with systemd/launchd management and autostart disabled and Docker pointed
 * at a dead socket. It stops only the hackd recorded in its own pid file.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const DAEMON_COMMAND = "daemon start --foreground";
const PS_LINE = /^(\d+)\s+(.*)$/;

type Fixture = {
  readonly root: string;
  readonly home: string;
  readonly env: Record<string, string>;
};

let fixture: Fixture | null = null;
let launcher: ReturnType<typeof Bun.spawn> | null = null;

afterEach(async () => {
  const current = fixture;
  fixture = null;
  if (launcher) {
    killGroup(launcher.pid, "SIGKILL");
    await launcher.exited;
    launcher = null;
  }
  if (current) {
    await stopOwnedDaemon(current);
    await rm(current.root, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<Fixture> {
  // Under /tmp, not the macOS per-user TMPDIR: hackd's socket paths must fit
  // the 104-byte sun_path limit there.
  const root = await mkdtemp(join(await realpath("/tmp"), "hack-dd-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  // hackd refuses a state directory under a group-writable parent; hold
  // whatever the runner's umask.
  await chmod(home, 0o755);
  const wrapper = join(bin, "hack");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO_ROOT, "index.ts"))} "$@"\n`
  );
  await chmod(wrapper, 0o755);
  return {
    root,
    home,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: tmpdir(),
      HACK_NO_INTERACTIVE: "1",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_SYSTEMD_DISABLE: "1",
      HACK_LAUNCHD_DISABLE: "1",
      HACK_LOGGER: "console",
      DOCKER_HOST: `unix://${join(root, "no-docker.sock")}`,
      DOCKER_CONFIG: join(root, "docker-config"),
    },
  };
}

function daemonDir(f: Fixture): string {
  return join(f.home, ".hack", "daemon");
}

async function readOwnedPid(f: Fixture): Promise<number | null> {
  try {
    const raw = (
      await readFile(join(daemonDir(f), "hackd.pid"), "utf8")
    ).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Process group (all platforms, through `ps -o pgid=`) and session (Linux
 * only, from `/proc/<pid>/stat`; BSD `ps` has no `sid` keyword) for one pid.
 */
async function readProcessIdentity(
  pid: number
): Promise<{ pgid: number; sid: number | null; args: string } | null> {
  const proc = Bun.spawn(["ps", "-o", "pgid=,args=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  const match = text.match(PS_LINE);
  if (!match) {
    return null;
  }
  return {
    pgid: Number(match[1]),
    sid: await readLinuxSessionId(pid),
    args: match[2] ?? "",
  };
}

async function readLinuxSessionId(pid: number): Promise<number | null> {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // Fields after the parenthesized command: state ppid pgrp session ...
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[3]);
  } catch {
    return null;
  }
}

/**
 * Stops only the hackd this fixture started: the pid comes from the
 * fixture's own pid file and its command line must be a foreground daemon.
 */
async function stopOwnedDaemon(f: Fixture): Promise<void> {
  const pid = await readOwnedPid(f);
  if (pid === null || !isAlive(pid)) {
    return;
  }
  const identity = await readProcessIdentity(pid);
  if (!identity?.args.includes(DAEMON_COMMAND)) {
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && isAlive(pid); i++) {
    await Bun.sleep(100);
  }
  if (isAlive(pid)) {
    process.kill(pid, "SIGKILL");
  }
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await Bun.sleep(100);
  }
  return await check();
}

test.skipIf(process.platform === "win32")(
  "hackd survives the death of the process group that ran `hack daemon start`",
  async () => {
    fixture = await createFixture();
    const f = fixture;
    const started = join(f.root, "started");
    // The launcher leads its own process group (detached), standing in for
    // an agent harness or terminal session. It stays alive after the start
    // so the daemon would still be in its group without the fix.
    launcher = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        `hack daemon start >${JSON.stringify(join(f.root, "start.log"))} 2>&1; : > ${JSON.stringify(started)}; exec sleep 120`,
      ],
      {
        env: f.env,
        cwd: f.root,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      }
    );
    const launcherPgid = launcher.pid;

    expect(await waitFor(() => Bun.file(started).exists(), 30_000)).toBe(true);
    const socketPath = join(daemonDir(f), "hackd.sock");
    let pid: number | null = null;
    const ready = await waitFor(async () => {
      pid = await readOwnedPid(f);
      if (pid === null || !isAlive(pid)) {
        return false;
      }
      return (await probeDaemonApi({ socketPath, timeoutMs: 500 })).reachable;
    }, 20_000);
    if (!ready) {
      // Say why on CI (macOS has no local reproduction): what `hack daemon
      // start` printed and what hackd logged.
      const startLog = await readFile(join(f.root, "start.log"), "utf8").catch(
        () => "(no start output)"
      );
      const hackdLog = await readFile(
        join(daemonDir(f), "hackd.log"),
        "utf8"
      ).catch(() => "(no hackd.log)");
      throw new Error(
        `hackd did not become ready (pid ${pid}).\n--- hack daemon start ---\n${startLog.slice(-4000)}\n--- hackd.log ---\n${hackdLog.slice(-4000)}`
      );
    }
    // The unauthenticated API stays private to its owner (Codex security
    // review): the daemon directory is 0700 and the socket 0600.
    expect((await stat(daemonDir(f))).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    if (pid === null) {
      throw new Error("hackd pid file missing");
    }
    const daemonPid: number = pid;

    const identity = await readProcessIdentity(daemonPid);
    expect(identity?.args).toContain(DAEMON_COMMAND);
    // Own session and process group, led by hackd itself.
    expect(identity?.pgid).toBe(daemonPid);
    if (process.platform === "linux") {
      expect(identity?.sid).toBe(daemonPid);
    }
    expect(identity?.pgid).not.toBe(launcherPgid);

    killGroup(launcherPgid, "SIGKILL");
    await launcher.exited;
    launcher = null;
    await Bun.sleep(500);

    expect(isAlive(daemonPid)).toBe(true);
    const probe = await probeDaemonApi({ socketPath, timeoutMs: 2000 });
    expect(probe.reachable).toBe(true);
  },
  90_000
);
