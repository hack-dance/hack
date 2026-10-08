import { afterEach, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type RunExitEvent, type RunOptions, run } from "../src/lib/shell.ts";
import { runWithTerminalGroup } from "../src/lib/tty-run.ts";

const roots: string[] = [];
const groups: number[] = [];
afterEach(async () => {
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // The exact group created by this test has already been reaped.
    }
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

test("pre-aborted run has no admission, spawn, exit observation or reason output", async () => {
  const controller = new AbortController();
  controller.abort("PRIVATE_ABORT_CANARY");
  const calls: string[] = [];
  const code = await run(
    [process.execPath, "-e", "throw Error('must not spawn')"],
    {
      signal: controller.signal,
      stdin: "ignore",
      beforeSpawn: () => {
        calls.push("admit");
      },
      onSpawn: async () => {
        calls.push("spawn");
      },
      onExit: async () => {
        calls.push("exit");
      },
    }
  );
  expect(code).toBe(143);
  expect(calls).toEqual([]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("abort during final spawn admission refuses pipe and terminal children", async () => {
  for (const terminal of [false, true]) {
    const controller = new AbortController();
    const calls: string[] = [];
    const command = [process.execPath, "-e", "process.exit(0)"];
    const options = {
      signal: controller.signal,
      stdin: "ignore" as const,
      beforeSpawn: () => {
        controller.abort("PRIVATE_ABORT_CANARY");
      },
      onSpawn: async () => {
        calls.push("spawn");
      },
      onExit: async () => {
        calls.push("exit");
      },
    };
    const code = terminal
      ? await runWithTerminalGroup({ ...options, command, env: {} })
      : await run(command, options);
    expect(code).toBe(143);
    expect(calls).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }
});

test("pipe abort reaps a resistant group using the captured signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-shell-abort-"));
  roots.push(root);
  const pidPath = join(root, "descendant.pid");
  const original = new AbortController();
  const replacement = new AbortController();
  let observed: RunExitEvent | undefined;
  const options: RunOptions & { signal: AbortSignal } = {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeoutMs: 10_000,
    signal: original.signal,
    onSpawn: async ({ pid, ownsProcessGroup }) => {
      groups.push(pid);
      expect(ownsProcessGroup).toBe(true);
      options.signal = replacement.signal;
      const deadline = Date.now() + 2000;
      while (!(await Bun.file(pidPath).exists()) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(await Bun.file(pidPath).exists()).toBe(true);
      original.abort("PRIVATE_ABORT_CANARY");
    },
    onExit: async (event) => {
      observed = event;
    },
  };
  const started = Date.now();
  const code = await run(
    [
      "/bin/sh",
      "-c",
      "trap '' TERM INT; (trap '' TERM INT; sleep 30) & echo $! > \"$1\"; wait",
      "sh",
      pidPath,
    ],
    options
  );
  expect(code).toBe(143);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(observed).toMatchObject({
    cancelled: true,
    timedOut: false,
    exitCode: 143,
  });
  const descendant = Number.parseInt(
    (await readFile(pidPath, "utf8")).trim(),
    10
  );
  await Bun.sleep(50);
  expect(processAlive(descendant)).toBe(false);
  expect(processAlive(-(groups.at(-1) ?? 0))).toBe(false);
  expect(getEventListeners(original.signal, "abort")).toHaveLength(0);
  expect(getEventListeners(replacement.signal, "abort")).toHaveLength(0);
}, 10_000);

test("pipe settlement removes the abort listener before slow diagnostics and later abort", async () => {
  const controller = new AbortController();
  let outcome: RunExitEvent | undefined;
  const code = await run([process.execPath, "-e", "process.exit(7)"], {
    signal: controller.signal,
    stdin: "ignore",
    onSpawn: async () => {
      await Bun.sleep(100);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      controller.abort("PRIVATE_LATE_CANARY");
    },
    onExit: async (event) => {
      outcome = event;
    },
  });
  expect(code).toBe(7);
  expect(outcome).toMatchObject({
    cancelled: false,
    timedOut: false,
    exitCode: 7,
  });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("spawn admission cannot replace captured argv, env or abort signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-shell-snapshot-"));
  roots.push(root);
  const output = join(root, "out.txt");
  const original = new AbortController();
  const replacement = new AbortController();
  replacement.abort();
  const command = [
    process.execPath,
    "-e",
    "await Bun.write(process.argv[1], process.env.CAPTURED ?? 'missing');",
    output,
  ];
  const env = { CAPTURED: "original" };
  const options = {
    stdin: "ignore" as const,
    env,
    signal: original.signal,
    beforeSpawn: () => {
      command[2] = "process.exit(8)";
      env.CAPTURED = "replacement";
      options.signal = replacement.signal;
    },
  };
  expect(await run(command, options)).toBe(0);
  expect(await readFile(output, "utf8")).toBe("original");
});

for (const mode of [
  "pre-abort",
  "active-abort",
  "late-abort",
  "os-int",
  "os-term",
] as const) {
  test.skipIf(!Bun.which("python3"))(
    `TTY ${mode} uses the same owned cancellation and restores foreground`,
    async () => {
      const proc = Bun.spawn(
        [
          "python3",
          resolve(import.meta.dir, "fixtures/shell-abort-pty.py"),
          "probe",
          process.execPath,
          resolve(import.meta.dir, "fixtures/shell-abort.ts"),
          mode,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).not.toContain("PRIVATE_ABORT_CANARY");
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({
        code: mode === "late-abort" ? 7 : mode === "os-int" ? 130 : 143,
        foregroundRestored: true,
        siblingAlive: true,
        childAlive: false,
        grandchildAlive: false,
        listenersAfter: 0,
        spawned: mode !== "pre-abort",
      });
      if (mode !== "pre-abort") {
        expect(result.tty).toMatchObject({
          stdin: true,
          devTty: true,
          foreground: true,
        });
        expect(result.exit).toMatchObject({
          cancelled: ["active-abort", "os-int", "os-term"].includes(mode),
          timedOut: false,
        });
      }
    },
    20_000
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`pipe controller-first ${signal} preserves the OS exit code and reaps its group`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-shell-abort-os-"));
    roots.push(root);
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "fixtures/shell-abort.ts"),
        signal === "SIGINT" ? "pipe-int" : "pipe-term",
        root,
        "unused",
        "unused",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      const deadline = Date.now() + 3000;
      const ready = join(root, "grandchild.pid");
      while (!(await Bun.file(ready).exists()) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(await Bun.file(ready).exists()).toBe(true);
      const group = Number(await Bun.file(join(root, "group.pid")).text());
      groups.push(group);
      process.kill(child.pid, signal);
      expect(await child.exited).toBe(0);
      const result = JSON.parse(
        await Bun.file(join(root, "result.json")).text()
      );
      expect(result).toMatchObject({
        code: signal === "SIGINT" ? 130 : 143,
        listenersAfter: 0,
        exit: { cancelled: true, timedOut: false },
      });
      expect(processAlive(-group)).toBe(false);
      expect(processAlive(Number(await Bun.file(ready).text()))).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 15_000);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
