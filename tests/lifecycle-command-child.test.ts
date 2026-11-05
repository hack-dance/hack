import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { runLifecycleCommandChild } from "../src/lib/lifecycle-command-child.ts";
import { readLinesFromStream } from "../src/ui/lines.ts";

// Real `sh -c` children: cancellation must reach the whole owned process
// group, not only the shell, and a forced stop must not wait on output pipes.

/**
 * Shells (with their process groups and children) and escaped processes these
 * tests started; killed even when an assertion fails first.
 */
const owned: { readonly id: number; readonly group: boolean }[] = [];
function kill(target: number): void {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Already gone.
  }
}
afterEach(() => {
  for (const { id, group } of owned.splice(0)) {
    if (group) {
      kill(-id);
      // Without an owned group, the shell's children are only reachable by parent.
      Bun.spawnSync(["pkill", "-KILL", "-P", `${id}`]);
    }
    kill(id);
  }
});

function gone(group: number): boolean {
  try {
    process.kill(-group, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function settledGroup(group: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (gone(group)) {
      return true;
    }
    await Bun.sleep(25);
  }
  return false;
}

/** Collect output lines; resolve `marker` with the first line starting with it. */
function collector(marker: string) {
  const lines: string[] = [];
  let found: (line: string) => void = () => undefined;
  const first = new Promise<string>((resolve) => {
    found = resolve;
  });
  return {
    lines,
    first,
    drain: async (stream: ReadableStream<Uint8Array>) => {
      for await (const line of readLinesFromStream(stream)) {
        lines.push(line);
        if (line.startsWith(marker)) {
          found(line);
        }
      }
    },
  };
}

function field(line: string): number {
  const value = Number(line.split(" ")[1]);
  expect(Number.isSafeInteger(value) && value > 1).toBe(true);
  return value;
}

test(
  "cancel stops the shell and its sleep child together and does not wait for output",
  async () => {
    const output = collector("group ");
    const controller = new AbortController();
    const started = performance.now();
    const result = runLifecycleCommandChild({
      command:
        'echo "group $$ $(ps -o pgid= -p $$ | tr -d " ")"; sleep 30; echo finished',
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      signal: controller.signal,
      drain: output.drain,
    });
    const line = await output.first;
    const group = field(line);
    owned.push({ id: group, group: true });
    controller.abort();
    expect(await result).toBe(130);
    expect(performance.now() - started).toBeLessThan(1500);
    // The shell led its own process group, and no member outlived the cancel.
    expect(line.split(" ")[2]).toBe(String(group));
    expect(await settledGroup(group)).toBe(true);
    expect(output.lines).not.toContain("finished");
  },
  { timeout: 10_000 }
);

test(
  "descendants that ignore SIGTERM are killed after the grace period",
  async () => {
    const output = collector("group ");
    const controller = new AbortController();
    const result = runLifecycleCommandChild({
      command: "trap '' TERM; echo \"group $$\"; sleep 30; echo finished",
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      signal: controller.signal,
      graceMs: 200,
      drain: output.drain,
    });
    const group = field(await output.first);
    owned.push({ id: group, group: true });
    const canceled = performance.now();
    controller.abort();
    expect(await result).toBe(130);
    expect(performance.now() - canceled).toBeLessThan(1500);
    expect(await settledGroup(group)).toBe(true);
    expect(output.lines).not.toContain("finished");
  },
  { timeout: 10_000 }
);

test.skipIf(!Bun.which("perl"))(
  "output draining after cancel is bounded when an escaped process holds the pipes",
  async () => {
    const output = collector("escaped ");
    const controller = new AbortController();
    const result = runLifecycleCommandChild({
      // The perl child starts its own session, so the group signal misses it
      // while it keeps the inherited stdout pipe open.
      command:
        'perl -MPOSIX -e \'POSIX::setsid(); $| = 1; print "escaped $$ ", getppid(), "\\n"; sleep 30\' & sleep 30',
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      signal: controller.signal,
      graceMs: 200,
      drain: output.drain,
    });
    const line = await output.first;
    owned.push(
      { id: field(line), group: false },
      { id: Number(line.split(" ")[2]), group: true }
    );
    const canceled = performance.now();
    controller.abort();
    expect(await result).toBe(130);
    expect(performance.now() - canceled).toBeLessThan(1500);
  },
  { timeout: 10_000 }
);

test(
  "without a signal the command keeps the caller's process group and its exit status",
  async () => {
    const output = collector("group ");
    const caller = Bun.spawnSync(["ps", "-o", "pgid=", "-p", `${process.pid}`])
      .stdout.toString()
      .trim();
    const code = await runLifecycleCommandChild({
      command:
        'echo "group $(ps -o pgid= -p $$ | tr -d " ")"; echo done >&2; exit 7',
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      drain: output.drain,
    });
    expect(code).toBe(7);
    expect(output.lines).toEqual([`group ${caller}`, "done"]);
  },
  { timeout: 10_000 }
);
