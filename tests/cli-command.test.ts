import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  type AnyCommandSpec,
  builtinOptions,
  collectAllowedOptionNames,
  type OptionSpec,
  parseCliArgv,
  parseOptionsForCommand,
  parsePositionalsForCommand,
  resolveCommand,
} from "../src/cli/command.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { restoreEnv } from "./helpers/env.ts";

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
  restoreEnv("HACK_LOGGER", originalLogger);
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

test("parsePositionalsForCommand never echoes the extra arguments", () => {
  // An extra argument is often a pasted `KEY=value`; only the count is shown.
  expect(() =>
    parsePositionalsForCommand([], ["API_TOKEN=synthetic-extra-4c2d", "more"])
  ).toThrow(
    "Unexpected arguments: 2 more than this command accepts. They are not shown because they may contain values."
  );
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

/**
 * argv is parsed with the resolved command's options plus the global and
 * built-in ones, so a spelling may mean different options in different
 * commands (`-p` is `--path` for project commands and `--port` for `ssh`).
 * Within one command's scope, each long and short spelling must name exactly
 * one option, or the parser would silently pick one of them.
 */
test("each command scope declares every option spelling once", () => {
  const conflicts: string[] = [];
  const check = (opts: {
    readonly owner: string;
    readonly options: readonly OptionSpec[];
  }) => {
    const seen = new Map<string, OptionSpec>();
    for (const option of opts.options) {
      for (const spelling of [option.long, option.short]) {
        if (spelling === undefined) {
          continue;
        }
        const previous = seen.get(spelling);
        if (previous !== undefined && previous !== option) {
          conflicts.push(
            `${opts.owner}: ${spelling} names ${previous.long} and ${option.long}`
          );
        }
        seen.set(spelling, option);
      }
    }
  };
  const shared = [...builtinOptions(), ...CLI_SPEC.globalOptions];
  check({ owner: "hack", options: shared });
  const walk = (
    commands: readonly AnyCommandSpec[],
    parent: readonly string[]
  ) => {
    for (const command of commands) {
      const path = [...parent, command.name];
      check({
        owner: ["hack", ...path].join(" "),
        options: [...shared, ...command.options],
      });
      walk(command.subcommands, path);
    }
  };
  walk(CLI_SPEC.commands, []);

  expect(conflicts).toEqual([]);
});

test("boolean config adopt --rollback does not consume the next flag", () => {
  const adopt = parseCliArgv(CLI_SPEC, [
    "config",
    "adopt",
    "--rollback",
    "--json",
  ]);
  expect(adopt.values.rollback).toBe(true);
  expect(adopt.values.json).toBe(true);
  expect(adopt.positionals).toEqual(["config", "adopt"]);

  const migrate = parseCliArgv(CLI_SPEC, [
    "setup",
    "migrate",
    "--rollback-manifest",
    "manifest.json",
    "--json",
  ]);
  expect(migrate.values["rollback-manifest"]).toBe("manifest.json");
  expect(migrate.values.json).toBe(true);
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
