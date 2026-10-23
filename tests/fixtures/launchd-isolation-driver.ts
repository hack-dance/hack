/**
 * Subprocess driver for tests/launchd-isolation.test.ts.
 *
 * Runs every exported hackd launchd operation once and prints the results as
 * one JSON line. The test runs it with `--preload` darwin, a private HOME and
 * HACK_HOME, and a stub `launchctl` first on PATH. Before anything runs, the
 * driver checks that `launchctl` resolves to that stub and exits 3 otherwise,
 * so it can never reach the real per-user launchd service.
 */
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
