import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(path).exists()) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(await Bun.file(path).exists()).toBe(true);
}

for (const secondInterrupt of [false, true]) {
  test(`foreground Compose ${secondInterrupt ? "forwards a second interrupt" : "awaits graceful shutdown past two seconds"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-compose-signal-"));
    const docker = join(root, "docker");
    await Bun.write(
      docker,
      `#!${process.execPath}
let stopping = false;
setTimeout(() => process.exit(99), 8000);
process.on("SIGINT", () => {
  if (stopping) process.exit(42);
  stopping = true;
  void Bun.write(${JSON.stringify(join(root, "stopping"))}, "yes");
  setTimeout(async () => {
    await Bun.write(${JSON.stringify(join(root, "stopped"))}, "yes");
    process.exit(0);
  }, 2500);
});
await Bun.write(${JSON.stringify(join(root, "ready"))}, "yes");
setInterval(() => {}, 1000);
`
    );
    await chmod(docker, 0o700);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/compose-foreground.ts"),
        root,
      ],
      {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      }
    );
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      await waitForFile(join(root, "ready"));
      process.kill(-child.pid, "SIGINT");
      await waitForFile(join(root, "stopping"));
      if (secondInterrupt) {
        process.kill(-child.pid, "SIGINT");
      }
      expect(await child.exited).toBe(130);
      expect(await Bun.file(join(root, "stopped")).exists()).toBe(
        !secondInterrupt
      );
      const result = await Bun.file(join(root, "result.json")).json();
      expect(result).toEqual({ code: 130, before: 0, after: 0 });
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}
