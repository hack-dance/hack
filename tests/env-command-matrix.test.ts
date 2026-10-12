import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { AnyCommandSpec } from "../src/cli/command.ts";
import { optEnv } from "../src/cli/options.ts";
import { runCli } from "../src/cli/run.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";

/**
 * Source check for the "Command and delivery matrix" in docs/env.md: its rows
 * must be exactly the CLI_SPEC command paths that accept `--env`, and each
 * row's Selectors cell must list exactly the env-related flags the command
 * accepts. A command that gains or loses `--env` fails here until the matrix
 * row is added or removed.
 */

const DOC_PATH = resolve(import.meta.dir, "..", "docs", "env.md");
const SECTION_HEADING = "## Command and delivery matrix";
const SELECTOR_FLAGS: ReadonlySet<string> = new Set([
  "--env",
  "--service",
  "--scope",
  "--target",
]);
const ROW_PATTERN = /^\| `hack ([a-z][a-z -]*)` \| ([^|]*) \|/;
const FLAG_PATTERN = /`(--[a-z-]+)`/g;

type EnvCommand = {
  readonly path: string;
  readonly spec: AnyCommandSpec;
};

function envCommands(
  commands: readonly AnyCommandSpec[],
  prefix: readonly string[] = []
): EnvCommand[] {
  const found: EnvCommand[] = [];
  for (const command of commands) {
    const path = [...prefix, command.name];
    if (command.options.some((option) => option.long === "--env")) {
      found.push({ path: path.join(" "), spec: command });
    }
    found.push(...envCommands(command.subcommands, path));
  }
  return found;
}

function matrixRows(doc: string): Map<string, ReadonlySet<string>> {
  const start = doc.indexOf(SECTION_HEADING);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + SECTION_HEADING.length);
  const end = rest.indexOf("\n## ");
  const section = end >= 0 ? rest.slice(0, end) : rest;
  const rows = new Map<string, ReadonlySet<string>>();
  for (const line of section.split("\n")) {
    const match = ROW_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    const path = match[1] ?? "";
    expect(rows.has(path), `duplicate matrix row: hack ${path}`).toBe(false);
    rows.set(
      path,
      new Set(
        [...(match[2] ?? "").matchAll(FLAG_PATTERN)].map(
          (flag) => flag[1] ?? ""
        )
      )
    );
  }
  return rows;
}

function selectorFlags(spec: AnyCommandSpec): ReadonlySet<string> {
  return new Set(
    spec.options
      .map((option) => option.long)
      .filter((long) => SELECTOR_FLAGS.has(long))
  );
}

/** Differences between the documented matrix and CLI_SPEC; empty when in sync. */
function matrixDrift(doc: string): string[] {
  const rows = matrixRows(doc);
  const commands = envCommands(CLI_SPEC.commands);
  const drift: string[] = [];
  for (const { path, spec } of commands) {
    const documented = rows.get(path);
    if (!documented) {
      drift.push(`missing row: hack ${path}`);
      continue;
    }
    const expected = [...selectorFlags(spec)].sort();
    const actual = [...documented].sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      drift.push(
        `selector drift for hack ${path}: expected ${expected.join(",")}, documented ${actual.join(",")}`
      );
    }
  }
  const known = new Set(commands.map((command) => command.path));
  for (const path of rows.keys()) {
    if (!known.has(path)) {
      drift.push(`row without --env in CLI_SPEC: hack ${path}`);
    }
  }
  return drift;
}

describe("env command and delivery matrix", () => {
  test("docs/env.md rows equal the CLI_SPEC commands that accept --env", async () => {
    const doc = await Bun.file(DOC_PATH).text();
    expect(matrixDrift(doc)).toEqual([]);
    expect(matrixRows(doc).size).toBe(envCommands(CLI_SPEC.commands).length);
  });

  test("every --env option shares the one optEnv definition", () => {
    for (const { path, spec } of envCommands(CLI_SPEC.commands)) {
      const option = spec.options.find(
        (candidate) => candidate.long === "--env"
      );
      expect(option, `hack ${path} defines its own --env`).toBe(optEnv);
    }
  });

  test("negative control: removing or adding a matrix row is detected", async () => {
    const doc = await Bun.file(DOC_PATH).text();
    const configPlanRow = doc
      .split("\n")
      .find((line) => line.startsWith("| `hack config plan` |"));
    expect(configPlanRow).toBeDefined();
    expect(matrixDrift(doc.replace(`${configPlanRow}\n`, ""))).toEqual([
      "missing row: hack config plan",
    ]);
    expect(
      matrixDrift(
        doc.replace(
          `${configPlanRow}\n`,
          `${configPlanRow}\n| \`hack logs\` | \`--env\` | x | x | x |\n`
        )
      )
    ).toEqual(["row without --env in CLI_SPEC: hack logs"]);
    expect(
      matrixDrift(
        doc.replace(
          `${configPlanRow}\n`,
          `${configPlanRow?.replace("| `--env` |", "| `--env`, `--service` |")}\n`
        )
      )
    ).toEqual([
      "selector drift for hack config plan: expected --env, documented --env,--service",
    ]);
  });

  test("negative control: a command without --env refuses the flag as unsupported", async () => {
    const commands: readonly AnyCommandSpec[] = CLI_SPEC.commands;
    const ps = commands.find((command) => command.name === "ps");
    expect(ps).toBeDefined();
    expect(ps?.options.some((option) => option.long === "--env")).toBe(false);
    expect(ps?.allowUnknownOptions).not.toBe(true);
    const stdout: Buffer[] = [];
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(Buffer.from(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let code: number;
    try {
      code = await runCli(["ps", "--env", "qa", "--json"]);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
    expect(code).not.toBe(0);
    expect(JSON.parse(Buffer.concat(stdout).toString())).toEqual({
      ok: false,
      error: {
        code: "E_USAGE",
        message: 'Option(s) not valid for "ps": --env',
      },
    });
  });
});
