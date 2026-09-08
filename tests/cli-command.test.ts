import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  collectAllowedOptionNames,
  parseOptionsForCommand,
  parsePositionalsForCommand,
  resolveCommand,
} from "../src/cli/command.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let originalLogger: string | undefined;

beforeEach(() => {
  originalLogger = process.env.HACK_LOGGER;
  process.env.HACK_LOGGER = "console";
});

afterEach(() => {
  process.env.HACK_LOGGER = originalLogger;
});

test("resolveCommand finds nested subcommand and remaining positionals", () => {
  const resolved = resolveCommand(CLI_SPEC, ["global", "logs", "caddy"]);
  expect(resolved.command?.name).toBe("logs");
  expect(resolved.path.map((c) => c.name)).toEqual(["global", "logs"]);
  expect(resolved.remainingPositionals).toEqual(["caddy"]);
});

test("built-in options are always allowed for a command", () => {
  const resolved = resolveCommand(CLI_SPEC, ["global", "logs"]);
  const allowed = collectAllowedOptionNames(CLI_SPEC, resolved.command);
  expect(allowed.has("help")).toBe(true);
  expect(allowed.has("version")).toBe(true);
});

test("parsePositionalsForCommand throws on extra args", () => {
  expect(() =>
    parsePositionalsForCommand(
      [{ name: "service", required: false }],
      ["caddy", "extra"]
    )
  ).toThrow("Unexpected arguments");
});

test("parseOptionsForCommand converts number options", () => {
  const opts = [
    {
      name: "tail",
      type: "number",
      long: "--tail",
      description: "Tail",
      valueHint: "<n>",
    },
    {
      name: "follow",
      type: "boolean",
      long: "--follow",
      description: "Follow",
    },
  ] as const;

  const parsed = parseOptionsForCommand(opts, { tail: "10", follow: true });
  expect(parsed.tail).toBe(10);
  expect(parsed.follow).toBe(true);
});

test("retired product surfaces no longer resolve", () => {
  for (const command of ["auth", "org", "team", "linear", "tickets"]) {
    expect(resolveCommand(CLI_SPEC, [command]).command).toBeNull();
  }
});

test("resolveCommand exposes host exec path", () => {
  const resolved = resolveCommand(CLI_SPEC, ["host", "exec", "bun", "test"]);
  expect(resolved.command?.name).toBe("exec");
  expect(resolved.path.map((command) => command.name)).toEqual([
    "host",
    "exec",
  ]);
  expect(resolved.remainingPositionals).toEqual(["bun", "test"]);
});

test("dispatch rejects retired GitHub PR automation flags as unknown", async () => {
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

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Unknown option '--pr'");
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
