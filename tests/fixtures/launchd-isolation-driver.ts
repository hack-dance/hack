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
 * the default autostart, printing `{ "response": ... }`. The test then reads
 * what the stub `launchctl` and stub `hack` recorded (HACK-1368).
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

const expectedStub = process.env.HACK_TEST_STUB_LAUNCHCTL ?? "";
if (expectedStub === "" || Bun.which("launchctl") !== expectedStub) {
  process.stdout.write(`${JSON.stringify({ error: "stub-not-first" })}\n`);
  process.exit(3);
}

if (process.argv[2] === "autostart") {
  for (const stream of [process.stdin, process.stdout]) {
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  }
  const response = await requestDaemonJson({ path: "/v1/status" });
  process.stdout.write(`${JSON.stringify({ response })}\n`);
  process.exit(0);
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
