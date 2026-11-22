import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../scripts/check-toolchain-image.sh");

for (const stage of ["build", "run"] as const) {
  for (const interrupt of [false, true]) {
    test(`image check cleans ${stage} ${interrupt ? "on TERM" : "after failure"}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "toolchain-check-test-"));
      const log = join(root, "calls");
      const ready = join(root, "ready");
      const docker = join(root, "docker");
      await writeFile(
        docker,
        `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.CHECK_LOG, JSON.stringify(args) + "\\n");
if (args[0] === process.env.CHECK_STAGE) {
  writeFileSync(process.env.CHECK_READY, "ready");
  if (process.env.CHECK_INTERRUPT === "1") await new Promise(() => setInterval(() => {}, 1000));
  process.exit(7);
}
`
      );
      await chmod(docker, 0o700);
      const child = Bun.spawn(["sh", script], {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          CHECK_LOG: log,
          CHECK_READY: ready,
          CHECK_STAGE: stage,
          CHECK_INTERRUPT: interrupt ? "1" : "0",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      try {
        if (interrupt) {
          const deadline = Date.now() + 5000;
          while (!(await Bun.file(ready).exists())) {
            if (Date.now() > deadline) {
              throw new Error("Docker stub did not start");
            }
            await Bun.sleep(10);
          }
          child.kill("SIGTERM");
        }
        const exit = await Promise.race([
          child.exited,
          Bun.sleep(5000).then(() => {
            throw new Error("Image check did not terminate promptly");
          }),
        ]);
        expect(exit).toBe(interrupt ? 143 : 7);
        const calls: string[][] = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const cleanup = calls.slice(-2);
        expect(cleanup[0]?.slice(0, 3)).toEqual(["container", "rm", "--force"]);
        expect(cleanup[1]?.slice(0, 2)).toEqual(["image", "rm"]);
        expect(cleanup[0]?.[3]).toBe(cleanup[1]?.[2]);
        expect(cleanup[1]?.[2]).toMatch(/^tk-toolchain-check-\d+-\d+$/);
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
        }
        await child.exited;
        await rm(root, { recursive: true, force: true });
      }
    }, 15_000);
  }
}
