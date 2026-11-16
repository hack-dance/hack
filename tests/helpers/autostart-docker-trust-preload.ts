/**
 * Bun `--preload` module for CLI subprocess tests that reach the automatic
 * startup Docker trust check (`hack up`/`down` intent, login-mode runs,
 * `global up`). It replaces the machine inputs that check would otherwise
 * read from the host, so a developer's Mac (`/var/run/docker.sock`, Homebrew's
 * `/usr/local/lib`, ACLs on the temp chain) cannot decide a test:
 * - the default engine socket: a path directly below `/` that does not exist;
 * - the system plugin directories: none;
 * - the Darwin ACL inspection: reports no ACL entries.
 * The fixture HOME (and its `.docker`) is the test's own. Tests that check
 * those rules themselves live in `autostart-docker-trust.test.ts` and
 * `autostart-path-acl.test.ts` and do not use this preload.
 */
import { useAutostartDockerTrustRootsForTests } from "../../src/lib/autostart-docker-trust.ts";

const noAcl = { exitCode: 0, stdout: "" };
useAutostartDockerTrustRootsForTests({
  defaultHost: "unix:///hack-test-missing-engine/docker.sock",
  systemPluginDirectories: [],
  acl: {
    inspect: () => Promise.resolve(noAcl),
    inspectSync: () => noAcl,
  },
});
