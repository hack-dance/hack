import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AnyCommandSpec } from "../src/cli/command.ts";
import { optProject } from "../src/cli/options.ts";
import {
  INVALID_PROJECT_OPTION_MESSAGE,
  unknownProjectMessage,
} from "../src/cli/project-selector.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { INVALID_EXECUTION_TARGET_MESSAGE } from "../src/lib/project-execution.ts";
import { isolatedDockerClientEnv } from "./helpers/docker-client.ts";

/**
 * `--project` and lifecycle `--target` refusals must never echo a value.
 *
 * A `--project` or `--target` argument is sometimes a mistyped `KEY=value` or
 * a value pasted into the wrong position. Each case runs the real CLI in a
 * fresh subprocess with a distinctive canary inside the argument and proves
 * the canary (also in case-folded, slugged form) is absent from stdout,
 * stderr, the argv and env of every child process, and every file name under
 * the temp root, and that no child other than `git` started.
 *
 * Isolation: temp HOME, HACK_HOME and global config, an empty cwd or a temp
 * project, an isolated Docker client config, and a PATH holding only `git`,
 * so even a regression that reached runtime work could not start `docker` or
 * use the contributor's Docker context. No keychain or agent client config is
 * reached: every case is refused before runtime work, and the spawn recorder
 * proves it.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const RECORDER = resolve(import.meta.dir, "fixtures/spawn-argv-recorder.ts");
/** Lowercase canary: canonical in form, so it reaches project resolution. */
const CANARY = "proj-canary-d2-5e8c1b";
/** Mixed-case canary: a well-formed legacy alias spelling, not canonical. */
const ALIAS_CANARY = "Proj_Alias_Canary_D2_7a4f";
/** `env get` replaces every failure with one fixed message. */
const GET_REFUSAL = "Unable to read env value.";
const PARALLELISM = 6;

type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnLog: string;
};

let root: string | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-project-target-redaction-"));
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "empty"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  const gitPath = Bun.which("git");
  if (gitPath) {
    await symlink(gitPath, join(root, "bin", "git"));
  }
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
}): Promise<RunResult> {
  const base = requireRoot();
  const home = join(base, "home");
  const spawnLog = join(base, `spawn-${crypto.randomUUID()}.jsonl`);
  const proc = Bun.spawn(
    [process.execPath, "--preload", RECORDER, ENTRYPOINT, ...input.args],
    {
      cwd: input.cwd ?? join(base, "empty"),
      env: {
        PATH: join(base, "bin"),
        ...isolatedDockerClientEnv(home),
        HOME: home,
        HACK_HOME: join(home, ".hack"),
        TMPDIR: home,
        // The project registry lives next to the global config.
        HACK_GLOBAL_CONFIG_PATH: join(home, ".hack", "hack.config.json"),
        HACK_LOGGER: "console",
        HACK_EXPERIMENTAL_ACK: "1",
        HACK_TEST_SPAWN_ARGV_LOG: spawnLog,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const spawnLogText = await readFile(spawnLog, "utf8").catch(() => "");
  await rm(spawnLog, { force: true });
  return { exitCode, stdout, stderr, spawnLog: spawnLogText };
}

/** Run `count` cases with bounded parallelism; each case is independent. */
async function runAll<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>
): Promise<void> {
  for (let index = 0; index < items.length; index += PARALLELISM) {
    await Promise.all(items.slice(index, index + PARALLELISM).map(run));
  }
}

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

/** Lowercased, punctuation-free form: catches a slugged echo of the canary. */
function folded(text: string): string {
  return text.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function expectRefusedWithoutEcho(input: {
  readonly label: string;
  readonly result: RunResult;
  readonly message: string;
  readonly canary: string;
}): void {
  const { result, label } = input;
  expect({ label, exitCode: result.exitCode }).toEqual({ label, exitCode: 1 });
  expect({ label, stderr: result.stderr }).toEqual({
    label,
    stderr: expect.stringContaining(input.message),
  });
  for (const stream of [result.stdout, result.stderr, result.spawnLog]) {
    expect({
      label,
      echoed: folded(stream).includes(folded(input.canary)),
    }).toEqual({ label, echoed: false });
  }
  expect({
    label,
    children: spawnedPrograms(result.spawnLog).filter((name) => name !== "git"),
  }).toEqual({ label, children: [] });
}

/** No file anywhere under the temp root may carry the canary in its name. */
async function expectNoCanaryFileNames(canary: string): Promise<void> {
  const names = await readdir(requireRoot(), { recursive: true });
  expect(
    names
      .map((name) => String(name))
      .filter((name) => folded(name).includes(folded(canary)))
  ).toEqual([]);
}

/** Command paths (e.g. ["branch", "add"]) whose spec includes `option`. */
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

/** Positionals that let each command reach its handler. */
function handlerArguments(path: readonly string[]): readonly string[] {
  switch (path.join(" ")) {
    case "run":
    case "exec":
      return ["api"];
    case "branch add":
    case "branch remove":
    case "branch open":
      return ["feature-x"];
    case "config get":
      return ["name"];
    case "config set":
      return ["name", "changed"];
    case "env get":
    case "env explain":
      return ["API_TOKEN"];
    default:
      return [];
  }
}

/**
 * Commands that resolve `--project` to one registered project. Filter
 * commands (status, usage, projects, projects prune, host ps) only narrow a
 * listing and would read the container runtime for a well-formed name; env
 * and host commands are covered by env-key-argument-redaction-cli.test.ts;
 * `tui` refuses a non-TTY before resolving; remote and gateway are
 * unsupported and keep their own resolver. All of them are still covered by
 * the value-bearing refusal below.
 */
const RESOLVER_PATHS: readonly string[] = [
  "project owner show",
  "up",
  "down",
  "restart",
  "ps",
  "run",
  "exec",
  "logs",
  "open",
  "branch add",
  "branch list",
  "branch remove",
  "branch open",
  "config get",
  "config set",
];

test(
  "every command accepting --project refuses a value-bearing --project before any project work",
  async () => {
    const paths = commandPathsWithOption(optProject);
    // Guard against the enumeration silently finding nothing.
    expect(paths.map((path) => path.join(" "))).toEqual(
      expect.arrayContaining([
        ...RESOLVER_PATHS,
        "tui",
        "status",
        "usage",
        "projects",
        "projects prune",
        "env get",
        "host ps",
        "remote status",
        "gateway enable",
      ])
    );
    const values: readonly string[] = [
      // Previously slugged to "xproj-canary-..." and printed as Unknown project.
      `x=${CANARY}`,
      `${CANARY}.x`,
      `${ALIAS_CANARY}:x`,
    ];
    const cases = paths.flatMap((path) =>
      values.map((value) => ({ path, value }))
    );
    await runAll(cases, async ({ path, value }) => {
      const result = await runHack({
        args: [...path, "--project", value, ...handlerArguments(path)],
      });
      expectRefusedWithoutEcho({
        label: `${path.join(" ")} --project ${value.slice(0, 2)}…`,
        result,
        message:
          path.join(" ") === "env get"
            ? GET_REFUSAL
            : INVALID_PROJECT_OPTION_MESSAGE,
        canary: value.includes(CANARY) ? CANARY : ALIAS_CANARY,
      });
    });
    await expectNoCanaryFileNames(CANARY);
    await expectNoCanaryFileNames(ALIAS_CANARY);
  },
  { timeout: 300_000 }
);

test(
  "an unregistered --project is named only when typed in canonical form",
  async () => {
    const paths = RESOLVER_PATHS.map((path) => path.split(" "));
    // Either refusal is value-free; native-capable commands check the
    // registry for an adopted Compose root before the legacy resolver.
    const refusal =
      /Unknown project\. Run 'hack init'|The selected project is not registered\./;
    await runAll(paths, async (path) => {
      const result = await runHack({
        args: [...path, "--project", ALIAS_CANARY, ...handlerArguments(path)],
      });
      expectRefusedWithoutEcho({
        label: path.join(" "),
        result,
        message: "",
        canary: ALIAS_CANARY,
      });
      expect({ label: path.join(" "), stderr: result.stderr }).toEqual({
        label: path.join(" "),
        stderr: expect.stringMatching(refusal),
      });
    });
    await expectNoCanaryFileNames(ALIAS_CANARY);

    // A canonically typed, well-formed identifier may still be named.
    const canonical = await runHack({
      args: ["branch", "list", "--project", CANARY],
    });
    expect(canonical.exitCode).toBe(1);
    expect(canonical.stderr).toContain(
      unknownProjectMessage({ name: CANARY, canonical: true })
    );
  },
  { timeout: 300_000 }
);

test(
  "project listing filters name an unmatched --project only when typed in canonical form",
  async () => {
    // Docker is not on PATH, so these list the (empty) registry only and
    // start no child process. `usage` and `host ps` read the process table
    // with `ps` and are covered by the value-bearing refusal above.
    const paths: readonly (readonly string[])[] = [
      ["status"],
      ["projects"],
      ["projects", "prune", "--dry-run"],
    ];
    await runAll(paths, async (path) => {
      const label = path.join(" ");
      const result = await runHack({
        args: [...path, "--project", ALIAS_CANARY],
      });
      expect({ label, exitCode: result.exitCode }).toEqual({
        label,
        exitCode: 0,
      });
      for (const stream of [result.stdout, result.stderr, result.spawnLog]) {
        expect({
          label,
          echoed: folded(stream).includes(folded(ALIAS_CANARY)),
        }).toEqual({ label, echoed: false });
      }
      expect({ label, children: spawnedPrograms(result.spawnLog) }).toEqual({
        label,
        children: [],
      });
    });
    await expectNoCanaryFileNames(ALIAS_CANARY);

    const aliased = await runHack({
      args: ["projects", "--project", ALIAS_CANARY],
    });
    expect(aliased.stdout).toContain(
      "No projects matched the --project filter."
    );
    const canonical = await runHack({
      args: ["projects", "--project", CANARY],
    });
    expect(canonical.stdout).toContain(`No projects matched: ${CANARY}`);
  },
  { timeout: 120_000 }
);

test(
  "legacy alias spellings of a registered project keep selecting it",
  async () => {
    const base = requireRoot();
    const projectRoot = join(base, "my-app-repo");
    const projectDir = join(projectRoot, ".hack");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "docker-compose.yml"),
      "services:\n  api:\n    image: alpine:3.20\n"
    );
    await writeFile(
      join(projectDir, "hack.config.json"),
      `${JSON.stringify({ name: "my-app" }, null, 2)}\n`
    );
    const registry = join(base, "home", ".hack", "projects.json");
    await mkdir(join(base, "home", ".hack"), { recursive: true });
    await writeFile(
      registry,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "my-app-id",
            name: "my-app",
            repoRoot: projectRoot,
            projectDir,
            projectDirName: ".hack",
            createdAt: "2026-10-12T00:00:00Z",
          },
        ],
      })
    );
    for (const alias of ["my-app", "My_App", "my_app", "MY-APP", "my app"]) {
      const result = await runHack({
        args: ["config", "get", "--project", alias, "name"],
      });
      expect({
        alias,
        exitCode: result.exitCode,
        stderr: result.stderr,
      }).toEqual({ alias, exitCode: 0, stderr: expect.any(String) });
      expect(result.stdout).toContain("my-app");
    }
  },
  { timeout: 120_000 }
);

test(
  "up, down and restart refuse a malformed --target before any project work without echoing it",
  async () => {
    const cases = ["up", "down", "restart"].flatMap((command) =>
      [
        // Previously printed as "Invalid --target value: x=proj-canary-...".
        { value: `x=${CANARY}`, canary: CANARY },
        { value: ALIAS_CANARY, canary: ALIAS_CANARY },
      ].map((entry) => ({ command, ...entry }))
    );
    // The empty cwd has no .hack/: any other refusal would mean project
    // discovery (or runtime work) ran before --target was checked.
    await runAll(cases, async ({ command, value, canary }) => {
      const result = await runHack({ args: [command, "--target", value] });
      expectRefusedWithoutEcho({
        label: `${command} --target`,
        result,
        message: INVALID_EXECUTION_TARGET_MESSAGE,
        canary,
      });
    });
    await expectNoCanaryFileNames(CANARY);
    await expectNoCanaryFileNames(ALIAS_CANARY);
  },
  { timeout: 120_000 }
);
