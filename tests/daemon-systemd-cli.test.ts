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
import { CLI_COMPILE_DEFINE_ARGS } from "../scripts/lib/cli-compile-define.ts";

import {
  checkServicePathDirectories,
  RENDERED_SYSTEM_PATH_DIRECTORIES,
  UNSET_PATH_LOOKUP_DIRS,
} from "../src/daemon/systemd.ts";
import { spawnSyncBounded } from "./helpers/bounded-spawn-sync.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

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
    if [ "$2" = "--property=UnitPath" ]; then echo "UnitPath=$XDG_CONFIG_HOME/systemd/user"; exit 0; fi
    if [ -f "$unit" ]; then echo LoadState=loaded; echo "FragmentPath=$unit"; else echo LoadState=not-found; fi
    if [ -f "$unit" ]; then p=$(sed -n 's/^ExecStart="\\([^"]*\\)".*/\\1/p' "$unit"); echo "ExecStart={ path=$p ; argv[]=$p daemon start --foreground ; ignore_errors=no }"; fi
    echo DropInPaths=
    if [ -f "$state/enabled" ]; then echo UnitFileState=enabled; else echo UnitFileState=disabled; fi
    if alive; then echo ActiveState=active; echo "MainPID=$(cat "$main")"; else echo ActiveState=inactive; echo MainPID=0; fi
    # The fake's processes are not in a hackd.service cgroup; a running
    # unit reports one anyway, as systemd does.
    if alive; then echo ControlGroup=/fake.slice/hackd.service; else echo ControlGroup=; fi
    exit 0 ;;
  show-environment) echo "HOME=$HOME"; exit 0 ;;
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

/**
 * These flows run the real CLI, which checks the host's own system PATH
 * directories before it installs or starts the unit. Hosts whose system
 * directories (or what /usr/bin links into) others can write, such as
 * GitHub's Ubuntu runner image, make the CLI refuse, as it should; the
 * flows then cannot be exercised there, and the in-process tests in
 * daemon-systemd.test.ts cover the same logic with their own directories
 * (HACK-2142). Null when this host's system PATH is safe.
 */
const hostSystemPathProblem =
  process.platform === "linux"
    ? await checkServicePathDirectories({
        dirs: [...RENDERED_SYSTEM_PATH_DIRECTORIES, ...UNSET_PATH_LOOKUP_DIRS],
      })
    : null;
if (
  hostSystemPathProblem !== null &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.HACK_TEST_REQUIRE_INSTALL_FLOWS !== "1"
) {
  console.warn(
    `daemon-systemd-cli: skipping the install flows on this host: ${hostSystemPathProblem}`
  );
}
// Skipped only on GitHub Actions, whose image is known to fail the check;
// on any other host a refusal fails these flows instead of hiding a
// regression in the check itself (HACK-2142).
// HACK_TEST_REQUIRE_INSTALL_FLOWS=1 (the hardened linux-process-lifetime
// CI job) never skips: there a refusal fails the flows.
const installFlowTest = test.skipIf(
  process.platform !== "linux" ||
    (hostSystemPathProblem !== null &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.HACK_TEST_REQUIRE_INSTALL_FLOWS !== "1")
);

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

/**
 * Replaces the fixture's source shim with a compiled hack binary. The build
 * runs with the fixture's private env, so it never sees the runner's HOME,
 * and is bounded below the calling test's 90 s timeout so a stuck compiler
 * fails with its command named.
 */
async function compileHack(f: Fixture): Promise<void> {
  const outfile = f.hackBin;
  const build = spawnSyncBounded(
    [
      process.execPath,
      "build",
      join(REPO_ROOT, "index.ts"),
      "--compile",
      ...CLI_COMPILE_DEFINE_ARGS,
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      "--outfile",
      outfile,
    ],
    {
      // The compiler stages a transient `.<hash>.bun-build` in its working
      // directory: the fixture root, never the checkout (HACK-2727).
      cwd: f.root,
      env: privateCliEnv({ root: f.root }),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: 60_000,
    }
  );
  if (build.exitCode !== 0) {
    throw new Error(`compiling hack failed: ${build.stderr.toString()}`);
  }
  await chmod(outfile, 0o755);
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
  // The unit's program and PATH directories must not be group-writable,
  // whatever the runner's umask.
  await chmod(bin, 0o755);
  await chmod(home, 0o755);
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

installFlowTest(
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

installFlowTest(
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

installFlowTest(
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

installFlowTest(
  "restart --json refuses before the stop when the unit's start would be refused (HACK-2216)",
  async () => {
    fixture = await createFixture();
    const f = fixture;
    expect((await hack(f, ["daemon", "install"])).code).toBe(0);
    const pid = await readOwnedPid(f);
    expect(pid).not.toBeNull();
    // A unit file others could write: start refuses it, so restart must
    // not stop the running daemon first.
    await chmod(f.unitPath, 0o666);
    const before = (await calls(f)).length;

    const restart = await hack(f, ["daemon", "restart", "--json"]);
    expect(restart.code).toBe(1);
    expect(JSON.parse(restart.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "E_DAEMON_SERVICE",
        detail: {
          schema: "hack.daemon-restart.v1",
          manager: "systemd",
          blocked: "untrusted-unit",
        },
      },
    });
    expect(isAlive(pid as number)).toBe(true);
    const after = (await calls(f)).slice(before);
    expect(after.some((call) => call.includes(" stop "))).toBe(false);
    expect(after.some((call) => call.endsWith("stop hackd.service"))).toBe(
      false
    );

    await chmod(f.unitPath, 0o644);
    expect((await hack(f, ["daemon", "uninstall"])).code).toBe(0);
  },
  90_000
);

installFlowTest(
  "start --json rewrites a stale unit, restarts the service and prints one envelope",
  async () => {
    fixture = await createFixture();
    const f = fixture;
    // Automatic repairs compare the service with the executing binary
    // (HACK-2216): a source invocation has none, so this flow runs a
    // compiled hack, as an installed one is.
    await compileHack(f);
    expect((await hack(f, ["daemon", "install"])).code).toBe(0);
    const before = await readOwnedPid(f);
    expect(before).not.toBeNull();
    const current = await readFile(f.unitPath, "utf8");
    // What an older hack rendered: same program, other content (HACK-2216).
    await writeFile(
      f.unitPath,
      current.replace("RestartSec=2", "RestartSec=9")
    );

    const start = await hack(f, ["daemon", "start", "--json"]);
    expect(start.code).toBe(0);
    const envelope = JSON.parse(start.stdout) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({
      schema: "hack.daemon-start.v1",
      manager: "systemd",
      action: "reinstalled",
      stale: true,
      stale_reasons: ["content"],
      daemon: { running: true, compatible: true },
    });
    expect(await readFile(f.unitPath, "utf8")).toBe(current);
    expect(await calls(f)).toContain("--user restart hackd.service");
    const after = await readOwnedPid(f);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);

    // Nothing stale now: a second start changes nothing.
    const again = await hack(f, ["daemon", "start", "--json"]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({
      ok: true,
      data: { action: "none", stale: false, manager: "systemd" },
    });

    const stop = await hack(f, ["daemon", "stop", "--json"]);
    expect(stop.code).toBe(0);
    expect(JSON.parse(stop.stdout)).toMatchObject({
      ok: true,
      data: {
        schema: "hack.daemon-stop.v1",
        manager: "systemd",
        action: "stopped",
      },
    });
    expect((await hack(f, ["daemon", "uninstall"])).code).toBe(0);
  },
  90_000
);

test.skipIf(process.platform !== "linux")(
  "a replacement daemon started under reconcile-only mode still runs (HACK-2216)",
  async () => {
    fixture = await createFixture();
    const f = fixture;
    const home = join(f.root, "isolated");
    const env = {
      ...f.env,
      HACK_HOME: home,
      HACK_DAEMON_RECONCILE_ONLY: "1",
    };
    // The foreground run is what a replacement spawn executes: even if the
    // flag leaked into it, it must run the daemon, not exit as a no-op.
    const daemon = Bun.spawn([f.hackBin, "daemon", "start", "--foreground"], {
      env,
      cwd: f.root,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      let running = false;
      for (let i = 0; i < 100 && !running; i++) {
        const status = await hack({ ...f, env }, [
          "daemon",
          "status",
          "--json",
        ]);
        running =
          (JSON.parse(status.stdout) as { status?: string }).status ===
          "running";
        if (!running) {
          await Bun.sleep(100);
        }
      }
      expect(running).toBe(true);
      // The reconcile-only start itself sees it running and changes nothing.
      const reconcile = await hack({ ...f, env }, [
        "daemon",
        "start",
        "--json",
      ]);
      expect(JSON.parse(reconcile.stdout)).toMatchObject({
        ok: true,
        data: { action: "none", daemon: { running: true, compatible: true } },
      });
    } finally {
      const { HACK_DAEMON_RECONCILE_ONLY: _drop, ...plain } = env;
      await hack({ ...f, env: plain }, ["daemon", "stop"]);
      daemon.kill();
      await daemon.exited;
    }
  },
  90_000
);

test.skipIf(process.platform !== "linux")(
  "--json with an isolated HACK_HOME: stop reports a no-op, --foreground is a usage error",
  async () => {
    fixture = await createFixture();
    const f = fixture;
    const isolated = {
      ...f,
      env: { ...f.env, HACK_HOME: join(f.root, "isolated") },
    };
    const stop = await hack(isolated, ["daemon", "stop", "--json"]);
    expect(stop.code).toBe(0);
    expect(JSON.parse(stop.stdout)).toEqual({
      ok: true,
      data: {
        schema: "hack.daemon-stop.v1",
        manager: "none",
        action: "none",
        stale: false,
        stale_reasons: [],
        blocked: null,
        fallback: null,
        cli_version: expect.any(String),
        daemon: { running: false, pid: null, version: null, compatible: false },
      },
    });
    // The post-update child's reconcile-only mode never starts hackd.
    const reconcileOnly = await hack(
      {
        ...isolated,
        env: { ...isolated.env, HACK_DAEMON_RECONCILE_ONLY: "1" },
      },
      ["daemon", "start", "--json"]
    );
    expect(reconcileOnly.code).toBe(0);
    expect(JSON.parse(reconcileOnly.stdout)).toMatchObject({
      ok: true,
      data: { action: "none", daemon: { running: false } },
    });
    expect(
      await Bun.file(join(f.root, "isolated", "daemon", "hackd.pid")).exists()
    ).toBe(false);
    const foreground = await hack(isolated, [
      "daemon",
      "start",
      "--foreground",
      "--json",
    ]);
    expect(foreground.code).toBe(1);
    expect(JSON.parse(foreground.stdout)).toMatchObject({
      ok: false,
      error: { code: "E_USAGE" },
    });
    expect(await calls(f)).toEqual([]);
  },
  90_000
);
