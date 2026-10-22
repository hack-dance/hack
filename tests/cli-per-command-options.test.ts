import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AnyCommandSpec,
  builtinOptions,
  defineCli,
  defineCommand,
  defineOption,
  findPassthroughStart,
  type OptionSpec,
  parseCliArgv,
  resolveCommand,
} from "../src/cli/command.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * argv is parsed against the resolved command's own options plus the global
 * and built-in ones, so a short flag or an option type declared by one command
 * never changes how another command parses. `-p` is `--path` for project
 * commands and `--port` for `ssh`.
 */

function parse(argv: readonly string[]) {
  const parsed = parseCliArgv(CLI_SPEC, argv);
  const resolved = resolveCommand(CLI_SPEC, parsed.positionals);
  return {
    values: parsed.values,
    path: resolved.path.map((command) => command.name),
    rest: resolved.remainingPositionals,
  };
}

/** Every command path whose own options include `--path` with `-p`. */
function commandsWithShortPath(): readonly (readonly string[])[] {
  const out: string[][] = [];
  const walk = (
    commands: readonly AnyCommandSpec[],
    parent: readonly string[]
  ) => {
    for (const command of commands) {
      const path = [...parent, command.name];
      if (
        command.options.some(
          (option) => option.long === "--path" && option.short === "-p"
        )
      ) {
        out.push(path);
      }
      walk(command.subcommands, path);
    }
  };
  walk(CLI_SPEC.commands, []);
  return out;
}

test("-p is --path for every command that declares it", () => {
  const commands = commandsWithShortPath();
  for (const expected of [
    ["init"],
    ["up"],
    ["down"],
    ["ps"],
    ["logs"],
    ["env", "list"],
    ["config", "validate"],
    ["setup", "migrate"],
  ]) {
    expect(commands).toContainEqual(expected);
  }
  for (const command of commands) {
    const parsed = parse([...command, "-p", "/repo"]);
    expect({ command, path: parsed.path, values: parsed.values }).toEqual({
      command,
      path: [...command],
      values: { path: "/repo" },
    });
  }
});

test("ssh -p <port> sets --port", () => {
  const parsed = parse(["ssh", "-p", "2222"]);
  expect(parsed.path).toEqual(["ssh"]);
  expect(parsed.values.port).toBe("2222");
  expect(parsed.values.path).toBeUndefined();
});

test("a short flag before the command name still follows that command", () => {
  expect(parse(["-p", "/repo", "up"]).values).toEqual({ path: "/repo" });
  expect(parse(["-p", "2222", "ssh"]).values).toEqual({ port: "2222" });
});

test("an option another command declares is refused as not valid here", () => {
  // Parsed by long name so the refusal can name it; never by its short flag.
  expect(parse(["up", "--port", "2222"]).values).toEqual({ port: "2222" });
  expect(() => parse(["up", "-x"])).toThrow("Unknown option '-x'");
});

/**
 * HACK-1371: only a long spelling reaches the "not valid for" refusal. A short
 * spelling the resolved command does not declare is unknown to its parse even
 * when another command declares it (`-f` is `--follow` for `logs`, `-d` is
 * `--detach` for `up`). The parse over every command's options that #370
 * replaced read it as that long option and refused it as not valid instead.
 */
test("a short spelling only another command declares is unknown here", () => {
  const ownOptions: readonly OptionSpec[] = [
    ...builtinOptions(),
    ...CLI_SPEC.globalOptions,
    ...(CLI_SPEC.commands.find((command) => command.name === "doctor")
      ?.options ?? []),
  ];
  const own = new Set(
    ownOptions.flatMap((option) => (option.short ? [option.short] : []))
  );
  const others = new Set<string>();
  const walk = (commands: readonly AnyCommandSpec[]) => {
    for (const command of commands) {
      for (const option of command.options) {
        if (option.short && !own.has(option.short)) {
          others.add(option.short);
        }
      }
      walk(command.subcommands);
    }
  };
  walk(CLI_SPEC.commands);
  for (const expected of ["-f", "-d", "-c", "-H", "-u", "-t"]) {
    expect(others).toContain(expected);
  }
  for (const short of others) {
    expect(() => parse(["doctor", short])).toThrow(
      `Unknown option '${short}'. To specify a positional argument starting with a '-'`
    );
  }
  // The long spelling still parses, so the CLI can name it as not valid.
  expect(parse(["doctor", "--follow"]).values).toEqual({ follow: true });
});

test("config adopt --rollback stays boolean; setup migrate --rollback-manifest takes a value", () => {
  const adopt = parse(["config", "adopt", "--rollback", "--json"]);
  expect(adopt.path).toEqual(["config", "adopt"]);
  expect(adopt.values).toEqual({ rollback: true, json: true });
  expect(adopt.rest).toEqual([]);

  const migrate = parse([
    "setup",
    "migrate",
    "--rollback-manifest",
    "manifest.json",
    "--json",
  ]);
  expect(migrate.path).toEqual(["setup", "migrate"]);
  expect(migrate.values).toEqual({
    "rollback-manifest": "manifest.json",
    json: true,
  });
});

const optFlag = defineOption({
  name: "rollback",
  type: "boolean",
  long: "--rollback",
  short: "-r",
  description: "Boolean in alpha",
} as const);

const optValue = defineOption({
  name: "rollback",
  type: "string",
  long: "--rollback",
  short: "-r",
  valueHint: "<file>",
  description: "Value in beta",
} as const);

const optTarget = defineOption({
  name: "target",
  type: "string",
  long: "--target",
  short: "-t",
  description: "Value in gamma, which also takes alpha's boolean --rollback",
} as const);

const COLLIDING_CLI = defineCli({
  name: "demo",
  version: "0.0.0",
  summary: "Commands that reuse one spelling with different types",
  globalOptions: [],
  commands: [
    defineCommand({
      name: "alpha",
      summary: "boolean --rollback",
      group: "Project",
      options: [optFlag],
      positionals: [{ name: "rest", multiple: true }],
      subcommands: [],
    } as const),
    defineCommand({
      name: "gamma",
      summary: "child command",
      group: "Project",
      options: [optFlag, optTarget],
      positionals: [{ name: "command", multiple: true, passthrough: true }],
      subcommands: [],
    } as const),
    // Declared last, so a last-declaration-wins union would read `-r` and
    // `--rollback` as taking a value everywhere.
    defineCommand({
      name: "beta",
      summary: "value --rollback",
      group: "Project",
      options: [optValue],
      positionals: [{ name: "rest", multiple: true }],
      subcommands: [],
    } as const),
  ],
} as const);

test("one spelling may have a different type in each command", () => {
  for (const flag of ["--rollback", "-r"]) {
    const alpha = parseCliArgv(COLLIDING_CLI, ["alpha", flag, "keep"]);
    expect(alpha.values).toEqual({ rollback: true });
    expect(alpha.positionals).toEqual(["alpha", "keep"]);

    const beta = parseCliArgv(COLLIDING_CLI, ["beta", flag, "file.json"]);
    expect(beta.values).toEqual({ rollback: "file.json" });
    expect(beta.positionals).toEqual(["beta"]);
  }
});

test("a spelling with disagreeing types before the command name never eats it", () => {
  // Before `alpha` resolves, `-r` is a flag in alpha and takes a value in
  // beta, so it is read as a flag and `alpha` stays the command name.
  const alpha = parseCliArgv(COLLIDING_CLI, ["-r", "alpha", "keep"]);
  expect(alpha.values).toEqual({ rollback: true });
  expect(alpha.positionals).toEqual(["alpha", "keep"]);
});

test("the child-command boundary uses the resolved command's option types", () => {
  // In gamma `-r` is boolean, although beta declares it with a value: the
  // child command starts right after it, and `-t` still takes `x`.
  expect(
    findPassthroughStart(COLLIDING_CLI, ["gamma", "-r", "-t", "x", "ls", "-r"])
  ).toBe(4);
  const parsed = parseCliArgv(COLLIDING_CLI, [
    "gamma",
    "-r",
    "-t",
    "x",
    "ls",
    "-r",
  ]);
  expect(parsed.values).toEqual({ rollback: true, target: "x" });
  expect(parsed.positionals).toEqual(["gamma", "ls", "-r"]);
  expect(findPassthroughStart(COLLIDING_CLI, ["gamma", "-r", "ls"])).toBe(2);
});

test("a lone - is a positional, so it can start the child command", () => {
  // `-` is never an option: here it is gamma's child command, and the `-r`
  // after it belongs to the child.
  expect(findPassthroughStart(COLLIDING_CLI, ["gamma", "-", "-r"])).toBe(1);
  expect(parseCliArgv(COLLIDING_CLI, ["gamma", "-", "-r"]).positionals).toEqual(
    ["gamma", "-", "-r"]
  );
});

/**
 * A passthrough command that also has a subcommand, so a subcommand name can
 * appear after the command's own positional.
 */
const SUBCOMMAND_CLI = defineCli({
  name: "demo",
  version: "0.0.0",
  summary: "A passthrough command with a subcommand",
  globalOptions: [],
  commands: [
    defineCommand({
      name: "delta",
      summary: "service then child command",
      group: "Project",
      options: [optFlag],
      positionals: [
        { name: "service" },
        { name: "command", multiple: true, passthrough: true },
      ],
      subcommands: [
        defineCommand({
          name: "ls",
          summary: "a subcommand of delta",
          group: "Project",
          options: [],
          positionals: [],
          subcommands: [],
        } as const),
      ],
    } as const),
  ],
} as const);

test("after a command's own positional, a subcommand name is the child command", () => {
  // `ls` names a subcommand of delta only before delta's first positional;
  // after `web` it is the child command, and its `-r` belongs to the child.
  expect(
    findPassthroughStart(SUBCOMMAND_CLI, ["delta", "web", "ls", "-r"])
  ).toBe(2);
  // Before any positional, `ls` still resolves as the subcommand.
  expect(
    findPassthroughStart(SUBCOMMAND_CLI, ["delta", "ls", "-r"])
  ).toBeNull();
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** A source CLI spawn can take several seconds on a loaded runner. */
const SPAWN_TIMEOUT_MS = 30_000;

test(
  "source CLI accepts -p as --path for a project command",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hack-short-")));
    roots.push(root);
    const child = Bun.spawn(
      [process.execPath, resolve("index.ts"), "ps", "-p", root, "--json"],
      {
        cwd: root,
        env: privateCliEnv({
          root,
          env: { HACK_NO_INTERACTIVE: "1", HACK_LOGGER: "console" },
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      }
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // No project in the fixture: `ps` itself refuses, but it got the path.
    expect(stdout + stderr).not.toContain("--port");
    expect(stdout + stderr).not.toContain("not valid for");
  },
  SPAWN_TIMEOUT_MS
);
