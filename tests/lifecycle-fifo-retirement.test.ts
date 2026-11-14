import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateLifecycleLog } from "../src/lib/lifecycle-runtime.ts";
import { quoteShellWord } from "../src/lib/logs.ts";
import { readProcessIdentities } from "../src/lib/process-tree.ts";
import { wrapLifecyclePersistentCommand } from "../src/lib/project-lifecycle-controller.ts";
import { createLifecycleSessionRetirement } from "../src/lib/project-lifecycle-processes.ts";

for (const behavior of [
  "cooperative",
  "resistant",
  "separate-worker",
  "forced",
] as const) {
  const ignoresTerm = behavior === "resistant" || behavior === "forced";
  test(`FIFO command retirement (${behavior}) preserves graceful shutdown and reaps the reader`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-fifo-retirement-"));
    const logPath = join(root, "lifecycle.log");
    const commandPidPath = join(root, "command.pid");
    const ready = join(root, "ready");
    const cleanExit = join(root, "clean-exit");
    const workerPidPath = join(root, "worker.pid");
    const workerReady = join(root, "worker-ready");
    await ensurePrivateLifecycleLog({ root, logPath });
    const code =
      behavior === "separate-worker"
        ? separateWorkerCommand({
            workerPidPath,
            workerReady,
            cleanExit,
            ready,
          })
        : `process.on("SIGTERM", () => { ${ignoresTerm ? "" : `setTimeout(async () => { await Bun.write(${JSON.stringify(cleanExit)}, "clean"); process.exit(0); }, 1000);`} }); await Bun.write(${JSON.stringify(ready)}, "yes"); setInterval(() => {}, 1000);`;
    const command = `${quoteShellWord(process.execPath)} --no-env-file -e ${quoteShellWord(code)}`;
    const wrapped = wrapLifecyclePersistentCommand({
      command,
      commandPidPath,
      logPath,
      serviceName: "writer",
    });
    // Make the wrapper's private-directory cleanup observable after its child
    // exits, so killing the wrapper with the command cannot pass by scheduling.
    const delayedWrapper =
      behavior === "forced"
        ? wrapped.replace(
            '  rmdir "$fifo_dir" 2>/dev/null || true',
            '  sleep 0.3\n  rmdir "$fifo_dir" 2>/dev/null || true'
          )
        : wrapped;
    const child = Bun.spawn(["sh", "-c", delayedWrapper], {
      detached: true,
      env: { PATH: "/usr/bin:/bin", TMPDIR: root },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    let group: number | undefined;
    let workerGroup: number | undefined;
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 25_000);
    try {
      const deadline = performance.now() + 10_000;
      while (
        !(await Bun.file(ready).exists()) &&
        child.exitCode === null &&
        performance.now() < deadline
      ) {
        await Bun.sleep(10);
      }
      expect(await Bun.file(ready).exists()).toBe(true);
      group = Number.parseInt(await Bun.file(commandPidPath).text(), 10);
      expect(group).toBeGreaterThan(1);
      expect(
        (await readProcessIdentities()).find((row) => row.pid === group)
          ?.processGroupId,
        "the fixture requires a real dedicated command process group"
      ).toBe(group);
      expect(group).not.toBe(child.pid);
      if (behavior === "separate-worker") {
        workerGroup = Number(await Bun.file(workerPidPath).text());
        expect(workerGroup).toBeGreaterThan(1);
        expect(workerGroup).not.toBe(group);
        expect(
          (await readProcessIdentities()).find((row) => row.pid === workerGroup)
            ?.processGroupId
        ).toBe(workerGroup);
      }
      const retire = createLifecycleSessionRetirement();
      const paneBirth = (await readProcessIdentities()).find(
        (row) => row.pid === child.pid
      )?.birth;
      expect(paneBirth).toBeDefined();
      const force = new AbortController();
      if (behavior === "forced") {
        expect(
          (await readdir(root)).filter((name) =>
            name.startsWith("hack-lifecycle.")
          )
        ).toHaveLength(1);
        force.abort();
      }
      expect(
        await retire({
          processes: [{ panePid: child.pid, paneBirth }],
          force: force.signal,
          stopSession: () => {
            process.kill(-child.pid, "SIGHUP");
            return Promise.resolve(true);
          },
        })
      ).toBe(true);
      if (behavior === "forced") {
        expect(
          (await readdir(root)).filter((name) =>
            name.startsWith("hack-lifecycle.")
          ),
          "forced cleanup must let the wrapper remove its private FIFO directory"
        ).toEqual([]);
      }
      expect(await child.exited).toBe(130);
      expect(await Bun.file(cleanExit).exists()).toBe(!ignoresTerm);
      expect(() => process.kill(-(group ?? 0), 0)).toThrow();
      expect(() => process.kill(-child.pid, 0)).toThrow();
      if (workerGroup !== undefined) {
        expect(() => process.kill(-(workerGroup ?? 0), 0)).toThrow();
      }
      expect(
        (await readdir(root)).filter((name) =>
          name.startsWith("hack-lifecycle.")
        )
      ).toEqual([]);
    } finally {
      clearTimeout(watchdog);
      // Read the test-owned worker even if startup failed before readiness.
      workerGroup ??= Number(
        await Bun.file(workerPidPath)
          .text()
          .catch(() => "0")
      );
      for (const ownedGroup of [workerGroup, group]) {
        if (!(ownedGroup !== undefined && ownedGroup > 1)) {
          continue;
        }
        try {
          process.kill(-ownedGroup, "SIGKILL");
        } catch {
          /* already absent */
        }
      }
      if (child.exitCode === null) {
        process.kill(-child.pid, "SIGKILL");
      }
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}

/** The main command waits for its separately grouped child, but forwards no TERM. */
function separateWorkerCommand(opts: {
  readonly workerPidPath: string;
  readonly workerReady: string;
  readonly cleanExit: string;
  readonly ready: string;
}): string {
  const worker = `process.on("SIGTERM", () => setTimeout(async () => { await Bun.write(${JSON.stringify(opts.cleanExit)}, "clean"); process.exit(0); }, 1000)); await Bun.write(${JSON.stringify(opts.workerReady)}, "yes"); setInterval(() => {}, 1000);`;
  return `const worker = Bun.spawn([${JSON.stringify(process.execPath)}, "--no-env-file", "-e", ${JSON.stringify(worker)}], { detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" }); process.on("SIGTERM", () => { void worker.exited.then(() => process.exit(0)); }); await Bun.write(${JSON.stringify(opts.workerPidPath)}, String(worker.pid)); while (!(await Bun.file(${JSON.stringify(opts.workerReady)}).exists())) await Bun.sleep(10); await Bun.write(${JSON.stringify(opts.ready)}, "yes"); setInterval(() => {}, 1000);`;
}
