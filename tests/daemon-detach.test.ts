import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
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
  const root = await mkdtemp(join(tmpdir(), "hack-daemon-detach-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
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

/** `ps` columns for one pid: process group, session and command line. */
async function readProcessIdentity(
  pid: number
): Promise<{ pgid: number; sid: number; args: string } | null> {
  const proc = Bun.spawn(["ps", "-o", "pgid=,sid=,args=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  const match = text.match(/^(\d+)\s+(\d+)\s+(.*)$/);
  if (!match) {
    return null;
  }
  return {
    pgid: Number(match[1]),
    sid: Number(match[2]),
    args: match[3] ?? "",
  };
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
        `hack daemon start >/dev/null 2>&1; : > ${JSON.stringify(started)}; exec sleep 120`,
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
    expect(ready).toBe(true);
    if (pid === null) {
      throw new Error("hackd pid file missing");
    }
    const daemonPid: number = pid;

    const identity = await readProcessIdentity(daemonPid);
    expect(identity?.args).toContain(DAEMON_COMMAND);
    // Own session and process group, led by hackd itself.
    expect(identity?.pgid).toBe(daemonPid);
    expect(identity?.sid).toBe(daemonPid);
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
