import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  renderHelpForPath,
  renderHelpMarkdownForPath,
} from "../src/cli/help.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let originalAck: string | undefined;

beforeEach(() => {
  originalAck = process.env.HACK_EXPERIMENTAL_ACK;
  Reflect.deleteProperty(process.env, "HACK_EXPERIMENTAL_ACK");
});

afterEach(() => {
  if (originalAck === undefined) {
    Reflect.deleteProperty(process.env, "HACK_EXPERIMENTAL_ACK");
  } else {
    process.env.HACK_EXPERIMENTAL_ACK = originalAck;
  }
});

test("default `hack --help` hides experimental commands behind one line", async () => {
  const result = await runCliWithCapturedOutput(["--help"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("experimental command");
  expect(result.stdout).toContain("hack help --all");
  expect(result.stdout).not.toMatch(/hack remote\s+Beta:/);
  expect(result.stdout).not.toMatch(/hack gateway\s+/);
});

test("`hack help --all` lists experimental commands", async () => {
  const result = await runCliWithCapturedOutput(["help", "--all"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/hack remote/);
  expect(result.stdout).not.toContain("hidden — run `hack help --all`");
});

test("`hack help <experimental-cmd>` still renders command help", async () => {
  const result = await runCliWithCapturedOutput(["help", "remote"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("hack remote");
});

test("pure renderers keep experimental commands visible by default", () => {
  expect(renderHelpForPath(CLI_SPEC, [])).toMatch(/hack remote\s+Beta:/);
  expect(renderHelpMarkdownForPath(CLI_SPEC, [])).toContain("`hack remote`");
});

test("invoking an experimental command warns once on stderr", async () => {
  const result = await runCliWithCapturedOutput([
    "dispatch",
    "run",
    "--project",
    "demo",
    "--pr",
    "--",
    "echo",
    "hi",
  ]);

  const warnings = result.stderr
    .split("\n")
    .filter((line) => line.includes("experimental and unsupported"));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("hack dispatch");
  expect(warnings[0]).toContain("HACK_EXPERIMENTAL_ACK=1");
});

test("HACK_EXPERIMENTAL_ACK=1 suppresses the experimental warning", async () => {
  process.env.HACK_EXPERIMENTAL_ACK = "1";
  const result = await runCliWithCapturedOutput([
    "dispatch",
    "run",
    "--project",
    "demo",
    "--pr",
    "--",
    "echo",
    "hi",
  ]);

  expect(result.stderr).not.toContain("experimental and unsupported");
});

async function runCliWithCapturedOutput(
  args: readonly string[]
): Promise<CapturedRunResult> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  try {
    const { runCli } = await import("../src/cli/run.ts");
    const exitCode = await runCli(args);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}
