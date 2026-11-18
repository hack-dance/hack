import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLifecycleCommands } from "../src/commands/project.ts";
import {
  childStdoutTarget,
  reserveStdoutForMachineOutput,
  resetStdoutReservationForTests,
} from "../src/lib/machine-stdout.ts";

/*
 * HACK-2311: once Hack's own `--json` reserved stdout, a lifecycle hook's
 * output reaches stderr even from a call site that passes no
 * `routeStdoutToStderr` (the native up/down hook paths, and any added later).
 */

const HOOK_OUT_LINE = /^hook-out$/m;
const HOOK_ERR_LINE = /^hook-err$/m;

let root: string | null = null;

afterEach(async () => {
  resetStdoutReservationForTests();
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

/** Runs `fn` while capturing what this process writes to stdout and stderr. */
async function capture(
  fn: () => Promise<number>
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

async function runPrintingHook(): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  root = await mkdtemp(join(tmpdir(), "hack-stdout-reserved-"));
  const projectDir = join(root, ".hack");
  await mkdir(projectDir, { mode: 0o700 });
  return await capture(() =>
    // The option is omitted, as at the native hook call sites.
    runLifecycleCommands({
      title: "fixture hook",
      commands: [{ command: "printf 'hook-out\\n'; printf 'hook-err\\n' >&2" }],
      projectRoot: root as string,
      projectDir,
      composeProject: "fixture",
      env: { PATH: "/usr/bin:/bin" },
    })
  );
}

test("with stdout reserved, hook output reaches stderr without the per-call option", async () => {
  reserveStdoutForMachineOutput();
  const result = await runPrintingHook();
  expect(result.code).toBe(0);
  // Whole output lines: the logger's step line echoes the command text.
  expect(result.stdout).not.toMatch(HOOK_OUT_LINE);
  expect(result.stdout).not.toMatch(HOOK_ERR_LINE);
  expect(result.stderr).toMatch(HOOK_OUT_LINE);
  expect(result.stderr).toMatch(HOOK_ERR_LINE);
});

test("without the reservation, hook stdout still reaches stdout", async () => {
  const result = await runPrintingHook();
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(HOOK_OUT_LINE);
  expect(result.stderr).toMatch(HOOK_ERR_LINE);
});

test("child stdout is routed to stderr when asked or when reserved", () => {
  expect(childStdoutTarget(undefined)).toBe("inherit");
  expect(childStdoutTarget(false)).toBe("inherit");
  expect(childStdoutTarget(true)).toBe("stderr");
  reserveStdoutForMachineOutput();
  expect(childStdoutTarget(undefined)).toBe("stderr");
  expect(childStdoutTarget(false)).toBe("stderr");
});
