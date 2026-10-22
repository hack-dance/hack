import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AnyCommandSpec } from "../src/cli/command.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { MISSING_PROJECT_MESSAGE } from "../src/lib/missing-project-error.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1339, HACK-1371: every project command reports a `--path` without a
 * project with the same closed code, `E_PROJECT_NOT_FOUND`. Under `--json` it
 * is one envelope; without `--json` it is one `ERROR: E_PROJECT_NOT_FOUND:`
 * line and no stack. `docs/cli.md` lists the commands and the exceptions
 * pinned below.
 *
 * The table classifies every command that declares `--path`, so a new one
 * fails the enumeration test until its missing-project behaviour is pinned.
 */

/** A JavaScript stack frame as Bun prints it. */
const STACK_FRAME = /^\s+at /m;
/** A source CLI spawn can take several seconds on a loaded runner. */
const SPAWN_TIMEOUT_MS = 30_000;
/** The target-inspect contract's own E_PROJECT_NOT_FOUND message. */
const TARGET_MESSAGE = "No hack project found at the selected location.";
const NATIVE_VALIDATION_MESSAGE =
  "Project-aware native validation requires an exact native input family; values omitted.";

/** `DIR` in an argv is replaced with the empty fixture directory. */
type Argv = readonly string[];

type Expectation =
  /** `{ok:false, error:{code:"E_PROJECT_NOT_FOUND", message}}` on stdout. */
  | { readonly kind: "envelope"; readonly argv: Argv }
  /** Exactly one closed `ERROR: E_PROJECT_NOT_FOUND:` line on stderr. */
  | { readonly kind: "line"; readonly argv: Argv }
  /** The target-inspect E_PROJECT_NOT_FOUND envelope, which adds a detail. */
  | { readonly kind: "target-envelope"; readonly argv: Argv }
  /** A documented exception: exact stdout and stderr. */
  | {
      readonly kind: "exception";
      readonly argv: Argv;
      readonly stdout: string;
      readonly stderr: string;
    }
  /** Does not require an existing project, or is outside the supported CLI. */
  | { readonly kind: "not-a-project-command"; readonly reason: string };

const NOT_REQUIRED = "creates, diagnoses or configures without a project";
const UNSUPPORTED = "unsupported or internal command";

const COMMANDS: Readonly<Record<string, Expectation>> = {
  up: { kind: "envelope", argv: ["up", "-p", "DIR", "--json"] },
  down: { kind: "envelope", argv: ["down", "-p", "DIR", "--json"] },
  restart: { kind: "envelope", argv: ["restart", "-p", "DIR", "--json"] },
  ps: { kind: "envelope", argv: ["ps", "-p", "DIR", "--json"] },
  logs: { kind: "envelope", argv: ["logs", "-p", "DIR", "--json"] },
  open: { kind: "envelope", argv: ["open", "-p", "DIR", "--json"] },
  run: { kind: "line", argv: ["run", "-p", "DIR", "web", "true"] },
  exec: { kind: "line", argv: ["exec", "-p", "DIR", "web", "true"] },
  // Without a TTY, tui refuses before it looks for a project; with one it
  // reports E_PROJECT_NOT_FOUND (tests/cli-renderer-loading.test.ts).
  tui: {
    kind: "exception",
    argv: ["tui", "-p", "DIR"],
    stdout: "",
    stderr:
      "ERROR: TUI requires a TTY. Run this from an interactive terminal.\n",
  },
  "branch add": { kind: "line", argv: ["branch", "add", "x", "-p", "DIR"] },
  "branch list": { kind: "line", argv: ["branch", "list", "-p", "DIR"] },
  "branch remove": {
    kind: "line",
    argv: ["branch", "remove", "x", "-p", "DIR"],
  },
  "branch open": { kind: "line", argv: ["branch", "open", "x", "-p", "DIR"] },
  "config get": { kind: "line", argv: ["config", "get", "name", "-p", "DIR"] },
  "config set": {
    kind: "line",
    argv: ["config", "set", "name", "x", "-p", "DIR"],
  },
  "env list": {
    kind: "envelope",
    argv: ["env", "list", "-p", "DIR", "--json"],
  },
  "env explain": { kind: "line", argv: ["env", "explain", "K", "-p", "DIR"] },
  "env apply": {
    kind: "line",
    argv: ["env", "apply", "--service", "web", "-p", "DIR"],
  },
  "env add": { kind: "line", argv: ["env", "add", "K", "V", "-p", "DIR"] },
  "env set": { kind: "line", argv: ["env", "set", "K", "V", "-p", "DIR"] },
  "env unset": { kind: "line", argv: ["env", "unset", "K", "-p", "DIR"] },
  "env hydrate": { kind: "line", argv: ["env", "hydrate", "-p", "DIR"] },
  "env materialize": {
    kind: "line",
    argv: ["env", "materialize", "-p", "DIR"],
  },
  "env exec": { kind: "line", argv: ["env", "exec", "-p", "DIR", "true"] },
  "env shell": { kind: "line", argv: ["env", "shell", "-p", "DIR"] },
  "host exec": { kind: "line", argv: ["host", "exec", "-p", "DIR", "true"] },
  "host shell": { kind: "line", argv: ["host", "shell", "-p", "DIR"] },
  "project owner show": {
    kind: "envelope",
    argv: ["project", "owner", "show", "-p", "DIR", "--json"],
  },
  // env get prints raw values, so every failure is its fixed stderr text.
  "env get": {
    kind: "exception",
    argv: ["env", "get", "K", "-p", "DIR", "--json"],
    stdout: "",
    stderr:
      "Unable to read env value. Check the key, arguments, project env configuration, and key/backend access. Use hack env get --help for usage.\n",
  },
  // The target-inspect contract: same code, its own message and detail.
  "project target": {
    kind: "target-envelope",
    argv: ["project", "target", "-p", "DIR", "--json"],
  },
  "project task list": {
    kind: "exception",
    argv: ["project", "task", "list", "-p", "DIR"],
    stdout: "",
    stderr: `ERROR: E_PROJECT_NOT_FOUND: ${TARGET_MESSAGE}\n`,
  },
  "project task inspect": {
    kind: "exception",
    argv: ["project", "task", "inspect", "x", "-p", "DIR"],
    stdout: "",
    stderr: `ERROR: E_PROJECT_NOT_FOUND: ${TARGET_MESSAGE}\n`,
  },
  // Native configuration commands keep their own transport and codes.
  "config validate": {
    kind: "exception",
    argv: ["config", "validate", "-p", "DIR", "--json"],
    stdout: `${JSON.stringify({
      transport_version: 1,
      ok: false,
      error: {
        code: "E_NATIVE_PROJECT_UNSUPPORTED",
        message: NATIVE_VALIDATION_MESSAGE,
      },
    })}\n`,
    stderr: "",
  },
  "config plan": {
    kind: "exception",
    argv: ["config", "plan", "-p", "DIR"],
    stdout: "",
    stderr: `E_NATIVE_PROJECT_UNSUPPORTED: ${NATIVE_VALIDATION_MESSAGE}\n`,
  },
  "config import": {
    kind: "exception",
    argv: ["config", "import", "--dry-run", "-p", "DIR"],
    stdout:
      'Native import preview refused; no inputs or resources changed.\nconfig "/" (1:1): refused unsafe_changed_or_unavailable_input\n',
    stderr: "",
  },
  "config adopt": {
    kind: "exception",
    argv: ["config", "adopt", "-p", "DIR"],
    stdout: "",
    stderr:
      "ERROR: E_CONFIG_INVALID: Legacy adoption generation state is invalid, unsafe or changed; values omitted.\n",
  },
  init: { kind: "not-a-project-command", reason: NOT_REQUIRED },
  doctor: { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "crash-capture": { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "mcp install": { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "mcp print": { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "setup cursor": { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "setup claude": { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "setup codex": { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "setup agents": { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "setup sync": { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "setup migrate": { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "setup mcp": { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "agent init": { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "agent onboard": { kind: "not-a-project-command", reason: NOT_REQUIRED },
  "gateway enable": { kind: "not-a-project-command", reason: UNSUPPORTED },
  "gateway setup": { kind: "not-a-project-command", reason: UNSUPPORTED },
  "gateway disable": { kind: "not-a-project-command", reason: UNSUPPORTED },
  "node workspace attach": {
    kind: "not-a-project-command",
    reason: UNSUPPORTED,
  },
  remote: { kind: "not-a-project-command", reason: UNSUPPORTED },
  "remote setup": { kind: "not-a-project-command", reason: UNSUPPORTED },
  "remote status": { kind: "not-a-project-command", reason: UNSUPPORTED },
  "remote monitor": { kind: "not-a-project-command", reason: UNSUPPORTED },
  "remote qr": { kind: "not-a-project-command", reason: UNSUPPORTED },
  "internal extra-hosts set": {
    kind: "not-a-project-command",
    reason: UNSUPPORTED,
  },
  "internal extra-hosts unset": {
    kind: "not-a-project-command",
    reason: UNSUPPORTED,
  },
  "internal extra-hosts list": {
    kind: "not-a-project-command",
    reason: UNSUPPORTED,
  },
};

/** Every command path whose own options include `--path`. */
function commandsWithPath(): string[] {
  const out: string[] = [];
  const walk = (
    commands: readonly AnyCommandSpec[],
    parent: readonly string[]
  ) => {
    for (const command of commands) {
      const path = [...parent, command.name];
      if (command.options.some((option) => option.long === "--path")) {
        out.push(path.join(" "));
      }
      walk(command.subcommands, path);
    }
  };
  walk(CLI_SPEC.commands, []);
  return out.sort();
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function emptyProject() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-missing-project-"))
  );
  roots.push(root);
  const dir = join(root, "empty");
  await mkdir(dir);
  return { root, dir };
}

async function cli(opts: {
  readonly root: string;
  readonly args: readonly string[];
}) {
  const child = Bun.spawn(
    [process.execPath, resolve("index.ts"), ...opts.args],
    {
      cwd: opts.root,
      env: privateCliEnv({
        root: opts.root,
        env: { HACK_NO_INTERACTIVE: "1", HACK_LOGGER: "console" },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("every command that declares --path has a pinned missing-project behaviour", () => {
  expect(Object.keys(COMMANDS).sort()).toEqual(commandsWithPath());
});

for (const [name, expectation] of Object.entries(COMMANDS)) {
  if (expectation.kind === "not-a-project-command") {
    continue;
  }
  test(
    `${name} with a path without a project: ${expectation.kind}`,
    async () => {
      const { root, dir } = await emptyProject();
      const result = await cli({
        root,
        args: expectation.argv.map((token) => (token === "DIR" ? dir : token)),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).not.toMatch(STACK_FRAME);
      switch (expectation.kind) {
        case "target-envelope":
          expect(JSON.parse(result.stdout)).toMatchObject({
            ok: false,
            error: { code: "E_PROJECT_NOT_FOUND", message: TARGET_MESSAGE },
          });
          expect(result.stderr).toBe("");
          break;
        case "envelope":
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: {
              code: "E_PROJECT_NOT_FOUND",
              message: MISSING_PROJECT_MESSAGE,
            },
          });
          expect(result.stderr).toBe("");
          break;
        case "line":
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe(
            `ERROR: E_PROJECT_NOT_FOUND: ${MISSING_PROJECT_MESSAGE}\n`
          );
          break;
        case "exception":
          expect({ stdout: result.stdout, stderr: result.stderr }).toEqual({
            stdout: expectation.stdout,
            stderr: expectation.stderr,
          });
          break;
        default:
          throw new Error("unreachable");
      }
    },
    SPAWN_TIMEOUT_MS
  );
}

test(
  "ps -p <empty dir> without --json prints one closed line and no stack",
  async () => {
    const { root, dir } = await emptyProject();
    const result = await cli({ root, args: ["ps", "-p", dir] });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `ERROR: E_PROJECT_NOT_FOUND: ${MISSING_PROJECT_MESSAGE}\n`
    );
  },
  SPAWN_TIMEOUT_MS
);
