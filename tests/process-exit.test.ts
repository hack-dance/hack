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

const LIFECYCLE_CONTROLLER = resolve(
  import.meta.dir,
  "..",
  "src/lib/project-lifecycle-controller.ts"
);

test("Ctrl-C during a slow hook: the lifecycle cleanup finishes and the process dies by SIGINT", async () => {
  // As `hack down` with a slow before-hook: the terminal's SIGINT ends the
  // hook (here a once-listener stands in for the process group), the command
  // returns the hook's code and exits explicitly, while the lifecycle signal
  // cleanup is still stopping a lifecycle process.
  const path = join(dir, "script.ts");
  const mark = (name: string) => JSON.stringify(join(dir, name));
  await writeFile(
    path,
    `import { installLifecycleSignalCleanup } from ${JSON.stringify(LIFECYCLE_CONTROLLER)};
import { exitWhenDone } from ${JSON.stringify(PROCESS_EXIT)};
const lifecycle = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await Bun.write(${mark("lifecycle.pid")}, String(lifecycle.pid));
const guard = installLifecycleSignalCleanup({ cleanup: async () => {
  await Bun.sleep(1500);
  lifecycle.kill("SIGKILL");
  await lifecycle.exited;
  await Bun.write(${mark("cleaned")}, "yes");
} });
const hook = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
process.once("SIGINT", () => hook.kill("SIGINT"));
await Bun.write(${mark("ready")}, "yes");
let code: number;
try {
  code = (await hook.exited) === 0 ? 0 : 1;
} finally {
  guard.dispose();
}
await exitWhenDone(code);
`
  );
  const child = Bun.spawn([process.execPath, "--no-env-file", path], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const deadline = performance.now() + 10_000;
    while (
      !(await Bun.file(join(dir, "ready")).exists()) &&
      performance.now() < deadline
    ) {
      await Bun.sleep(10);
    }
    child.kill("SIGINT");
    await child.exited;
    expect(child.signalCode).toBe("SIGINT");
    expect(await Bun.file(join(dir, "cleaned")).exists()).toBe(true);
    const pid = Number(await Bun.file(join(dir, "lifecycle.pid")).text());
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
}, 30_000);

test("a reader that starts two seconds late still gets every byte and the exit code", async () => {
  const path = join(dir, "script.ts");
  await writeFile(
    path,
    `import { exitWhenDone } from ${JSON.stringify(PROCESS_EXIT)};
const chunk = "x".repeat(1024 * 1024);
process.stdout.write(chunk.repeat(2));
process.stdout.write(\`\${JSON.stringify({ kind: "result", ok: true })}\\n\`);
process.stdout.write(chunk.repeat(2));
process.stderr.write(chunk);
await exitWhenDone(3);
`
  );
  const child = Bun.spawn([process.execPath, "--no-env-file", path], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.sleep(2000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const mib = 1024 * 1024;
  const json = `${JSON.stringify({ kind: "result", ok: true })}\n`;
  expect(exitCode).toBe(3);
  expect(stdout.length).toBe(4 * mib + json.length);
  expect(stdout.slice(2 * mib, 2 * mib + json.length)).toBe(json);
  expect(stderr.length).toBe(mib);
}, 30_000);
