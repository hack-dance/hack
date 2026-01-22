import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDaemonPaths } from "../src/daemon/paths.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalLogger: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalLogger = process.env.HACK_LOGGER;
  tempDir = await mkdtemp(join(tmpdir(), "hack-daemon-"));
  process.env.HOME = tempDir;
  process.env.HACK_LOGGER = "console";
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
  process.env.HACK_LOGGER = originalLogger;
});

test("daemon clear removes stale pid and socket files", async () => {
  const paths = resolveDaemonPaths({});
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.pidPath, "999999\n");
  await writeFile(paths.socketPath, "");

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["daemon", "clear"]);
  expect(code).toBe(0);

  const pidExists = await Bun.file(paths.pidPath).exists();
  const socketExists = await Bun.file(paths.socketPath).exists();

  expect(pidExists).toBe(false);
  expect(socketExists).toBe(false);
});
