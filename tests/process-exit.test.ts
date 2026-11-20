import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROCESS_EXIT = resolve(import.meta.dir, "..", "src/lib/process-exit.ts");
const RUNTIME_BACKEND = resolve(
  import.meta.dir,
  "..",
  "src/backends/runtime-backend.ts"
);

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hack-process-exit-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs `source` as a child script; returns its exit code, stdout and time. */
async function runScript(source: string): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly elapsedMs: number;
}> {
  const path = join(dir, "script.ts");
  await writeFile(path, source);
  const started = performance.now();
  const child = Bun.spawn([process.execPath, path], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stdout, elapsedMs: performance.now() - started };
}

test("a pending timer does not hold the exit, and piped output arrives whole", async () => {
  const result = await runScript(`
    import { exitWhenDone } from ${JSON.stringify(PROCESS_EXIT)};
    setTimeout(() => {}, 30_000);
    process.stdout.write("x".repeat(2 * 1024 * 1024));
    process.stdout.write("\\nend\\n");
    await exitWhenDone(3);
  `);
  expect(result.exitCode).toBe(3);
  expect(result.elapsedMs).toBeLessThan(10_000);
  expect(result.stdout.length).toBe(2 * 1024 * 1024 + 5);
  expect(result.stdout.endsWith("\nend\n")).toBe(true);
});

test("the exit waits for held work, including work held while waiting", async () => {
  const result = await runScript(`
    import { exitWhenDone, holdProcessUntil } from ${JSON.stringify(PROCESS_EXIT)};
    setTimeout(() => {}, 30_000);
    holdProcessUntil(
      Bun.sleep(150).then(() => {
        process.stdout.write("first\\n");
        holdProcessUntil(Bun.sleep(150).then(() => process.stdout.write("second\\n")));
      })
    );
    holdProcessUntil(Promise.reject(new Error("reported by its owner")));
    await exitWhenDone(0);
  `);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("first\nsecond\n");
  expect(result.elapsedMs).toBeLessThan(10_000);
});

test("waitOrFinish leaves no timer once its work ends", async () => {
  // No explicit exit: the process ends only when nothing holds the loop.
  const result = await runScript(`
    import { waitOrFinish } from ${JSON.stringify(RUNTIME_BACKEND)};
    await waitOrFinish(30_000, Promise.resolve(0));
    await waitOrFinish(30_000, Promise.reject(new Error("failed start")));
    process.stdout.write("done\\n");
  `);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("done\n");
  expect(result.elapsedMs).toBeLessThan(10_000);
});
