import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateLifecycleLog } from "../src/lib/lifecycle-runtime.ts";
import { quoteShellWord } from "../src/lib/logs.ts";
import { wrapLifecyclePersistentCommand } from "../src/lib/project-lifecycle-controller.ts";
import { createLifecycleSessionRetirement } from "../src/lib/project-lifecycle-processes.ts";

for (const ignoresTerm of [false, true]) {
  test(`FIFO command retirement ${ignoresTerm ? "escalates a TERM-resistant writer" : "waits for a delayed writer"} and reaps the reader`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-fifo-retirement-"));
    const logPath = join(root, "lifecycle.log");
    const commandPidPath = join(root, "command.pid");
    const ready = join(root, "ready");
    await ensurePrivateLifecycleLog({ root, logPath });
    const code = `process.on("SIGTERM", () => { ${ignoresTerm ? "" : "setTimeout(() => process.exit(0), 150);"} }); await Bun.write(${JSON.stringify(ready)}, "yes"); setInterval(() => {}, 1000);`;
    const command = `${quoteShellWord(process.execPath)} --no-env-file -e ${quoteShellWord(code)}`;
    const child = Bun.spawn(
      [
        "sh",
        "-c",
        wrapLifecyclePersistentCommand({
          command,
          commandPidPath,
          logPath,
          serviceName: "writer",
        }),
      ],
      {
        detached: true,
        env: { PATH: "/usr/bin:/bin", TMPDIR: root },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }
    );
    let group: number | undefined;
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 8000);
    try {
      const deadline = performance.now() + 3000;
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
      const retire = createLifecycleSessionRetirement();
      expect(
        await retire({
          processes: [{ panePid: child.pid }],
          stopSession: () => {
            process.kill(-child.pid, "SIGHUP");
            return Promise.resolve(true);
          },
        })
      ).toBe(true);
      expect(await child.exited).toBe(130);
      expect(() => process.kill(-(group ?? 0), 0)).toThrow();
      expect(() => process.kill(-child.pid, 0)).toThrow();
      expect(
        (await readdir(root)).filter((name) =>
          name.startsWith("hack-lifecycle.")
        )
      ).toEqual([]);
    } finally {
      clearTimeout(watchdog);
      if (group !== undefined && group > 1) {
        try {
          process.kill(-group, "SIGKILL");
        } catch {
          /* already absent */
        }
      }
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
}
