/**
 * Bun `--preload` module for launchd subprocess tests (HACK-2216). Hack
 * runs `/bin/launchctl` by absolute path, never from PATH, so a stub on
 * PATH no longer stands in for it. This test-only module points launchd
 * operations at the stub named by `HACK_TEST_STUB_LAUNCHCTL` instead.
 * Production never loads it, and no production code reads that variable.
 */
import { useLaunchctlBinaryForTests } from "../../src/daemon/launchd.ts";

const stub = process.env.HACK_TEST_STUB_LAUNCHCTL;
if (stub) {
  useLaunchctlBinaryForTests(stub);
}
