import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detachedStartFailureMessage } from "../src/commands/daemon.ts";
import {
  DETACHED_START_BUDGET_MS,
  HANDOFF_GRACE_MS,
  waitForDetachedDaemonStart,
} from "../src/daemon/start-wait.ts";

/**
 * HACK-2371: a direct `hack daemon start` gave the hackd it spawned 2 s to
 * bind its socket and then reported "did not report ready yet", although
 * hackd was healthy and ready a moment later (first seen on a hosted Linux
 * x86_64 runner; reproduced with the CPU limited to 0.15 of a core). The
 * wait now has a budget sized from measurements, returns as soon as hackd is
 * ready, and returns at once when the spawned process has ended.
 */

const OLD_BUDGET_MS = 2000;

/** A clock the wait advances itself through `sleep`. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

test("the budget is sized above the slowest measured healthy start", () => {
  // 6.2 s was the slowest time to socket measured at a tenth of a core.
  expect(DETACHED_START_BUDGET_MS).toBeGreaterThanOrEqual(3 * 6200);
  expect(DETACHED_START_BUDGET_MS).toBeGreaterThan(OLD_BUDGET_MS);
});

test("a daemon ready after the old budget but inside the new one is started", async () => {
  const clock = fakeClock();
  const readyAt = 3000;
  const outcome = await waitForDetachedDaemonStart({
    isReady: () => Promise.resolve(clock.now() >= readyAt),
    spawnedExitCode: () => null,
    daemonAlive: () => Promise.resolve(true),
    ...clock,
  });
  expect(outcome.kind).toBe("ready");
  expect(outcome.waitedMs).toBeGreaterThan(OLD_BUDGET_MS);
  // It returns when hackd is ready, not when the budget ends.
  expect(outcome.waitedMs).toBeLessThan(readyAt + 200);
});

test("a daemon that is ready at once costs no wait", async () => {
  const clock = fakeClock();
  expect(
    await waitForDetachedDaemonStart({
      isReady: () => Promise.resolve(true),
      spawnedExitCode: () => null,
      daemonAlive: () => Promise.resolve(true),
      ...clock,
    })
  ).toEqual({ kind: "ready", waitedMs: 0 });
});

test("a spawned process that exits early fails quickly, not at the budget", async () => {
  const clock = fakeClock();
  const exitedAt = 300;
  const outcome = await waitForDetachedDaemonStart({
    isReady: () => Promise.resolve(false),
    spawnedExitCode: () => (clock.now() >= exitedAt ? 3 : null),
    daemonAlive: () => Promise.resolve(false),
    ...clock,
  });
  expect(outcome.kind).toBe("exited");
  // Seen gone twice, one poll apart, then reported.
  expect(outcome.waitedMs).toBeLessThan(exitedAt + 400);
  expect(outcome.waitedMs).toBeLessThan(OLD_BUDGET_MS);
});

test("a launcher that exits 0 gets a grace for its hackd's pid file, then is an exit", async () => {
  // Handed off: the launcher left with 0 and hackd's pid file came 1.5 s
  // later, on a slow machine. That is a healthy start, not an exit.
  const handoff = fakeClock();
  expect(
    (
      await waitForDetachedDaemonStart({
        isReady: () => Promise.resolve(handoff.now() >= 2600),
        spawnedExitCode: () => 0,
        daemonAlive: () => Promise.resolve(handoff.now() >= 1500),
        ...handoff,
      })
    ).kind
  ).toBe("ready");
  // Nothing ever appears: reported once the grace has passed, still far
  // short of the budget.
  const nothing = fakeClock();
  const outcome = await waitForDetachedDaemonStart({
    isReady: () => Promise.resolve(false),
    spawnedExitCode: () => 0,
    daemonAlive: () => Promise.resolve(false),
    ...nothing,
  });
  expect(outcome.kind).toBe("exited");
  expect(outcome.waitedMs).toBeGreaterThanOrEqual(HANDOFF_GRACE_MS);
  expect(outcome.waitedMs).toBeLessThan(HANDOFF_GRACE_MS + 400);
});

test("a launcher that leaves while its hackd lives on is not an exit", async () => {
  const clock = fakeClock();
  const outcome = await waitForDetachedDaemonStart({
    isReady: () => Promise.resolve(clock.now() >= 2500),
    spawnedExitCode: () => 0,
    daemonAlive: () => Promise.resolve(true),
    ...clock,
  });
  expect(outcome.kind).toBe("ready");
});

test("a hackd that is just writing its pid file is not taken for an exit", async () => {
  const clock = fakeClock();
  let looks = 0;
  const outcome = await waitForDetachedDaemonStart({
    isReady: () => Promise.resolve(clock.now() >= 600),
    spawnedExitCode: () => 0,
    // Gone on the first look only: the pid file appeared a moment later.
    daemonAlive: () => Promise.resolve(looks++ > 0),
    ...clock,
  });
  expect(outcome.kind).toBe("ready");
});

test("a process that never becomes ready fails at the budget with the existing message", async () => {
  const clock = fakeClock();
  const outcome = await waitForDetachedDaemonStart({
    isReady: () => Promise.resolve(false),
    spawnedExitCode: () => null,
    daemonAlive: () => Promise.resolve(true),
    ...clock,
  });
  expect(outcome.kind).toBe("timeout");
  expect(outcome.waitedMs).toBeGreaterThanOrEqual(DETACHED_START_BUDGET_MS);
  expect(outcome.waitedMs).toBeLessThan(DETACHED_START_BUDGET_MS + 200);
  expect(
    detachedStartFailureMessage({
      outcome: "timeout",
      directoryRefusal: null,
      exitCode: null,
    })
  ).toBe(
    "Started hackd process but it did not report ready yet | Check: hack daemon logs --tail 200, or run hack daemon start --foreground to see its error"
  );
});

test("the failure names the real reason: a refused directory, or the exit", () => {
  expect(
    detachedStartFailureMessage({
      outcome: "exited",
      directoryRefusal: null,
      exitCode: 3,
    })
  ).toBe(
    "hackd exited before it was ready (exit code 3) | Check: hack daemon logs --tail 200, or run hack daemon start --foreground to see its error"
  );
  for (const outcome of ["exited", "timeout"] as const) {
    expect(
      detachedStartFailureMessage({
        outcome,
        directoryRefusal: "state directory is not safe",
        exitCode: 1,
      })
    ).toBe("hackd did not start: state directory is not safe");
  }
});

/*
 * The same three cases through the real CLI. A `hack` wrapper on PATH stands
 * for the program `daemon start` spawns: it can delay, or fail, only the
 * `daemon start --foreground` it is asked to run. Private HOME, no service
 * manager, Docker pointed at a dead socket.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");

type Fixture = { readonly root: string; readonly env: Record<string, string> };
let fixture: Fixture | null = null;

afterEach(async () => {
  const current = fixture;
  fixture = null;
  if (current) {
    // A failed test can leave the wrapper still sleeping before it starts
    // hackd. End it first, so nothing starts after the stop below and
    // recreates the fixture directory.
    const wrapperPid = Number(
      (
        await readFile(join(current.root, "wrapper.pid"), "utf8").catch(
          () => ""
        )
      ).trim()
    );
    if (Number.isInteger(wrapperPid) && wrapperPid > 0) {
      try {
        process.kill(-wrapperPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await run(current, ["daemon", "stop"]).catch(() => undefined);
    await rm(current.root, { recursive: true, force: true });
  }
});

async function createFixture(foreground: string): Promise<Fixture> {
  // Keep the home and its daemon socket within the caller's scratch, with
  // short components to fit the platform's Unix socket path limit.
  const root = await mkdtemp(join(await realpath(tmpdir()), "dsw-"));
  const home = root;
  const bin = join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await chmod(home, 0o755);
  const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO_ROOT, "index.ts"))}`;
  await writeFile(
    join(bin, "hack"),
    `#!/bin/sh
case "$*" in
  "daemon start --foreground") echo "$$" > ${JSON.stringify(join(root, "wrapper.pid"))}; ${foreground} ;;
esac
exec ${cli} "$@"
`
  );
  await chmod(join(bin, "hack"), 0o755);
  return {
    root,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: tmpdir(),
      HACK_NO_INTERACTIVE: "1",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_SYSTEMD_DISABLE: "1",
      HACK_LAUNCHD_DISABLE: "1",
      HACK_LOGGER: "console",
      NO_COLOR: "1",
      DOCKER_HOST: `unix://${join(root, "no-docker.sock")}`,
      DOCKER_CONFIG: join(root, "docker-config"),
    },
  };
}

async function run(f: Fixture, args: readonly string[]) {
  const started = performance.now();
  const child = Bun.spawn(["hack", ...args], {
    env: f.env,
    cwd: f.root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    exitCode,
    output: `${stdout}${stderr}`,
    ms: performance.now() - started,
  };
}

test.skipIf(process.platform === "win32")(
  "daemon start reports a hackd that needs longer than the old 2 s budget as started",
  async () => {
    // hackd begins three seconds late: past the old budget, inside the new.
    fixture = await createFixture("sleep 3");
    const start = await run(fixture, ["daemon", "start"]);
    expect(start.output).toContain("hackd started");
    expect(start.output).not.toContain("did not report ready yet");
    expect(start.exitCode).toBe(0);
    expect(start.ms).toBeGreaterThan(3000);
    // Not the whole budget: it returned once hackd was ready.
    expect(start.ms).toBeLessThan(DETACHED_START_BUDGET_MS);
    const status = await run(fixture, ["daemon", "status", "--json"]);
    expect(JSON.parse(status.output)).toMatchObject({
      status: "running",
      api_compatible: true,
    });
    const pid = await readFile(
      join(fixture.root, ".hack/daemon/hackd.pid"),
      "utf8"
    );
    expect(Number(pid.trim())).toBeGreaterThan(0);
  },
  90_000
);

test.skipIf(process.platform === "win32")(
  "an unsafe direct replacement PATH leaves the running daemon and socket in place",
  async () => {
    fixture = await createFixture(":");
    const start = await run(fixture, ["daemon", "start"]);
    expect(start.exitCode, start.output).toBe(0);
    const pidPath = join(fixture.root, ".hack/daemon/hackd.pid");
    const pid = await readFile(pidPath, "utf8");

    const unsafeBin = join(fixture.root, ".bun", "bin");
    await mkdir(unsafeBin, { recursive: true });
    await chmod(unsafeBin, 0o775);
    const restart = await run(fixture, ["daemon", "restart", "--json"]);
    expect(restart.exitCode).toBe(1);
    expect(restart.output).toContain("Keeping the running hackd");
    expect(restart.output).toContain("unsafe PATH");
    expect(await readFile(pidPath, "utf8")).toBe(pid);
    const status = await run(fixture, ["daemon", "status", "--json"]);
    expect(JSON.parse(status.output)).toMatchObject({
      pid: Number(pid.trim()),
      status: "running",
      api_compatible: true,
    });
  },
  90_000
);

test.skipIf(process.platform === "win32")(
  "daemon start fails fast, with the reason, when the spawned hackd exits",
  async () => {
    fixture = await createFixture("exit 3");
    const start = await run(fixture, ["daemon", "start"]);
    expect(start.exitCode).toBe(1);
    expect(start.output).toContain(
      "hackd exited before it was ready (exit code 3)"
    );
    expect(start.output).toContain("hack daemon logs --tail 200");
    expect(start.output).not.toContain("did not report ready yet");
    // Far short of the budget: nothing waits for a process that is gone.
    expect(start.ms).toBeLessThan(DETACHED_START_BUDGET_MS / 2);
  },
  90_000
);
