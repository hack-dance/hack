import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AnyCommandSpec, CliUsageError } from "../src/cli/command.ts";
import {
  INVALID_PROJECT_OPTION_MESSAGE,
  parseEnvGetArguments,
  parseExecutionScopeOptions,
  parseProjectSelectorOption,
} from "../src/cli/env-arguments.ts";
import { INVALID_ENV_SELECTION_MESSAGE } from "../src/cli/env-selection.ts";
import { optEnv, optProject } from "../src/cli/options.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { parseEnvConfigSelection } from "../src/lib/project.ts";
import {
  ENV_KEY_ASSIGNMENT_MESSAGE,
  ENV_KEY_INVALID_MESSAGE,
  ENV_SCOPE_INVALID_MESSAGE,
} from "../src/lib/project-env-config.ts";

/**
 * Key- and scope-argument refusals in `hack env` and `hack host` must never
 * echo the rejected argument.
 *
 * A key or `--service`/`--scope` argument is often a mistyped `KEY=value` or
 * a value pasted into the wrong position. Each case runs the real CLI in a fresh subprocess with a
 * distinctive canary inside the argument and proves the canary is absent from
 * stdout, stderr, and the argv/env of every child process the CLI spawns.
 *
 * Isolation: temp HOME and global config, a temp project, the project-key
 * YAML store or an injected `encrypted_file` backend with an env-provided key.
 * No keychain, 1Password, Docker, or agent client config is reached.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const RECORDER = resolve(import.meta.dir, "fixtures/spawn-argv-recorder.ts");
/** Lowercase canary: valid as a scope fragment, invalid as an env key. */
const CANARY = "echo-canary-c1-9d4f7a";
/** Uppercase-bearing canary: invalid as a scope name. */
const SCOPE_CANARY = "Echo-Scope-Canary-C1-3b6e";
const SECRETS_FILE_KEY = "env-key-redaction-test-key";

const INVALID_KEY = "Invalid env key: keys must match ^[A-Z_][A-Z0-9_]*$";
const ASSIGNMENT_KEY = 'the key argument cannot contain "="';
const INVALID_SCOPE = 'Invalid env scope: scopes must be "global"';
const GET_REFUSAL = "Unable to read env value.";

type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnLog: string;
};

let root: string | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-env-key-redaction-"));
  await mkdir(join(root, "home"), { recursive: true });
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

function requireRoot(): string {
  if (!root) {
    throw new Error("Missing temp root");
  }
  return root;
}

async function runHack(input: {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly stdin?: string;
}): Promise<RunResult> {
  const base = requireRoot();
  const spawnLog = join(base, `spawn-${crypto.randomUUID()}.jsonl`);
  const proc = Bun.spawn(
    [process.execPath, "--preload", RECORDER, ENTRYPOINT, ...input.args],
    {
      cwd: input.cwd ?? REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: join(base, "home"),
        TMPDIR: join(base, "home"),
        HACK_GLOBAL_CONFIG_PATH: join(base, "home", "hack-config.json"),
        HACK_LOGGER: "console",
        HACK_SECRETS_FILE_KEY: SECRETS_FILE_KEY,
        HACK_TEST_SPAWN_ARGV_LOG: spawnLog,
      },
      stdin: input.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  if (input.stdin !== undefined && proc.stdin) {
    proc.stdin.write(input.stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const spawnLogText = await readFile(spawnLog, "utf8").catch(() => "");
  return { exitCode, stdout, stderr, spawnLog: spawnLogText };
}

function expectRefusedWithoutEcho(input: {
  readonly result: RunResult;
  readonly message: string;
  readonly canary: string;
  readonly rawArgument: string;
}): void {
  const { result } = input;
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(input.message);
  for (const stream of [result.stdout, result.stderr, result.spawnLog]) {
    expect(stream).not.toContain(input.canary);
    expect(stream).not.toContain(input.rawArgument);
    // A slugged echo (case-folded, punctuation stripped) is still an echo.
    expect(stream.toLowerCase()).not.toContain(input.canary.toLowerCase());
  }
}

async function createModernProject(): Promise<string> {
  const projectRoot = join(requireRoot(), "modern");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "key-redaction-modern", dev_host: "key-redaction-modern.hack" }, null, 2)}\n`
  );
  await writeFile(
    join(projectDir, "hack.env.default.yaml"),
    'version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    GLOBAL_FLAG: "1"\n'
  );
  return projectRoot;
}

async function createLegacyProject(): Promise<{
  readonly projectRoot: string;
  readonly storePath: string;
}> {
  const base = requireRoot();
  const projectRoot = join(base, "legacy");
  const projectDir = join(projectRoot, ".hack");
  const storePath = join(base, "secrets.enc.json");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "docker-compose.yml"), "services: {}\n");
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify(
      {
        name: "key-redaction-legacy",
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            encryptedFile: { path: storePath },
          },
        },
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(projectDir, "hack.env.json"),
    `${JSON.stringify(
      {
        version: 1,
        vars: [{ key: "API_KEY", required: false, source: "keychain" }],
      },
      null,
      2
    )}\n`
  );
  return { projectRoot, storePath };
}

async function readTree(paths: readonly string[]): Promise<string> {
  const contents = await Promise.all(
    paths.map((path) => readFile(path, "utf8").catch(() => "<missing>"))
  );
  return contents.join("\n--\n");
}

function modernFiles(projectRoot: string): readonly string[] {
  return [
    "hack.env.default.yaml",
    "hack.env.local.yaml",
    ".env",
    "hack.config.json",
  ].map((file) => join(projectRoot, ".hack", file));
}

test(
  "modern env add/set/unset/explain refuse KEY=value without echoing any of it",
  async () => {
    const projectRoot = await createModernProject();
    const before = await readTree(modernFiles(projectRoot));
    const assignment = `API_TOKEN=${CANARY}`;
    // A dotted value would previously split into a scope that carried the
    // value prefix into "Invalid env scope: API_TOKEN=...".
    const dottedAssignment = `API_TOKEN=${CANARY}.tail`;
    const cases: readonly (readonly string[])[] = [
      ["env", "add", assignment],
      ["env", "add", assignment, "--secret"],
      ["env", "add", dottedAssignment],
      ["env", "add", assignment, "--service", "api"],
      ["env", "set", assignment],
      ["env", "unset", assignment],
      ["env", "unset", dottedAssignment],
      ["env", "explain", assignment],
    ];
    for (const args of cases) {
      const raw = args[2] ?? "";
      const result = await runHack({ args: [...args, "--path", projectRoot] });
      expectRefusedWithoutEcho({
        result,
        message: ASSIGNMENT_KEY,
        canary: CANARY,
        rawArgument: raw,
      });
    }
    expect(await readTree(modernFiles(projectRoot))).toBe(before);
  },
  { timeout: 90_000 }
);

test(
  "modern env commands refuse a value pasted as the key without echoing it",
  async () => {
    const projectRoot = await createModernProject();
    const before = await readTree(modernFiles(projectRoot));
    const cases: readonly {
      readonly args: readonly string[];
      readonly message: string;
      readonly canary: string;
    }[] = [
      { args: ["env", "add", CANARY], message: INVALID_KEY, canary: CANARY },
      {
        args: ["env", "add", CANARY, "positional-value"],
        message: INVALID_KEY,
        canary: CANARY,
      },
      {
        args: ["env", "add", `api.${CANARY}`],
        message: INVALID_KEY,
        canary: CANARY,
      },
      {
        args: ["env", "add", `${SCOPE_CANARY}.API_TOKEN`, "value"],
        message: INVALID_SCOPE,
        canary: SCOPE_CANARY,
      },
      {
        args: ["env", "add", "API_TOKEN", "value", "--service", SCOPE_CANARY],
        message: INVALID_SCOPE,
        canary: SCOPE_CANARY,
      },
      { args: ["env", "set", CANARY], message: INVALID_KEY, canary: CANARY },
      { args: ["env", "unset", CANARY], message: INVALID_KEY, canary: CANARY },
      // `env get` replaces every failure with one generic message.
      { args: ["env", "get", CANARY], message: GET_REFUSAL, canary: CANARY },
      {
        args: ["env", "get", "API_TOKEN", "--service", SCOPE_CANARY],
        message: GET_REFUSAL,
        canary: SCOPE_CANARY,
      },
      {
        args: ["env", "explain", CANARY],
        message: INVALID_KEY,
        canary: CANARY,
      },
    ];
    for (const entry of cases) {
      const result = await runHack({
        args: [...entry.args, "--path", projectRoot],
      });
      expectRefusedWithoutEcho({
        result,
        message: entry.message,
        canary: entry.canary,
        rawArgument: entry.args[2] ?? "",
      });
    }
    expect(await readTree(modernFiles(projectRoot))).toBe(before);
  },
  { timeout: 120_000 }
);

test(
  "a refused key argument is rejected before stdin is read or files change",
  async () => {
    const projectRoot = await createModernProject();
    const before = await readTree(modernFiles(projectRoot));
    // Empty stdin would be refused as "empty value" if it were read first, so
    // seeing the key refusal proves the key is validated before stdin.
    const result = await runHack({
      args: ["env", "add", CANARY, "--secret", "--value-stdin"],
      stdin: "",
      cwd: projectRoot,
    });
    expectRefusedWithoutEcho({
      result,
      message: INVALID_KEY,
      canary: CANARY,
      rawArgument: CANARY,
    });
    expect(result.stderr).not.toContain(
      "--value-stdin received an empty value"
    );
    expect(await readTree(modernFiles(projectRoot))).toBe(before);
  },
  { timeout: 30_000 }
);

test(
  "legacy env set and unset refuse an invalid key without echoing it or touching the store",
  async () => {
    const { projectRoot, storePath } = await createLegacyProject();
    const files = [
      storePath,
      join(projectRoot, ".hack", ".env"),
      join(projectRoot, ".hack", "hack.env.json"),
    ];
    const before = await readTree(files);
    const cases: readonly (readonly string[])[] = [
      ["env", "set", CANARY],
      ["env", "set", CANARY, "positional-value"],
      ["env", "set", `${CANARY}=positional-value`],
      ["env", "set", CANARY, "--secret"],
      ["env", "unset", CANARY],
    ];
    for (const args of cases) {
      const result = await runHack({ args, cwd: projectRoot });
      expectRefusedWithoutEcho({
        result,
        message: INVALID_KEY,
        canary: CANARY,
        rawArgument: args[2] ?? "",
      });
    }
    expect(await readTree(files)).toBe(before);
  },
  { timeout: 90_000 }
);

test(
  "a malformed key in an env config file is reported without echoing the key",
  async () => {
    const projectRoot = await createModernProject();
    await writeFile(
      join(projectRoot, ".hack", "hack.env.default.yaml"),
      `version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    "API_TOKEN=${CANARY}": "1"\n`
    );
    const result = await runHack({
      args: ["env", "list", "--path", projectRoot],
    });
    expectRefusedWithoutEcho({
      result,
      message: 'Invalid env key in scope "global"',
      canary: CANARY,
      rawArgument: `API_TOKEN=${CANARY}`,
    });
  },
  { timeout: 30_000 }
);

const UNKNOWN_SCOPE = "Unknown env scope: the requested scope is not global";

/** Program names (argv[0]) of every recorded child process. */
function spawnedPrograms(spawnLog: string): readonly string[] {
  return spawnLog
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const record: unknown = JSON.parse(line);
      const argv =
        typeof record === "object" && record !== null && "argv" in record
          ? record.argv
          : null;
      return Array.isArray(argv) ? String(argv[0]) : "<unknown>";
    });
}

/**
 * Every command that accepts a scope through --service or --scope. Options
 * precede `--`, after which everything is the host command's own argv.
 */
function scopeOptionCases(input: {
  readonly scope: string;
  readonly projectRoot: string;
}): readonly (readonly string[])[] {
  const path = ["--path", input.projectRoot];
  return [
    ["env", "materialize", "--service", input.scope, ...path],
    ["env", "exec", "--service", input.scope, ...path, "--", "true"],
    ["env", "shell", "--service", input.scope, ...path],
    ["env", "list", "--service", input.scope, ...path],
    ["env", "apply", "--service", input.scope, ...path],
    ["host", "exec", "--scope", input.scope, ...path, "--", "true"],
    ["host", "shell", "--scope", input.scope, ...path],
  ];
}

test(
  "scope options refuse a malformed scope without echoing it or touching files",
  async () => {
    const projectRoot = await createModernProject();
    const before = await readTree(modernFiles(projectRoot));
    for (const scope of [`API_TOKEN=${CANARY}`, SCOPE_CANARY]) {
      const canary = scope === SCOPE_CANARY ? SCOPE_CANARY : CANARY;
      for (const args of scopeOptionCases({ scope, projectRoot })) {
        const result = await runHack({ args });
        expectRefusedWithoutEcho({
          result,
          message: INVALID_SCOPE,
          canary,
          rawArgument: scope,
        });
        // Refused before any shell, command, or restart child starts.
        expect(
          spawnedPrograms(result.spawnLog).filter((name) => name !== "git")
        ).toEqual([]);
      }
    }
    expect(await readTree(modernFiles(projectRoot))).toBe(before);
  },
  { timeout: 180_000 }
);

test(
  "a well-formed but unknown scope is refused without echoing it",
  async () => {
    const projectRoot = await createModernProject();
    const before = await readTree(modernFiles(projectRoot));
    // CANARY matches the scope pattern, so it reaches scope resolution. The
    // refusal may list configured scopes from project files, never the request.
    const cases = scopeOptionCases({ scope: CANARY, projectRoot }).filter(
      (args) => args[1] !== "apply"
    );
    for (const args of cases) {
      const result = await runHack({ args });
      expectRefusedWithoutEcho({
        result,
        message: UNKNOWN_SCOPE,
        canary: CANARY,
        rawArgument: CANARY,
      });
      expect(result.stderr).toContain("Configured scopes: global, api.");
      expect(
        spawnedPrograms(result.spawnLog).filter((name) => name !== "git")
      ).toEqual([]);
    }
    const get = await runHack({
      args: ["env", "get", "GLOBAL_FLAG", "--service", CANARY],
      cwd: projectRoot,
    });
    expectRefusedWithoutEcho({
      result: get,
      message: GET_REFUSAL,
      canary: CANARY,
      rawArgument: CANARY,
    });
    expect(await readTree(modernFiles(projectRoot))).toBe(before);
  },
  { timeout: 120_000 }
);

test("env get argument refusals are value-free before the generic wrapper", () => {
  // The CLI replaces every `env get` failure with one generic message, which
  // would hide a regression in the handler's own refusals. Assert the parse
  // layer the handler uses so a re-echo of the key or scope is still caught.
  const cases: readonly {
    readonly key: string;
    readonly serviceName?: string;
    readonly message: string;
    readonly canary: string;
  }[] = [
    { key: CANARY, message: ENV_KEY_INVALID_MESSAGE, canary: CANARY },
    {
      key: `API_TOKEN=${CANARY}`,
      message: ENV_KEY_ASSIGNMENT_MESSAGE,
      canary: CANARY,
    },
    {
      key: "API_TOKEN",
      serviceName: SCOPE_CANARY,
      message: ENV_SCOPE_INVALID_MESSAGE,
      canary: SCOPE_CANARY,
    },
    {
      key: "API_TOKEN",
      serviceName: `api=${CANARY}`,
      message: ENV_SCOPE_INVALID_MESSAGE,
      canary: CANARY,
    },
  ];
  for (const entry of cases) {
    let thrown: unknown = null;
    try {
      parseEnvGetArguments({
        key: entry.key,
        serviceName: entry.serviceName,
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    const message = (thrown as Error).message;
    expect(message).toBe(entry.message);
    expect(message).not.toContain(entry.canary);
  }
  expect(
    parseEnvGetArguments({ key: "API_TOKEN", serviceName: " api " })
  ).toEqual({ key: "API_TOKEN", scope: "api" });
  expect(
    parseEnvGetArguments({ key: "API_TOKEN", serviceName: undefined })
  ).toEqual({ key: "API_TOKEN", scope: "global" });
});

test("execution scope parsing refuses conflicts and malformed scopes value-free", () => {
  expect(
    parseExecutionScopeOptions({ scopeName: undefined, serviceName: " " })
  ).toBeNull();
  expect(
    parseExecutionScopeOptions({ scopeName: "api", serviceName: undefined })
  ).toBe("api");
  for (const input of [
    { scopeName: `API_TOKEN=${CANARY}`, serviceName: undefined },
    { scopeName: undefined, serviceName: `API_TOKEN=${CANARY}` },
    { scopeName: "api", serviceName: CANARY },
  ]) {
    let message = "";
    try {
      parseExecutionScopeOptions(input);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(CANARY);
  }
});

/** Every file or directory name under `dir`, recursively. */
async function listNames(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map((entry) => String(entry));
}

/** No file anywhere under the temp root may carry the canary in its name. */
async function expectNoCanaryFileNames(canary: string): Promise<void> {
  const names = await listNames(requireRoot());
  expect(
    names.filter((name) => name.toLowerCase().includes(canary.toLowerCase()))
  ).toEqual([]);
}

function expectNoNonGitChild(result: RunResult): void {
  expect(
    spawnedPrograms(result.spawnLog).filter((name) => name !== "git")
  ).toEqual([]);
}

/** Command paths (e.g. ["env", "get"]) whose spec includes `option`. */
function commandPathsWithOption(option: unknown): readonly string[][] {
  const out: string[][] = [];
  const walk = (
    commands: readonly AnyCommandSpec[],
    prefix: readonly string[]
  ): void => {
    for (const command of commands) {
      const path = [...prefix, command.name];
      if (command.options.some((entry) => entry === option)) {
        out.push(path);
      }
      walk(command.subcommands, path);
    }
  };
  walk(CLI_SPEC.commands, []);
  return out;
}

/** Arguments that let each env/host command reach its handler. */
function handlerArguments(path: readonly string[]): readonly string[] {
  switch (path.join(" ")) {
    case "env get":
    case "env explain":
    case "env unset":
      return ["API_TOKEN"];
    case "env add":
    case "env set":
      return ["API_TOKEN", "value"];
    case "env apply":
      return ["--service", "api"];
    case "env exec":
    case "host exec":
      return ["--", "true"];
    default:
      return [];
  }
}

/** `env get` replaces every failure with one fixed message. */
function expectedRefusal(path: readonly string[], message: string): string {
  return path.join(" ") === "env get" ? GET_REFUSAL : message;
}

/** Value-bearing --env spellings: assignments and non-canonical names. */
const ENV_CANARY_VALUES: readonly {
  readonly value: string;
  readonly canary: string;
}[] = [
  // Previously slugged to "xecho-canary-...", printed, and used as a file name.
  { value: `X=${CANARY}`, canary: CANARY },
  // Previously case-folded to "echo-scope-canary-...".
  { value: SCOPE_CANARY, canary: SCOPE_CANARY },
  { value: `${CANARY}.yaml`, canary: CANARY },
];

test(
  "every command accepting --env refuses a value-bearing --env before any project work",
  async () => {
    const paths = commandPathsWithOption(optEnv);
    // Guard against the enumeration silently finding nothing.
    expect(paths.map((path) => path.join(" "))).toEqual(
      expect.arrayContaining([
        "up",
        "down",
        "restart",
        "run",
        "exec",
        "env add",
        "env apply",
        "env get",
        "host exec",
        "config plan",
        "session start",
      ])
    );
    // No .hack/ here: any refusal other than the --env one would mean the
    // command discovered (or failed to discover) a project before --env.
    const empty = join(requireRoot(), "empty");
    await mkdir(empty, { recursive: true });
    for (const path of paths) {
      for (const entry of ENV_CANARY_VALUES) {
        const result = await runHack({
          args: [...path, "--env", entry.value],
          cwd: empty,
        });
        expectRefusedWithoutEcho({
          result,
          message: expectedRefusal(path, INVALID_ENV_SELECTION_MESSAGE),
          canary: entry.canary,
          rawArgument: entry.value,
        });
        expectNoNonGitChild(result);
      }
    }
    await expectNoCanaryFileNames(CANARY);
    await expectNoCanaryFileNames(SCOPE_CANARY);
  },
  { timeout: 300_000 }
);

test(
  "env and host commands refuse a value-bearing --env in a real project without creating overlay files",
  async () => {
    const projectRoot = await createModernProject();
    const before = await readTree(modernFiles(projectRoot));
    const beforeNames = await listNames(join(projectRoot, ".hack"));
    const paths = commandPathsWithOption(optEnv).filter(
      (path) => path[0] === "env" || path[0] === "host"
    );
    for (const path of paths) {
      for (const entry of ENV_CANARY_VALUES) {
        const result = await runHack({
          args: [
            ...path,
            "--env",
            entry.value,
            "--path",
            projectRoot,
            ...handlerArguments(path),
          ],
        });
        expectRefusedWithoutEcho({
          result,
          message: expectedRefusal(path, INVALID_ENV_SELECTION_MESSAGE),
          canary: entry.canary,
          rawArgument: entry.value,
        });
        expectNoNonGitChild(result);
      }
    }
    // `env add --value-stdin` refuses before reading stdin: an empty stdin
    // would otherwise be refused as an empty value.
    const stdinResult = await runHack({
      args: [
        "env",
        "add",
        "API_TOKEN",
        "--secret",
        "--value-stdin",
        "--env",
        `X=${CANARY}`,
      ],
      cwd: projectRoot,
      stdin: "",
    });
    expectRefusedWithoutEcho({
      result: stdinResult,
      message: INVALID_ENV_SELECTION_MESSAGE,
      canary: CANARY,
      rawArgument: `X=${CANARY}`,
    });
    expect(stdinResult.stderr).not.toContain("empty value");
    expect(await readTree(modernFiles(projectRoot))).toBe(before);
    expect(await listNames(join(projectRoot, ".hack"))).toEqual(beforeNames);
    await expectNoCanaryFileNames(CANARY);
    await expectNoCanaryFileNames(SCOPE_CANARY);

    // The documented base aliases keep working.
    for (const alias of ["base", "DEFAULT", "none", ""]) {
      const result = await runHack({
        args: ["env", "list", "--env", alias, "--json", "--path", projectRoot],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("GLOBAL_FLAG");
    }
  },
  { timeout: 300_000 }
);

test(
  "env and host commands refuse a value-bearing --project without echoing it",
  async () => {
    const paths = commandPathsWithOption(optProject).filter(
      // `host ps` only filters its listing by name and never echoes it.
      (path) =>
        (path[0] === "env" || path[0] === "host") &&
        path.join(" ") !== "host ps"
    );
    expect(paths.length).toBeGreaterThanOrEqual(12);
    const cases: readonly {
      readonly value: string;
      readonly canary: string;
      readonly message: string;
    }[] = [
      // Previously printed as Unknown project "xecho-canary-...".
      {
        value: `x=${CANARY}`,
        canary: CANARY,
        message: INVALID_PROJECT_OPTION_MESSAGE,
      },
      {
        value: `${CANARY}.x`,
        canary: CANARY,
        message: INVALID_PROJECT_OPTION_MESSAGE,
      },
      // A legacy alias spelling still selects by its slug, but an unknown
      // non-canonical selector is not echoed back in slugged form.
      {
        value: SCOPE_CANARY,
        canary: SCOPE_CANARY,
        message: "Unknown project. Run 'hack init'",
      },
    ];
    const cwd = join(requireRoot(), "empty");
    await mkdir(cwd, { recursive: true });
    for (const path of paths) {
      for (const entry of cases) {
        const result = await runHack({
          args: [...path, "--project", entry.value, ...handlerArguments(path)],
          cwd,
        });
        expectRefusedWithoutEcho({
          result,
          message: expectedRefusal(path, entry.message),
          canary: entry.canary,
          rawArgument: entry.value,
        });
        expectNoNonGitChild(result);
      }
    }
    await expectNoCanaryFileNames(CANARY);
    await expectNoCanaryFileNames(SCOPE_CANARY);
  },
  { timeout: 300_000 }
);

test(
  "env and host commands refuse a value-bearing --target without echoing it",
  async () => {
    const projectRoot = await createModernProject();
    const before = await readTree(modernFiles(projectRoot));
    const paths = [
      ["env", "explain"],
      ["env", "exec"],
      ["env", "shell"],
      ["host", "exec"],
      ["host", "shell"],
    ];
    for (const path of paths) {
      for (const entry of [
        { value: `x=${CANARY}`, canary: CANARY },
        { value: SCOPE_CANARY, canary: SCOPE_CANARY },
      ]) {
        const result = await runHack({
          args: [
            ...path,
            "--target",
            entry.value,
            "--path",
            projectRoot,
            ...handlerArguments(path),
          ],
        });
        expectRefusedWithoutEcho({
          result,
          message: "Invalid --target value. Expected one of: host, compose.",
          canary: entry.canary,
          rawArgument: entry.value,
        });
        expectNoNonGitChild(result);
      }
    }
    expect(await readTree(modernFiles(projectRoot))).toBe(before);
    await expectNoCanaryFileNames(CANARY);
    await expectNoCanaryFileNames(SCOPE_CANARY);
  },
  { timeout: 120_000 }
);

test("overlay and project selectors are never slugged from user input", () => {
  // Shared by the CLI and the daemon env routes (which map undefined to a
  // fixed `invalid_env` error).
  expect(parseEnvConfigSelection(undefined)).toBeUndefined();
  expect(parseEnvConfigSelection(" ")).toBeNull();
  expect(parseEnvConfigSelection("NONE")).toBeNull();
  expect(parseEnvConfigSelection(" qa ")).toBe("qa");
  expect(parseEnvConfigSelection("qa-2")).toBe("qa-2");
  for (const value of [
    `X=${CANARY}`,
    SCOPE_CANARY,
    "QA",
    "q_a",
    "q a",
    "q--a",
    "-qa",
    `${CANARY}.yaml`,
    "../qa",
  ]) {
    expect(parseEnvConfigSelection(value)).toBeUndefined();
  }

  expect(parseProjectSelectorOption({ projectOpt: " my-app " })).toEqual({
    name: "my-app",
    canonical: true,
  });
  // Legacy alias spellings still select their canonical slug.
  expect(parseProjectSelectorOption({ projectOpt: "My_App" })).toEqual({
    name: "my-app",
    canonical: false,
  });
  for (const value of [`x=${CANARY}`, `${CANARY}.x`, "a:b", "", "---"]) {
    let message = "";
    try {
      parseProjectSelectorOption({ projectOpt: value });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CliUsageError);
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(INVALID_PROJECT_OPTION_MESSAGE);
  }
});
