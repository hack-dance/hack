import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findPassthroughStart,
  parseCliArgv,
  resolveCommand,
} from "../src/cli/command.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * Flags after a child command belong to the child. Hack's own `--version`,
 * `--help`, `--json` and every other Hack option must not consume them, with
 * or without an explicit `--`.
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

const CHILD_FLAGS = [
  ["--version"],
  ["-v"],
  ["--help"],
  ["-h"],
  ["--json"],
  ["--branch", "other"],
  ["--path", "/elsewhere"],
  ["--frozen-lockfile", "--watch=false", "-x"],
] as const;

const PASSTHROUGH = [
  { prefix: ["run", "--profile", "toolchain", "web"], path: ["run"] },
  { prefix: ["exec", "web"], path: ["exec"] },
  { prefix: ["host", "exec"], path: ["host", "exec"] },
  { prefix: ["env", "exec"], path: ["env", "exec"] },
  { prefix: ["x"], path: ["x"] },
] as const;

for (const { prefix, path } of PASSTHROUGH) {
  test.each(
    CHILD_FLAGS.map((flags) => ({ flags: [...flags] }))
  )(`${path.join(" ")} passes $flags after the child command to the child`, ({
    flags,
  }) => {
    const child = ["bun", ...flags];
    for (const explicit of [false, true]) {
      const argv = [...prefix, ...(explicit ? ["--"] : []), ...child];
      const parsed = parse(argv);
      expect(parsed.path).toEqual([...path]);
      expect(parsed.values.version).toBeUndefined();
      expect(parsed.values.help).toBeUndefined();
      expect(parsed.values.json).toBeUndefined();
      expect(parsed.values.branch).toBeUndefined();
      expect(parsed.values.path).toBeUndefined();
      expect(parsed.rest.slice(-child.length)).toEqual(child);
    }
  });
}

test("hack options before the child command still belong to hack", () => {
  const parsed = parse([
    "run",
    "--path",
    "/project",
    "web",
    "--workdir",
    "/app",
    "--profile",
    "toolchain",
    "bun",
    "--version",
  ]);
  expect(parsed.values).toEqual({
    path: "/project",
    workdir: "/app",
    profile: "toolchain",
  });
  expect(parsed.rest).toEqual(["web", "bun", "--version"]);
});

test("a `--` inside the child argv reaches the child unchanged", () => {
  expect(parse(["run", "web", "npm", "test", "--", "--watch"]).rest).toEqual([
    "web",
    "npm",
    "test",
    "--",
    "--watch",
  ]);
  // A leading `--` still ends Hack's options and is not passed on.
  expect(
    parse(["run", "web", "--", "npm", "test", "--", "--watch"]).rest
  ).toEqual(["web", "npm", "test", "--", "--watch"]);
});

test("session exec never gives a flag after the workspace command to Hack", () => {
  const parsed = parse(["session", "exec", "dev", "npm", "--version"]);
  expect(parsed.path).toEqual(["session", "exec"]);
  expect(parsed.values.version).toBeUndefined();
  // The command is one argument, so the extra token is then a usage error
  // rather than Hack printing its own version.
  expect(parsed.rest).toEqual(["dev", "npm", "--version"]);
});

test("Hack's own flags still work before the child command", () => {
  expect(parse(["--version"]).values.version).toBe(true);
  expect(parse(["run", "--help"]).values.help).toBe(true);
  // Before the first child token, `--version` is still Hack's.
  expect(parse(["run", "web", "--version"]).values.version).toBe(true);
  // Commands without a child command keep ordinary parsing.
  expect(parse(["up", "web", "--json"]).values.json).toBe(true);
  expect(findPassthroughStart(CLI_SPEC, ["up", "web", "--json"])).toBeNull();
});

test("the boundary skips option values, including omitted defaulted values", () => {
  expect(
    findPassthroughStart(CLI_SPEC, ["run", "--workdir", "web", "svc", "ls"])
  ).toBe(4);
  // `--tail` has a default: followed by a non-number it takes no value, so
  // `web` is the service, exactly as the parser normalizes it.
  expect(
    findPassthroughStart(CLI_SPEC, ["run", "--tail", "web", "ls", "-la"])
  ).toBe(3);
  expect(
    findPassthroughStart(CLI_SPEC, ["run", "--workdir=/app", "web", "ls"])
  ).toBe(3);
  expect(
    findPassthroughStart(CLI_SPEC, ["run", "web", "--", "ls", "--all"])
  ).toBeNull();
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function cli(args: readonly string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-argv-")));
  roots.push(root);
  const child = Bun.spawn([process.execPath, resolve("index.ts"), ...args], {
    cwd: root,
    env: privateCliEnv({
      root,
      env: { HACK_NO_INTERACTIVE: "1", HACK_LOGGER: "console" },
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

const VERSION_LINE = /^hack v\d/m;
/** A source CLI spawn can take several seconds on a loaded runner. */
const SPAWN_TIMEOUT_MS = 30_000;

test.each([
  [["run", "web", "bun", "--version"]],
  [["run", "--profile", "toolchain", "web", "bun", "--version"]],
  [["run", "web", "--", "bun", "--version"]],
  [["exec", "web", "bun", "--help"]],
  [["host", "exec", "bun", "--version"]],
])(
  "source CLI %j does not print Hack's version or help for a child flag",
  async (args) => {
    const result = await cli(args);
    // No project here: the command itself refuses, but it got that far.
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toMatch(VERSION_LINE);
    expect(result.stdout + result.stderr).not.toContain(
      "hack <command> [options]"
    );
  },
  SPAWN_TIMEOUT_MS
);

test(
  "source CLI --version alone still prints Hack's version",
  async () => {
    const result = await cli(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(VERSION_LINE);
  },
  SPAWN_TIMEOUT_MS
);
