import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_LAUNCHD_LABEL } from "../src/constants.ts";
import {
  LAUNCHD_ALLOW_ISOLATED_ENV,
  LAUNCHD_DISABLE_ENV,
} from "../src/daemon/launchd.ts";
import {
  blockedLaunchctlCalls,
  buildCliEnv,
  describeLaunchAgentChange,
  fingerprintLaunchAgentPlist,
  releaseLaunchctlGuard,
} from "./e2e/harness.ts";

/*
 * HACK-1313: the e2e harness keeps HOME real, so it must stop every CLI
 * invocation from managing the user's hackd launchd service, and detect a
 * change to the real plist after the run. These cases never run the CLI and
 * never read the real LaunchAgents directory.
 */

let cleanupRoot: string | null = null;

afterEach(async () => {
  // The shim and its process exit listener are per process in the e2e runner;
  // here every test file shares one Bun process, so release them per test.
  releaseLaunchctlGuard();
  if (cleanupRoot) {
    await rm(cleanupRoot, { recursive: true, force: true });
    cleanupRoot = null;
  }
});

test("buildCliEnv forces the launchd hard deny over scenario env", () => {
  const env = buildCliEnv({
    hackHome: "/tmp/hack-e2e-home-guard",
    extra: {
      [LAUNCHD_DISABLE_ENV]: "0",
      [LAUNCHD_ALLOW_ISOLATED_ENV]: "1",
      PATH: "/scenario/tools:/usr/bin:/bin",
    },
  });
  expect(env[LAUNCHD_DISABLE_ENV]).toBe("1");
  expect(Object.hasOwn(env, LAUNCHD_ALLOW_ISOLATED_ENV)).toBe(false);
  const [guardDir, ...rest] = (env.PATH ?? "").split(":");
  expect(guardDir).toContain("hack-e2e-launchctl-guard-");
  expect(rest.join(":")).toBe("/scenario/tools:/usr/bin:/bin");
});

test("the launchctl guard shim refuses and records hackd service calls", async () => {
  const env = buildCliEnv({ hackHome: "/tmp/hack-e2e-home-guard" });
  const guardDir = (env.PATH ?? "").split(":")[0] ?? "";
  const before = blockedLaunchctlCalls().length;
  // `print` is read-only, so even a broken shim that passed this through
  // could not change the real service.
  const child = Bun.spawn(
    [join(guardDir, "launchctl"), "print", `gui/0/${DAEMON_LAUNCHD_LABEL}`],
    {
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(1);
  expect(stderr).toContain("launchctl access to the hackd service is blocked");
  expect(blockedLaunchctlCalls().slice(before)).toEqual(["print"]);
});

test("the LaunchAgent canary reports content, mtime, creation and removal by hash only", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-e2e-launchd-canary-"));
  cleanupRoot = root;
  const path = join(root, "dance.hack.hackd.plist");
  const secretish = "SENTINEL-PLIST-CONTENT";

  const absent = await fingerprintLaunchAgentPlist({ path });
  expect(absent).toEqual({ present: false });
  expect(
    describeLaunchAgentChange({ before: absent, after: absent })
  ).toBeNull();

  await writeFile(path, `<plist>${secretish}</plist>\n`);
  const fixed = new Date("2026-01-01T00:00:00Z");
  await utimes(path, fixed, fixed);
  const original = await fingerprintLaunchAgentPlist({ path });
  expect(original.present).toBe(true);
  const created = describeLaunchAgentChange({
    before: absent,
    after: original,
  });
  expect(created).toStartWith("absent -> sha256=");

  // Unchanged bytes and mtime: no report.
  expect(
    describeLaunchAgentChange({
      before: original,
      after: await fingerprintLaunchAgentPlist({ path }),
    })
  ).toBeNull();

  // Same bytes, new mtime (a rewrite with identical content).
  const later = new Date("2026-02-01T00:00:00Z");
  await utimes(path, later, later);
  const touched = await fingerprintLaunchAgentPlist({ path });
  expect(
    describeLaunchAgentChange({ before: original, after: touched })
  ).not.toBeNull();

  // New bytes, original mtime restored.
  await writeFile(path, `<plist>${secretish}-rewritten</plist>\n`);
  await utimes(path, fixed, fixed);
  expect((await stat(path)).mtimeMs).toBe(fixed.getTime());
  const rewritten = await fingerprintLaunchAgentPlist({ path });
  const contentChange = describeLaunchAgentChange({
    before: original,
    after: rewritten,
  });
  expect(contentChange).not.toBeNull();
  expect(contentChange).not.toContain(secretish);

  await rm(path);
  expect(
    describeLaunchAgentChange({
      before: original,
      after: await fingerprintLaunchAgentPlist({ path }),
    })
  ).toEndWith("-> absent");
});

test("releasing the launchctl guard removes its shim and exit listener", async () => {
  const listeners = process.listenerCount("exit");
  const env = buildCliEnv({ hackHome: "/tmp/hack-e2e-home-guard" });
  const guardDir = (env.PATH ?? "").split(":")[0] ?? "";
  expect(process.listenerCount("exit")).toBe(listeners + 1);
  expect((await stat(guardDir)).isDirectory()).toBe(true);
  releaseLaunchctlGuard();
  expect(process.listenerCount("exit")).toBe(listeners);
  expect(await stat(guardDir).catch(() => null)).toBeNull();
  const next = buildCliEnv({ hackHome: "/tmp/hack-e2e-home-guard" });
  expect((next.PATH ?? "").split(":")[0]).not.toBe(guardDir);
});
