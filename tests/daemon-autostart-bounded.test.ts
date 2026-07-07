import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requestDaemonJson } from "../src/daemon/client.ts";

const AUTOSTART_BUDGET_MS = 5000;

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalNoInteractive: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-daemon-autostart-"));
  originalHome = process.env.HOME;
  originalNoInteractive = process.env.HACK_NO_INTERACTIVE;
  process.env.HOME = tempDir;
  // Simulate an automation/agent run explicitly.
  process.env.HACK_NO_INTERACTIVE = "1";
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
  if (originalNoInteractive === undefined) {
    Reflect.deleteProperty(process.env, "HACK_NO_INTERACTIVE");
  } else {
    process.env.HACK_NO_INTERACTIVE = originalNoInteractive;
  }
});

test("non-interactive runs never autostart the daemon and return within budget", async () => {
  // Default control-plane config has daemon.autoStart=true; with no daemon
  // running and a non-interactive session, the client must skip autostart
  // and return null quickly so callers fall back to direct docker inspection.
  const startedAt = Date.now();
  const response = await requestDaemonJson({ path: "/v1/projects" });
  const elapsedMs = Date.now() - startedAt;

  expect(response).toBeNull();
  expect(elapsedMs).toBeLessThan(AUTOSTART_BUDGET_MS);
});

test("autoStart=false still short-circuits without spawning anything", async () => {
  const startedAt = Date.now();
  const response = await requestDaemonJson({
    path: "/v1/metrics",
    autoStart: false,
  });
  const elapsedMs = Date.now() - startedAt;

  expect(response).toBeNull();
  expect(elapsedMs).toBeLessThan(AUTOSTART_BUDGET_MS);
});
