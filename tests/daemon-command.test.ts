import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDaemonPaths } from "../src/daemon/paths.ts";
import { findOrphanDaemonProcesses } from "../src/daemon/process.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalLogger: string | undefined;
let foreignDaemon: ReturnType<typeof Bun.spawn> | null = null;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalLogger = process.env.HACK_LOGGER;
  tempDir = await mkdtemp(join(tmpdir(), "hack-daemon-"));
  process.env.HOME = tempDir;
  process.env.HACK_LOGGER = "console";
});

afterEach(async () => {
  if (foreignDaemon) {
    foreignDaemon.kill("SIGKILL");
    await foreignDaemon.exited;
    foreignDaemon = null;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
  process.env.HACK_LOGGER = originalLogger;
});

test.skipIf(!Bun.which("lsof"))(
  "daemon clear preserves a real daemon socket owned by another state directory",
  async () => {
    if (!tempDir) {
      throw new Error("Fixture not initialized");
    }
    const foreignRoot = join(tempDir, "foreign-daemon");
    await mkdir(foreignRoot);
    const binary = join(tempDir, "hack-foreign-fixture");
    await symlink(process.execPath, binary);
    const socket = join(foreignRoot, "hackd.sock");
    const ready = join(foreignRoot, "ready");
    foreignDaemon = Bun.spawn(
      [
        binary,
        "-e",
        `Bun.serve({ unix: ${JSON.stringify(socket)}, fetch() { return new Response("fixture"); } }); await Bun.write(${JSON.stringify(ready)}, "ready");`,
        "--",
        "daemon",
        "start",
        "--foreground",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await Bun.file(ready).exists()) {
        break;
      }
      await Bun.sleep(20);
    }
    expect(await Bun.file(ready).exists()).toBe(true);
    expect(
      await findOrphanDaemonProcesses({
        trackedPid: null,
        daemonRoot: foreignRoot,
      })
    ).toContain(foreignDaemon.pid);

    const paths = resolveDaemonPaths({});
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.pidPath, "999999\n");
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["daemon", "clear"])).toBe(0);
    await Bun.sleep(100);
    expect(foreignDaemon.exitCode).toBeNull();
    expect(process.kill(foreignDaemon.pid, 0)).toBe(true);
  },
  10_000
);

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
