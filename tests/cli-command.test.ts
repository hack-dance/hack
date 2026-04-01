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
  if (originalSetupSyncMode !== undefined) {
    process.env.HACK_SETUP_SYNC_MODE = originalSetupSyncMode;
  } else {
    process.env.HACK_SETUP_SYNC_MODE = undefined;
  }
  if (originalLogger !== undefined) {
    process.env.HACK_LOGGER = originalLogger;
  } else {
    process.env.HACK_LOGGER = undefined;
  }
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

test("resolveCommand finds crash-capture command", () => {
  const resolved = resolveCommand(CLI_SPEC, ["crash-capture"]);
  expect(resolved.command?.name).toBe("crash-capture");
  expect(resolved.path.map((command) => command.name)).toEqual([
    "crash-capture",
  ]);
  expect(resolved.remainingPositionals).toEqual([]);
});

test("linear command metadata advertises project artifact workflows", () => {
  const resolved = resolveCommand(CLI_SPEC, ["linear"]);
  expect(resolved.command?.summary).toBe(
    "Connect Linear and sync repo work with Linear projects/issues"
  );
  expect(resolved.command?.description).toContain(
    "hack linear documents list|pull|plan|apply"
  );
  expect(resolved.command?.description).toContain(
    "hack linear milestones list|pull|plan|apply"
  );
  expect(resolved.command?.description).toContain(
    "hack linear status-updates list|pull|plan|publish"
  );
});

test("resolveCommand finds nested project owner show command", () => {
  const resolved = resolveCommand(CLI_SPEC, ["project", "owner", "show"]);
  expect(resolved.command?.name).toBe("show");
  expect(resolved.path.map((command) => command.name)).toEqual([
    "project",
    "owner",
    "show",
  ]);
  expect(resolved.remainingPositionals).toEqual([]);
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

test("resolveCommand exposes org, team, and auth invite command paths", () => {
  const orgResolved = resolveCommand(CLI_SPEC, ["org", "member", "invite"]);
  expect(orgResolved.command?.name).toBe("invite");
  expect(orgResolved.path.map((command) => command.name)).toEqual([
    "org",
    "member",
    "invite",
  ]);

  const teamResolved = resolveCommand(CLI_SPEC, ["team", "member", "remove"]);
  expect(teamResolved.command?.name).toBe("remove");
  expect(teamResolved.path.map((command) => command.name)).toEqual([
    "team",
    "member",
    "remove",
  ]);

  const authInviteResolved = resolveCommand(CLI_SPEC, [
    "auth",
    "invite",
    "accept",
  ]);
  expect(authInviteResolved.command?.name).toBe("accept");
  expect(authInviteResolved.path.map((command) => command.name)).toEqual([
    "auth",
    "invite",
    "accept",
  ]);
});

test("help shows subcommand usage for namespace commands", async () => {
  const result = await runCliWithCapturedOutput(["help", "org"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage:");
  expect(result.stdout).toContain("hack org <subcommand> [options]");
  expect(result.stdout).toContain("hack org member");
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
