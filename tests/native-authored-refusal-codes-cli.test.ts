import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-2621. The authored command reference keeps two stable refusal codes
 * apart (docs/reference/native-authored-commands.md, "Support matrix"):
 *
 * - `E_USAGE`: a command form no native project accepts, refused by the
 *   shared option checks before the CLI knows the project is authored, with
 *   the same code image and Compose-file projects get;
 * - `E_NATIVE_PROJECT_UNSUPPORTED`: a well-formed command authored dispatch
 *   does not support yet.
 *
 * Each row runs the source CLI with `--json` against an authored project whose
 * runtime is `/bin/false`, so no form may reach the runtime. The reference
 * used to document the `E_USAGE` rows as `E_NATIVE_PROJECT_UNSUPPORTED`.
 */

let root = "";
let project = "";
let env: Record<string, string> = {};

beforeAll(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "native-authored-refusal-codes-"))
  );
  project = join(root, "project");
  await mkdir(join(project, ".hack"), { recursive: true });
  await writeFile(
    join(project, ".hack", "hack.project.json"),
    JSON.stringify({ name: "refusal-codes" })
  );
  env = privateCliEnv({
    root,
    env: {
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: "/bin/false",
      HACK_NATIVE_HOME: join(root, "native-home"),
      HACK_CONFIG_COMPILER_BINARY: "/must-not-compile",
      HACK_NO_INTERACTIVE: "1",
      HACK_LOGGER: "console",
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
      XDG_DATA_HOME: join(root, "xdg-data"),
    },
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// The shared parser's own option errors print no code in text mode; in JSON
// mode they are `E_USAGE` (the `--json` rows below pin that).
const PARSER_USAGE =
  /^ERROR: (Option\(s\) not valid for|Unexpected arguments)/m;

/** The refusal code: the JSON error's code, or in text mode the printed one. */
async function refusalCode(args: readonly string[]): Promise<unknown> {
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../index.ts"), ...args],
    { cwd: project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).not.toBe(0);
    for (const stream of [stdout, stderr]) {
      const text = stream.trim();
      if (text.startsWith("{")) {
        const reply: unknown = JSON.parse(text);
        return (reply as { error?: { code?: unknown } }).error?.code;
      }
    }
    const plain = Bun.stripANSI(stderr);
    const printed = /^ERROR: (E_[A-Z_]+):/m.exec(plain)?.[1];
    if (printed) {
      return printed;
    }
    return PARSER_USAGE.test(plain) ? "E_USAGE" : `unrecognized: ${plain}`;
  } finally {
    clearTimeout(timer);
  }
}

// One row per refused form in the reference's two refusal columns.
const usage: readonly (readonly string[])[] = [
  // up
  ["up", "--recover"],
  ["up", "web"],
  ["up", "--workdir", "/srv"],
  ["up", "--follow"],
  ["up", "--target", "local"],
  ["up", "--progress"],
  // down
  ["down", "--detach"],
  ["down", "web"],
  ["down", "--workdir", "/srv"],
  // down --recover
  ["down", "--recover", "--detach"],
  ["down", "--recover", "web"],
  // ps
  ["ps", "--env", "staging"],
  ["ps", "web"],
  ["ps", "--recover"],
  ["ps", "--detach"],
  ["ps", "--workdir", "/srv"],
  // logs
  ["logs", "web", "worker"],
  ["logs", "web", "--tail", "many"],
  ["logs", "web", "--pretty"],
  ["logs", "web", "--until", "1m"],
  ["logs", "web", "--profile", "jobs"],
  ["logs", "web", "--env", "staging"],
  ["logs", "web", "--recover"],
  ["logs", "web", "--detach"],
  // exec and run
  ["exec", "web", "--detach", "--", "true"],
  ["exec", "web", "--recover", "--", "true"],
  ["exec", "web", "--follow", "--", "true"],
  ["run", "web", "--detach", "--", "true"],
  ["run", "web", "--recover", "--", "true"],
  // restart
  ["restart", "--detach"],
  ["restart", "--target", "nowhere"],
];

const unsupported: readonly (readonly string[])[] = [
  ["down", "--profile", "jobs"],
  ["down", "--env", "staging"],
  ["down", "--recover", "--profile", "jobs"],
  ["down", "--recover", "--env", "staging"],
  ["ps", "--profile", "jobs"],
  ["logs"],
  ["logs", "web", "--tail", "5000"],
  ["exec", "web", "--profile", "jobs", "--", "true"],
  ["exec", "web", "--env", "staging", "--", "true"],
  ["exec", "web", "--workdir", "relative", "--", "true"],
  ["run", "web", "--env", "staging", "--", "true"],
  ["restart", "web"],
  ["restart", "--target", "local"],
];

// Forms whose own `--json` is the refused option.
const jsonForms = {
  usage: [["exec", "web", "--json", "--", "true"]],
  unsupported: [
    ["down", "--json"],
    ["down", "--recover", "--json"],
    ["restart", "--json"],
  ],
} as const;

/** `--json`, except for exec and run, where `--json` is itself a refused option. */
function withJson(args: readonly string[]): string[] {
  return args[0] === "exec" || args[0] === "run"
    ? [...args]
    : [...args, "--json"];
}

test.each(usage.map((args) => [args.join(" "), args] as const))(
  "authored %s refuses with E_USAGE, as on every native project",
  async (_name, args) => {
    expect(await refusalCode(withJson(args))).toBe("E_USAGE");
  },
  45_000
);

test.each(unsupported.map((args) => [args.join(" "), args] as const))(
  "authored %s refuses with E_NATIVE_PROJECT_UNSUPPORTED",
  async (_name, args) => {
    expect(await refusalCode(withJson(args))).toBe(
      "E_NATIVE_PROJECT_UNSUPPORTED"
    );
  },
  45_000
);

test.each(jsonForms.usage.map((args) => [args.join(" "), args] as const))(
  "authored %s refuses with E_USAGE: --json requires --detach",
  async (_name, args) => {
    expect(await refusalCode(args)).toBe("E_USAGE");
  },
  45_000
);

test.each(jsonForms.unsupported.map((args) => [args.join(" "), args] as const))(
  "authored %s refuses with E_NATIVE_PROJECT_UNSUPPORTED",
  async (_name, args) => {
    expect(await refusalCode(args)).toBe("E_NATIVE_PROJECT_UNSUPPORTED");
  },
  45_000
);
