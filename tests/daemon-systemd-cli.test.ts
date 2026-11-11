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

/**
 * `hack daemon install|status|uninstall` on Linux through the source CLI,
 * with fake `systemctl` and `loginctl` first on PATH (HACK-2052).
 *
 * The fake keeps its state in the fixture: the unit lands in a temp
 * XDG_CONFIG_HOME, `start` runs the unit's ExecStart program in the
 * background (as systemd would), and `show` reports the hackd pid file as
 * MainPID. XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS are unset, so even a
 * real systemctl could not reach a user manager. Every hackd started here is
 * stopped through the fixture's own pid file.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const DAEMON_COMMAND = "daemon start --foreground";

const FAKE_SYSTEMCTL = `#!/bin/sh
state="$FAKE_SYSTEMD_STATE"
printf '%s\\n' "$*" >> "$state/calls.log"
unit="$XDG_CONFIG_HOME/systemd/user/hackd.service"
# Like systemd, the fake knows only the process it started (MainPID); a
# directly started hackd is not the unit's.
main="$state/mainpid"
alive() { [ -f "$main" ] && kill -0 "$(cat "$main")" 2>/dev/null; }
if [ -f "$state/no-bus" ]; then
  echo "Failed to connect to bus: No medium found" >&2
  exit 1
fi
[ "$1" = "--user" ] || { echo "fake systemctl: --user required" >&2; exit 2; }
shift
[ "$1" = "--no-pager" ] && shift
case "$1" in
  show)
    if [ "$2" = "--property=Version" ]; then echo "Version=255"; exit 0; fi
    if [ -f "$unit" ]; then echo LoadState=loaded; else echo LoadState=not-found; fi
    if [ -f "$state/enabled" ]; then echo UnitFileState=enabled; else echo UnitFileState=disabled; fi
    if alive; then echo ActiveState=active; echo "MainPID=$(cat "$main")"; else echo ActiveState=inactive; echo MainPID=0; fi
    exit 0 ;;
  daemon-reload|reset-failed) exit 0 ;;
  enable) : > "$state/enabled"; exit 0 ;;
  start|restart)
    if [ "$1" = start ] && alive; then exit 0; fi
    if [ "$1" = restart ] && alive; then kill "$(cat "$main")"; sleep 1; fi
    prog=$(sed -n 's/^ExecStart="\\([^"]*\\)".*/\\1/p' "$unit")
    "$prog" daemon start --foreground </dev/null >/dev/null 2>&1 &
    echo $! > "$main"
    exit 0 ;;
  stop)
    if [ -f "$state/stop-fails" ]; then echo "Job for hackd.service canceled." >&2; exit 1; fi
    alive && kill "$(cat "$main")"; exit 0 ;;
  disable)
    rm -f "$state/enabled"
    if [ "$2" = "--now" ] && alive; then kill "$(cat "$main")"; fi
    exit 0 ;;
esac
echo "fake systemctl: unsupported $*" >&2
exit 2
`;

const FAKE_LOGINCTL = `#!/bin/sh
echo no
`;

type Fixture = {
  readonly root: string;
  readonly home: string;
  readonly state: string;
  readonly unitPath: string;
  readonly hackBin: string;
  readonly env: Record<string, string>;
};

let fixture: Fixture | null = null;

afterEach(async () => {
  const current = fixture;
  fixture = null;
  if (current) {
    await stopOwnedDaemon(current);
    await rm(current.root, { recursive: true, force: true });
  }
});

async function writeExecutable(path: string, text: string): Promise<void> {
  await writeFile(path, text);
  await chmod(path, 0o755);
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "hack-systemd-cli-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const state = join(root, "fake-systemd");
  const config = join(root, "config");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(state, { recursive: true }),
  ]);
  const hackBin = join(bin, "hack");
  await writeExecutable(
    hackBin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO_ROOT, "index.ts"))} "$@"\n`
  );
  await writeExecutable(join(bin, "systemctl"), FAKE_SYSTEMCTL);
  await writeExecutable(join(bin, "loginctl"), FAKE_LOGINCTL);
  return {
    root,
    home,
    state,
    hackBin,
    unitPath: join(config, "systemd", "user", "hackd.service"),
    env: {
      HOME: home,
      XDG_CONFIG_HOME: config,
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: tmpdir(),
      FAKE_SYSTEMD_STATE: state,
      HACK_NO_INTERACTIVE: "1",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_LAUNCHD_DISABLE: "1",
      HACK_LOGGER: "console",
      NO_COLOR: "1",
      DOCKER_HOST: `unix://${join(root, "no-docker.sock")}`,
      DOCKER_CONFIG: join(root, "docker-config"),
    },
  };
}

async function hack(
  f: Fixture,
  args: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([f.hackBin, ...args], {
    env: f.env,
    cwd: f.root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function readOwnedPid(f: Fixture): Promise<number | null> {
  try {
    const raw = await readFile(
      join(f.home, ".hack", "daemon", "hackd.pid"),
      "utf8"
    );
    const pid = Number.parseInt(raw.trim(), 10);
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

async function commandLine(pid: number): Promise<string> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll(
      "\0",
      " "
    );
  } catch {
    return "";
  }
}

async function stopOwnedDaemon(f: Fixture): Promise<void> {
  const pid = await readOwnedPid(f);
  if (pid === null || !isAlive(pid)) {
    return;
  }
  if (!(await commandLine(pid)).includes(DAEMON_COMMAND)) {
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

async function calls(f: Fixture): Promise<string[]> {
  try {
    return (await readFile(join(f.state, "calls.log"), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

test.skipIf(process.platform !== "linux")(
  "install, status and uninstall drive systemctl --user and agree on ownership",
  async () => {
    fixture = await createFixture();
    const f = fixture;

    const before = await hack(f, ["daemon", "status", "--json"]);
    const beforeJson = JSON.parse(before.stdout) as Record<string, unknown>;
    expect(beforeJson.managed_by).toBeNull();
    expect(beforeJson.service).toMatchObject({
      manager: "systemd",
      installed: false,
      next_step: "hack daemon install",
    });

    const install = await hack(f, ["daemon", "install"]);
    const installOut = `${install.stdout}${install.stderr}`;
    expect(install.code).toBe(0);
    expect(installOut).toContain("Installed hackd.service");
    expect(installOut).toContain("hackd running under systemd");
    // Linger is reported with the exact command, never enabled for the user.
    expect(installOut).toContain("run: loginctl enable-linger");
    const unit = await readFile(f.unitPath, "utf8");
    expect(unit).toContain(
      `ExecStart="${f.hackBin}" daemon start --foreground`
    );
    expect(await calls(f)).toEqual(
      expect.arrayContaining([
        "--user daemon-reload",
        "--user enable hackd.service",
        "--user start hackd.service",
      ])
    );
    expect((await calls(f)).some((c) => c.includes("linger"))).toBe(false);

    const status = await hack(f, ["daemon", "status", "--json"]);
    const json = JSON.parse(status.stdout) as Record<string, unknown>;
    expect(json.status).toBe("running");
    expect(json.managed_by).toBe("systemd");
    expect(json.service).toMatchObject({
      manager: "systemd",
      installed: true,
      enabled: true,
      active: true,
      owns_daemon: true,
    });
    // Linger is off in the fake, so that is the remaining step, and the text
    // output names the same command.
    const serviceNextStep = (json.service as { next_step: unknown }).next_step;
    expect(serviceNextStep).toBe("loginctl enable-linger");
    const text = await hack(f, ["daemon", "status"]);
    expect(`${text.stdout}${text.stderr}`).toContain(`Run: ${serviceNextStep}`);

    // A second install leaves the unit alone.
    const again = await hack(f, ["daemon", "install"]);
    expect(`${again.stdout}${again.stderr}`).toContain("already installed");

    const pid = await readOwnedPid(f);
    const uninstall = await hack(f, ["daemon", "uninstall"]);
    expect(uninstall.code).toBe(0);
    expect(`${uninstall.stdout}${uninstall.stderr}`).toContain(
      "stopped, disabled and removed"
    );
    expect(await Bun.file(f.unitPath).exists()).toBe(false);
    expect(await calls(f)).toContain("--user disable --now hackd.service");
    if (pid !== null) {
      for (let i = 0; i < 50 && isAlive(pid); i++) {
        await Bun.sleep(100);
      }
      expect(isAlive(pid)).toBe(false);
    }
  },
  90_000
);

test.skipIf(process.platform !== "linux")(
  "without a user bus, install explains why, writes nothing and starts hackd detached",
  async () => {
    fixture = await createFixture();
    const f = fixture;
    await writeFile(join(f.state, "no-bus"), "");

    const install = await hack(f, ["daemon", "install"]);
    const out = `${install.stdout}${install.stderr}`;
    expect(install.code).toBe(1);
    expect(out).toContain("Cannot install the hackd systemd user service");
    expect(out).toContain("no systemd user session is reachable");
    expect(out).toContain("Starting hackd directly instead");
    expect(await Bun.file(f.unitPath).exists()).toBe(false);

    let pid: number | null = null;
    for (let i = 0; i < 100; i++) {
      pid = await readOwnedPid(f);
      if (pid !== null && isAlive(pid)) {
        break;
      }
      await Bun.sleep(100);
    }
    expect(pid).not.toBeNull();

    const status = await hack(f, ["daemon", "status", "--json"]);
    const json = JSON.parse(status.stdout) as Record<string, unknown>;
    expect(json.managed_by).toBeNull();
    expect(json.service).toMatchObject({
      manager: "systemd",
      available: false,
      next_step: null,
    });
  },
  90_000
);

test.skipIf(process.platform !== "linux")(
  "an isolated HACK_HOME refuses install before touching systemctl",
  async () => {
    fixture = await createFixture();
    const f = fixture;
    const isolated = {
      ...f,
      env: { ...f.env, HACK_HOME: join(f.root, "isolated") },
    };
    const refused = await hack(isolated, ["daemon", "install"]);
    expect(refused.code).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain(
      "systemd management is disabled for an isolated HACK_HOME"
    );
    expect(await calls(f)).toEqual([]);
    expect(await Bun.file(f.unitPath).exists()).toBe(false);
  },
  90_000
);

test.skipIf(process.platform !== "linux")(
  "install hands a directly started hackd over to systemd after proving it",
  async () => {
    fixture = await createFixture();
    const f = fixture;

    // A directly started hackd (no unit yet), detached as usual.
    const start = await hack(f, ["daemon", "start"]);
    let direct: number | null = null;
    for (let i = 0; i < 100; i++) {
      direct = await readOwnedPid(f);
      if (direct !== null && isAlive(direct)) {
        break;
      }
      await Bun.sleep(100);
    }
    expect(direct).not.toBeNull();
    const directPid = direct as number;
    expect(start.code === 0 || isAlive(directPid)).toBe(true);
    // Give it time to bind its socket so the ownership proof can see it.
    await Bun.sleep(500);

    const install = await hack(f, ["daemon", "install"]);
    const out = `${install.stdout}${install.stderr}`;
    expect(out).toContain(`Stopping directly started hackd (pid ${directPid})`);
    expect(out).toContain("hackd running under systemd");
    expect(install.code).toBe(0);

    for (let i = 0; i < 50 && isAlive(directPid); i++) {
      await Bun.sleep(100);
    }
    expect(isAlive(directPid)).toBe(false);
    const managed = await readOwnedPid(f);
    expect(managed).not.toBeNull();
    expect(managed).not.toBe(directPid);

    const status = JSON.parse(
      (await hack(f, ["daemon", "status", "--json"])).stdout
    ) as Record<string, unknown>;
    expect(status.managed_by).toBe("systemd");
    expect(status.pid).toBe(managed);
  },
  90_000
);

test.skipIf(process.platform !== "linux")(
  "stop fails, without signalling hackd, when systemctl stop fails",
  async () => {
    fixture = await createFixture();
    const f = fixture;
    expect((await hack(f, ["daemon", "install"])).code).toBe(0);
    const pid = await readOwnedPid(f);
    expect(pid).not.toBeNull();

    await writeFile(join(f.state, "stop-fails"), "");
    const stop = await hack(f, ["daemon", "stop"]);
    expect(stop.code).toBe(1);
    expect(`${stop.stdout}${stop.stderr}`).toContain(
      "systemctl --user stop hackd.service failed"
    );
    expect(isAlive(pid as number)).toBe(true);

    // Clean up through the manager once stop works again.
    await rm(join(f.state, "stop-fails"));
    expect((await hack(f, ["daemon", "uninstall"])).code).toBe(0);
  },
  90_000
);
