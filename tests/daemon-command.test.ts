import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDaemonPaths } from "../src/daemon/paths.ts";
import { findOrphanDaemonProcesses } from "../src/daemon/process.ts";
import { restoreEnv } from "./helpers/env.ts";
import { spawnHackdLikeFixture } from "./helpers/hackd-fixture.ts";

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
  restoreEnv("HOME", originalHome);
  restoreEnv("HACK_LOGGER", originalLogger);
});

test.skipIf(!Bun.which("lsof"))(
  "daemon clear preserves a real daemon socket owned by another state directory",
  async () => {
    if (!tempDir) {
      throw new Error("Fixture not initialized");
    }
    const foreignRoot = join(tempDir, "foreign-daemon");
    await mkdir(foreignRoot);
    const socket = join(foreignRoot, "hackd.sock");
    const ready = join(foreignRoot, "ready");
    const fixture = await spawnHackdLikeFixture({
      dir: tempDir,
      socket,
      ready,
    });
    const daemon = fixture.child;
    foreignDaemon = daemon;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await Bun.file(ready).exists()) {
        break;
      }
      await Bun.sleep(20);
    }
    expect(await Bun.file(ready).exists()).toBe(true);
    const scan = await findOrphanDaemonProcesses({
      trackedPid: null,
      daemonRoot: foreignRoot,
      expectation: fixture.expectation,
    });
    expect(scan.orphans.map((orphan) => orphan.pid)).toContain(daemon.pid);

    const paths = resolveDaemonPaths({});
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.pidPath, "999999\n");
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["daemon", "clear"])).toBe(0);
    await Bun.sleep(100);
    expect(daemon.exitCode).toBeNull();
    expect(process.kill(daemon.pid, 0)).toBe(true);
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

test("a stop whose termination is not confirmed fails and keeps hackd's files", async () => {
  // Review r2 #6: stop, restart and the install handover must not go on as
  // if hackd had stopped.
  const { stopProvenDaemon } = await import("../src/commands/daemon.ts");
  const paths = resolveDaemonPaths({});
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.pidPath, `${process.pid}\n`);
  await writeFile(paths.socketPath, "");
  const proof = {
    kind: "owned",
    pid: process.pid,
    birth: "b",
    image: {
      executable: "/usr/local/bin/hack",
      argv: ["/usr/local/bin/hack", "daemon", "start", "--foreground"],
    },
  } as const;
  for (const reason of [
    "still-running",
    "changed",
    "identity-unknown",
  ] as const) {
    expect(
      await stopProvenDaemon({
        proof,
        paths,
        terminate: () => Promise.resolve({ kind: "not-confirmed", reason }),
      })
    ).toBe(false);
    expect(await Bun.file(paths.pidPath).exists()).toBe(true);
  }
});
