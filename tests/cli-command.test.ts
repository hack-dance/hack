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

let originalSetupSyncMode: string | undefined;
let originalLogger: string | undefined;

beforeEach(() => {
  originalSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;
  originalLogger = process.env.HACK_LOGGER;
  process.env.HACK_SETUP_SYNC_MODE = "off";
  process.env.HACK_LOGGER = "console";
});

afterEach(() => {
  process.env.HACK_SETUP_SYNC_MODE = originalSetupSyncMode;
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

test("removed surfaces still resolve as top-level migration stubs", () => {
  const authResolved = resolveCommand(CLI_SPEC, ["auth"]);
  const linearResolved = resolveCommand(CLI_SPEC, ["linear"]);

  expect(authResolved.command?.summary).toContain("Removed:");
  expect(linearResolved.command?.summary).toContain("Removed:");
  expect(authResolved.remainingPositionals).toEqual([]);
  expect(linearResolved.remainingPositionals).toEqual([]);
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

test("help shows usage for removed namespace-style commands", async () => {
  const result = await runCliWithCapturedOutput(["help", "org"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage:");
  expect(result.stdout).toContain("hack org [args...]");
  expect(result.stdout).toContain("Removed in v3:");
});

test("dispatch rejects removed GitHub PR automation flags with migration guidance", async () => {
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
  expect(result.stderr).toContain(
    "Built-in GitHub PR automation was removed in Hack v3."
  );
  expect(result.stderr).toContain("gh pr create");
});

test("removed linear stub still emits migration guidance for legacy flags", async () => {
  const result = await runCliWithCapturedOutput([
    "linear",
    "status",
    "--profile",
    "demo",
  ]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("`hack linear status` was removed in v3.");
  expect(result.stderr).toContain("Use repo-local tickets");
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
