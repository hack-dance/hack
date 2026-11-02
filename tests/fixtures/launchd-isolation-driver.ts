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
  getLaunchdServiceStatus,
  installLaunchdService,
  kickstartLaunchdService,
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
const results = {
  platform: process.platform,
  access: resolveLaunchdAccess(),
  status: await getLaunchdServiceStatus({ paths }),
  repair: await repairLaunchdProgramIfInvalid({ paths }),
  install: await installLaunchdService({
    paths,
    config: { installed: true, runAtLoad: false, guiSessionOnly: false },
  }),
  kickstart: await kickstartLaunchdService(),
  stop: await stopLaunchdService(),
  uninstall: await uninstallLaunchdService({ paths }),
};
process.stdout.write(`${JSON.stringify(results)}\n`);
