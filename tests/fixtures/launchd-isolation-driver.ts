/**
 * Subprocess driver for tests/launchd-isolation.test.ts.
 *
 * Runs every exported hackd launchd operation once and prints the results as
 * one JSON line. The test runs it with `--preload` darwin, a private HOME and
 * HACK_HOME, and a stub `launchctl` first on PATH. Before anything runs, the
 * driver checks that `launchctl` resolves to that stub and exits 3 otherwise,
 * so it can never reach the real per-user launchd service.
 *
 * With the single argument `autostart` it instead reports the stdin and stdout
 * as TTYs (so `canPrompt()` holds) and makes one `requestDaemonJson` call with
 * the default autostart. During that call it records every `Bun.file` path,
 * `Bun.which` lookup and `Bun.spawn`/`Bun.spawnSync` argv[0] (the APIs the
 * config, launchd and PATH code use), and prints
 * `{ "response": ..., "configPath": ..., "observed": ... }`. The test also
 * reads what the stub `launchctl` and stub `hack` recorded (HACK-1368).
 */
import { requestDaemonJson } from "../../src/daemon/client.ts";
import {
  checkLaunchdRetargetTarget,
  getLaunchdServiceStatus,
  installLaunchdService,
  kickstartLaunchdService,
  readLaunchdManagerState,
  repairLaunchdProgramIfInvalid,
  resolveLaunchdAccess,
  stopLaunchdService,
  uninstallLaunchdService,
} from "../../src/daemon/launchd.ts";
import { resolveDaemonPaths } from "../../src/daemon/paths.ts";
import { resolveGlobalConfigPath } from "../../src/lib/config-paths.ts";

const expectedStub = process.env.HACK_TEST_STUB_LAUNCHCTL ?? "";
if (expectedStub === "" || Bun.which("launchctl") !== expectedStub) {
  process.stdout.write(`${JSON.stringify({ error: "stub-not-first" })}\n`);
  process.exit(3);
}

if (process.argv[2] === "autostart") {
  for (const stream of [process.stdin, process.stdout]) {
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  }
  const observed = recordBunEffects();
  const response = await requestDaemonJson({ path: "/v1/status" });
  process.stdout.write(
    `${JSON.stringify({ response, configPath: resolveGlobalConfigPath(), observed })}\n`
  );
  process.exit(0);
}

/**
 * Wraps the Bun file, PATH and spawn APIs in place and returns what they see.
 * Each wrapper records its argument and then calls the original.
 */
function recordBunEffects(): {
  readonly files: string[];
  readonly which: string[];
  readonly spawns: string[];
} {
  const observed = {
    files: [] as string[],
    which: [] as string[],
    spawns: [] as string[],
  };
  const bun = Bun as unknown as Record<string, unknown>;
  const original = {
    file: Bun.file,
    which: Bun.which,
    spawn: Bun.spawn,
    spawnSync: Bun.spawnSync,
  };
  const argv0 = (args: readonly unknown[]): string => {
    const first = args[0];
    const cmd = Array.isArray(first)
      ? first
      : (first as { cmd?: unknown[] } | undefined)?.cmd;
    return String(cmd?.[0] ?? "");
  };
  bun.file = (...args: unknown[]) => {
    observed.files.push(String(args[0]));
    return Reflect.apply(original.file, Bun, args);
  };
  bun.which = (...args: unknown[]) => {
    observed.which.push(String(args[0]));
    return Reflect.apply(original.which, Bun, args);
  };
  bun.spawn = (...args: unknown[]) => {
    observed.spawns.push(argv0(args));
    return Reflect.apply(original.spawn, Bun, args);
  };
  bun.spawnSync = (...args: unknown[]) => {
    observed.spawns.push(argv0(args));
    return Reflect.apply(original.spawnSync, Bun, args);
  };
  return observed;
}

const paths = resolveDaemonPaths({});
if (process.argv[2] === "manager-state") {
  // The replacement fallback's launchd gate, through the stub launchctl.
  const state = await readLaunchdManagerState();
  process.stdout.write(`${JSON.stringify({ state })}\n`);
  process.exit(0);
}

/**
 * DRIVER_SYSTEM_PATH (colon-separated): the system directories of the
 * rendered PATH the launchd PATH check inspects, instead of the host's own
 * (HACK-2142: CI images leave some of them writable). Test-only.
 */
function driverSystemPath(): readonly string[] | undefined {
  const value = process.env.DRIVER_SYSTEM_PATH;
  return value ? value.split(":") : undefined;
}

if (process.argv[2] === "repair-output") {
  // This driver runs from source, which has no executable of its own; the
  // test names the binary that stands for "this CLI" (HACK-2216).
  // Empty: a source invocation (no executable of its own).
  const executing = process.env.DRIVER_EXECUTING_CLI || null;
  // DRIVER_DAEMON_RUNNING=1: start found this home's hackd running.
  const daemonRunning = process.env.DRIVER_DAEMON_RUNNING === "1";
  // DRIVER_DURABLE_TARGET=1: the fixture's temp-dir `hack` counts as a
  // durable install for the retarget check (everything else still runs).
  const validateRetarget =
    process.env.DRIVER_DURABLE_TARGET === "1"
      ? (path: string) =>
          checkLaunchdRetargetTarget(path, {
            assessDurability: () => Promise.resolve({ durable: true }),
          })
      : undefined;
  const repairOnce = () =>
    repairLaunchdProgramIfInvalid({
      paths,
      executing,
      daemonRunning,
      validateRetarget,
      systemPathDirectories: driverSystemPath(),
    });
  const repair = await repairOnce();
  const secondRepair = await repairOnce();
  process.stdout.write(`${JSON.stringify({ repair, secondRepair })}\n`);
  process.exit(0);
}

const results = {
  platform: process.platform,
  access: resolveLaunchdAccess(),
  status: await getLaunchdServiceStatus({ paths }),
  repair: await repairLaunchdProgramIfInvalid({
    paths,
    systemPathDirectories: driverSystemPath(),
  }),
  install: await installLaunchdService({
    paths,
    config: { installed: true, runAtLoad: false, guiSessionOnly: false },
    systemPathDirectories: driverSystemPath(),
  }),
  kickstart: await kickstartLaunchdService(),
  stop: await stopLaunchdService(),
  uninstall: await uninstallLaunchdService({ paths }),
};
process.stdout.write(`${JSON.stringify(results)}\n`);
