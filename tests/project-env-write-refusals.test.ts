import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { ClosedCliError } from "../src/lib/cli-result.ts";
import {
  AtomicWriteConflictError,
  AtomicWriteRefusedError,
  classifyFileWriteError,
  closedFileWriteError,
  FileWriteRefusedError,
  writeTextFileAtomicIfChanged,
} from "../src/lib/fs.ts";
import { LEGACY_ADOPTION_SELECTION_MESSAGES } from "../src/lib/native-compose-adoption-marker.ts";
import {
  assertValidProjectEnvScopeName,
  ENV_KEY_ASSIGNMENT_MESSAGE,
  ENV_KEY_INVALID_MESSAGE,
  ENV_SCOPE_INVALID_MESSAGE,
  ENV_SCOPE_UNKNOWN_MESSAGE,
  HACK_DIR_GITIGNORE_REFUSAL,
  HackDirGitignoreRefusalError,
  hydrateProjectEnvLocalLayer,
  ProjectEnvKeyRefusalError,
  parseProjectEnvTarget,
  resolveProjectEnvConfigPath,
  resolveProjectEnvLocalConfigPath,
  resolveProjectEnvValue,
  setProjectEnvValue,
  unsetProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1330: env write refusals left after #340. An unset on a layer it cannot
 * read refuses like a set instead of reporting nothing to remove; a layer whose
 * group the caller cannot keep is refused with its own closed reason; and every
 * refusal prints one value-free line under every logger backend, never a stack.
 * Every value here is a synthetic test string; every child gets a private HOME
 * inside a temp directory.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const FOREIGN_OWNER_WORKER = resolve(
  import.meta.dir,
  "fixtures/atomic-write-foreign-owner-worker.ts"
);
const KEPT_VALUE = "synthetic-kept-5d0e";
const NEW_VALUE = "synthetic-new-a713";
const LAYER = `version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    KEPT_SETTING: ${KEPT_VALUE}\n`;

/**
 * Permission bits do not bind an effective uid of 0, whatever the real uid is,
 * so tests that rely on a refused permission skip under it.
 */
const RUNS_AS_ROOT = (process.geteuid?.() ?? process.getuid?.() ?? -1) === 0;

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await chmodTreeWritable(tempDir);
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

/** A refused test may leave a mode-000 layer; make it removable. */
async function chmodTreeWritable(directory: string): Promise<void> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile()) {
      await chmod(join(entry.parentPath, entry.name), 0o600).catch(
        () => undefined
      );
    }
  }
}

type Repo = {
  readonly root: string;
  readonly projectRoot: string;
  readonly projectDir: string;
};

async function createRepo(base: string = tmpdir()): Promise<Repo> {
  const root = await mkdtemp(join(base, "hack-env-refusal-"));
  tempDirs.add(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ name: "env-refusal", dev_host: "env-refusal.hack" }, null, 2)}\n`
  );
  return { root, projectRoot, projectDir };
}

type Layer = "tracked" | "local";

function layerPath(repo: Repo, layer: Layer): string {
  return layer === "local"
    ? resolveProjectEnvLocalConfigPath({
        projectDir: repo.projectDir,
        envName: null,
      })
    : resolveProjectEnvConfigPath({
        projectDir: repo.projectDir,
        envName: null,
      });
}

async function refusalOf(
  pending: Promise<unknown>
): Promise<AtomicWriteRefusedError> {
  try {
    await pending;
  } catch (error: unknown) {
    if (error instanceof AtomicWriteRefusedError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the write to be refused");
}

async function tmpSiblings(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
}

// Root bypasses permission bits, so an unreadable layer only exists for others.
for (const layer of ["tracked", "local"] as const) {
  test.skipIf(RUNS_AS_ROOT)(
    `unset on an unreadable ${layer} layer refuses like set and keeps the layer`,
    async () => {
      const repo = await createRepo();
      const file = layerPath(repo, layer);
      await writeFile(file, LAYER);
      await chmod(file, 0o000);

      const refusal = await refusalOf(
        unsetProjectEnvValue({
          projectRoot: repo.projectRoot,
          projectDir: repo.projectDir,
          envName: null,
          scope: "global",
          key: "KEPT_SETTING",
          local: layer === "local",
        })
      );
      expect(refusal).toBeInstanceOf(ClosedCliError);
      expect(refusal.reason).toBe("unreadable");
      expect(refusal.message).toBe(
        `Refusing to replace ${file}: it exists but cannot be read, so its contents cannot be kept.`
      );

      // `set` on the same layer gives the identical refusal.
      const setRefusal = await refusalOf(
        setProjectEnvValue({
          projectRoot: repo.projectRoot,
          projectDir: repo.projectDir,
          envName: null,
          scope: "global",
          key: "NEW_SETTING",
          value: NEW_VALUE,
          secret: false,
          local: layer === "local",
        })
      );
      expect(setRefusal.message).toBe(refusal.message);
      expect(setRefusal.message).not.toContain(NEW_VALUE);

      await chmod(file, 0o600);
      expect(await readFile(file, "utf8")).toBe(LAYER);
      expect(await tmpSiblings(repo.projectDir)).toEqual([]);
    }
  );
}

test("unset of a key that a readable layer lacks still reports no change", async () => {
  const repo = await createRepo();
  const file = layerPath(repo, "tracked");
  await writeFile(file, LAYER);

  const result = await unsetProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "ABSENT_SETTING",
  });
  expect(result).toEqual({ changed: false, filePath: file });
  expect(await readFile(file, "utf8")).toBe(LAYER);
});

/** A gid this process neither runs as nor belongs to. */
function foreignGid(): number {
  const own = new Set([
    ...(process.getgroups?.() ?? []),
    process.getgid?.() ?? -1,
  ]);
  let candidate = 54_321;
  while (own.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

// Root can assign any group, so the refusal only applies to other users.
test.skipIf(RUNS_AS_ROOT)(
  "a layer the caller owns in a group it is not in is refused with the group reason",
  async () => {
    const repo = await createRepo();
    const file = layerPath(repo, "tracked");
    await writeFile(file, LAYER);
    const before = await stat(file);

    const worker = Bun.spawn(
      [
        process.execPath,
        FOREIGN_OWNER_WORKER,
        file,
        "gid",
        String(foreignGid()),
      ],
      {
        cwd: repo.projectRoot,
        env: privateCliEnv({ root: repo.root }),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    worker.stdin.write("synthetic: after\n");
    await worker.stdin.end();
    const [stdout, exitCode] = await Promise.all([
      new Response(worker.stdout).text(),
      worker.exited,
    ]);
    expect({ stdout, exitCode }).toEqual({
      stdout: "refused:group_not_preserved\n",
      exitCode: 0,
    });
    expect(await readFile(file, "utf8")).toBe(LAYER);
    expect((await stat(file)).ino).toBe(before.ino);
    expect(await tmpSiblings(repo.projectDir)).toEqual([]);
  },
  30_000
);

/**
 * Unmocked variant of the case above. On macOS a new file takes its
 * directory's group, so a file created under `/tmp` (group `wheel`) and then
 * moved into a project keeps a group the user is usually not in. On a system
 * where that does not produce a foreign group (Linux gives a new file the
 * process's group), there is nothing to check and the test returns early.
 */
test.skipIf(RUNS_AS_ROOT)(
  "set refuses a layer moved in from a directory whose group the user is not in",
  async () => {
    const repo = await createRepo();
    const file = layerPath(repo, "tracked");
    const foreignDir = await mkdtemp("/tmp/hack-env-group-");
    tempDirs.add(foreignDir);
    const staged = join(foreignDir, "layer.yaml");
    await writeFile(staged, LAYER);
    const own = new Set(process.getgroups?.() ?? []);
    const projectGid = (await stat(repo.projectDir)).gid;
    const layerGid = (await stat(staged)).gid;
    if (own.has(layerGid) || layerGid === projectGid) {
      return;
    }
    try {
      await rename(staged, file);
    } catch {
      // A different filesystem would copy, not move; nothing to check then.
      return;
    }
    expect((await stat(file)).gid).toBe(layerGid);

    const refusal = await refusalOf(
      setProjectEnvValue({
        projectRoot: repo.projectRoot,
        projectDir: repo.projectDir,
        envName: null,
        scope: "global",
        key: "NEW_SETTING",
        value: NEW_VALUE,
        secret: false,
      })
    );
    expect(refusal.reason).toBe("group_not_preserved");
    expect(refusal.message).not.toContain(NEW_VALUE);
    expect(await readFile(file, "utf8")).toBe(LAYER);
    expect((await stat(file)).gid).toBe(layerGid);
    expect(await tmpSiblings(repo.projectDir)).toEqual([]);
  }
);

type CliRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runCli(opts: {
  readonly repo: Repo;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly logger: string;
  /** A module the child loads before the CLI, e.g. a filesystem fault. */
  readonly preload?: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<CliRun> {
  const preload = opts.preload ? ["--preload", opts.preload] : [];
  const proc = Bun.spawn(
    [process.execPath, ...preload, ENTRYPOINT, ...opts.args],
    {
      cwd: opts.repo.projectRoot,
      env: privateCliEnv({
        root: opts.repo.root,
        env: {
          HACK_GLOBAL_CONFIG_PATH: join(opts.repo.root, "hack-config.json"),
          HACK_LOGGER: opts.logger,
          HACK_NO_INTERACTIVE: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          ...opts.env,
        },
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  proc.stdin.write(opts.stdin);
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Output lines that carry text, ignoring the clack frame (`│`, `■`, ...). */
function textLines(run: CliRun): string[] {
  return `${run.stdout}\n${run.stderr}`
    .split("\n")
    .filter((line) => /[A-Za-z]/.test(line));
}

function expectOneLineRefusal(run: CliRun, expected: string): void {
  expect(run.exitCode).toBe(1);
  const lines = textLines(run);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(expected);
  const output = `${run.stdout}${run.stderr}`;
  // No stack frame, no source path, no value.
  expect(output).not.toMatch(/\bat\s.*\.ts:\d+/);
  expect(output).not.toContain(REPO_ROOT);
  expect(output).not.toContain(KEPT_VALUE);
  expect(output).not.toContain(NEW_VALUE);
}

for (const logger of ["console", "clack", "gum"] as const) {
  test.skipIf(RUNS_AS_ROOT)(
    `env set and unset refusals print one line with HACK_LOGGER=${logger}`,
    async () => {
      const repo = await createRepo();
      const file = layerPath(repo, "tracked");
      await writeFile(file, LAYER);
      await chmod(file, 0o000);
      const unreadable = `Refusing to replace ${file}: it exists but cannot be read`;

      const unset = await runCli({
        repo,
        args: ["env", "unset", "KEPT_SETTING", "--path", repo.projectRoot],
        stdin: "",
        logger,
      });
      expectOneLineRefusal(unset, unreadable);

      const set = await runCli({
        repo,
        args: [
          "env",
          "set",
          "NEW_SETTING",
          "--secret",
          "--value-stdin",
          "--path",
          repo.projectRoot,
        ],
        stdin: `${NEW_VALUE}\n`,
        logger,
      });
      expectOneLineRefusal(set, unreadable);

      await chmod(file, 0o600);
      expect(await readFile(file, "utf8")).toBe(LAYER);
      expect(await tmpSiblings(repo.projectDir)).toEqual([]);

      // An invalid layer is refused the same way, before anything is written.
      const invalid = `${LAYER}version: [\n`;
      await writeFile(file, invalid);
      const parseRefusal = await runCli({
        repo,
        args: [
          "env",
          "set",
          "NEW_SETTING",
          "--value-stdin",
          "--path",
          repo.projectRoot,
        ],
        stdin: `${NEW_VALUE}\n`,
        logger,
      });
      expectOneLineRefusal(parseRefusal, `Failed to parse ${file}:`);
      expect(await readFile(file, "utf8")).toBe(invalid);
    },
    60_000
  );
}

/**
 * Synthetic key and scope arguments shaped like a mistyped value. Neither may
 * appear in output: the refusals are fixed text. The key is assembled at
 * runtime so the source holds no secret-shaped literal.
 */
const INVALID_NAME_ARGUMENT = ["synthetic", "lowercase", "3c9e"].join("-");
const BAD_SCOPE_ARGUMENT = "Bad Scope synthetic-6b2d!";

const ARGUMENT_REFUSALS = [
  {
    name: "set with an invalid key",
    args: ["env", "set", INVALID_NAME_ARGUMENT, "--value-stdin"],
    message: ENV_KEY_INVALID_MESSAGE,
  },
  {
    name: "unset with an invalid key",
    args: ["env", "unset", INVALID_NAME_ARGUMENT],
    message: ENV_KEY_INVALID_MESSAGE,
  },
  {
    name: "set with an invalid --service scope",
    args: [
      "env",
      "set",
      "NEW_SETTING",
      "--service",
      BAD_SCOPE_ARGUMENT,
      "--value-stdin",
    ],
    message: ENV_SCOPE_INVALID_MESSAGE,
  },
  {
    name: "unset with an invalid dotted scope",
    args: ["env", "unset", `${BAD_SCOPE_ARGUMENT}.KEPT_SETTING`],
    message: ENV_SCOPE_INVALID_MESSAGE,
  },
] as const;

for (const logger of ["console", "clack", "gum"] as const) {
  test(`env set and unset argument refusals print one line with HACK_LOGGER=${logger}`, async () => {
    const repo = await createRepo();
    const file = layerPath(repo, "tracked");
    await writeFile(file, LAYER);

    for (const refusal of ARGUMENT_REFUSALS) {
      const run = await runCli({
        repo,
        args: [...refusal.args, "--path", repo.projectRoot],
        stdin: `${NEW_VALUE}\n`,
        logger,
      });
      expectOneLineRefusal(run, refusal.message);
      const output = `${run.stdout}${run.stderr}`;
      expect(output).not.toContain(INVALID_NAME_ARGUMENT);
      expect(output).not.toContain("synthetic-6b2d");
    }
    expect(await readFile(file, "utf8")).toBe(LAYER);
    expect(await tmpSiblings(repo.projectDir)).toEqual([]);
  }, 60_000);
}

// A lost compare-and-swap is reported by hydrate and other writers; the CLI
// prints a closed error as one line, so the class must stay closed.
test("a write conflict is a closed refusal", () => {
  const conflict = new AtomicWriteConflictError();
  expect(conflict).toBeInstanceOf(ClosedCliError);
  expect(conflict.message).toBe(
    "The file changed while it was being replaced; nothing was written."
  );
});

test("set, unset and hydrate argument refusals are closed errors", async () => {
  const repo = await createRepo();
  const base = {
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
  };
  const refusals: [() => unknown, string][] = [
    [() => parseProjectEnvTarget({ keyOrPath: " " }), "Env key is required."],
    [
      () => parseProjectEnvTarget({ keyOrPath: `KEY=${NEW_VALUE}` }),
      ENV_KEY_ASSIGNMENT_MESSAGE,
    ],
    [
      () =>
        parseProjectEnvTarget({ keyOrPath: "api.KEY", scopeOverride: "api" }),
      "Do not combine dotted scope syntax with --service.",
    ],
    [
      () =>
        parseProjectEnvTarget({ keyOrPath: `api.${INVALID_NAME_ARGUMENT}` }),
      ENV_KEY_INVALID_MESSAGE,
    ],
    [
      () => parseProjectEnvTarget({ keyOrPath: INVALID_NAME_ARGUMENT }),
      ENV_KEY_INVALID_MESSAGE,
    ],
    [
      () => assertValidProjectEnvScopeName({ scopeName: BAD_SCOPE_ARGUMENT }),
      ENV_SCOPE_INVALID_MESSAGE,
    ],
    [
      () =>
        setProjectEnvValue({
          ...base,
          scope: "global",
          key: INVALID_NAME_ARGUMENT,
          value: NEW_VALUE,
          secret: false,
        }),
      ENV_KEY_INVALID_MESSAGE,
    ],
    [
      () =>
        hydrateProjectEnvLocalLayer({
          ...base,
          scope: "global",
          entries: new Map([[INVALID_NAME_ARGUMENT, NEW_VALUE]]),
          secret: false,
        }),
      ENV_KEY_INVALID_MESSAGE,
    ],
  ];
  for (const [refuse, message] of refusals) {
    let caught: unknown;
    try {
      await refuse();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ClosedCliError);
    expect((caught as Error).message).toBe(message);
  }
  // Nothing was written: no layer and no key file.
  expect(await readdir(repo.projectDir)).toEqual(
    expect.not.arrayContaining([
      layerPath(repo, "tracked").split("/").at(-1),
      layerPath(repo, "local").split("/").at(-1),
    ])
  );
  expect(await readdir(repo.projectRoot)).toEqual([".hack"]);
});

/**
 * Synthetic secret values for the key-file refusals, assembled at runtime so
 * the source holds no secret-shaped literal. Neither may reach any output.
 */
const FIRST_SECRET = ["synthetic", "first", "secret", "8b41"].join("-");
const SECOND_SECRET = ["synthetic", "second", "secret", "e07c"].join("-");

async function runGit(repo: Repo, args: readonly string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repo.projectRoot,
    env: privateCliEnv({
      root: repo.root,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }),
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect({ args, exitCode, stderr }).toEqual({ args, exitCode: 0, stderr: "" });
}

function setSecretArgs(repo: Repo, key: string): string[] {
  return [
    "env",
    "set",
    key,
    "--secret",
    "--value-stdin",
    "--path",
    repo.projectRoot,
  ];
}

/** Sets the first secret, which creates the project key file. */
async function createProjectKey(
  repo: Repo,
  logger: string
): Promise<{ readonly keyPath: string; readonly keyText: string }> {
  const first = await runCli({
    repo,
    args: setSecretArgs(repo, "SECRET_ONE"),
    stdin: `${FIRST_SECRET}\n`,
    logger,
  });
  expect(first.exitCode).toBe(0);
  const keyPath = resolve(repo.projectRoot, ".hack.secret.key");
  return { keyPath, keyText: (await readFile(keyPath, "utf8")).trim() };
}

function expectNoSecretMaterial(run: CliRun, keyText: string): void {
  const output = `${run.stdout}${run.stderr}`;
  expect(keyText.length).toBeGreaterThan(0);
  expect(output).not.toContain(keyText);
  expect(output).not.toContain(FIRST_SECRET);
  expect(output).not.toContain(SECOND_SECRET);
}

for (const logger of ["console", "clack", "gum"] as const) {
  test.skipIf(RUNS_AS_ROOT)(
    `project key refusals print one line with HACK_LOGGER=${logger}`,
    async () => {
      const repo = await createRepo();
      const file = layerPath(repo, "tracked");
      await writeFile(file, LAYER);
      const { keyPath, keyText } = await createProjectKey(repo, logger);
      const layerBefore = await readFile(file, "utf8");

      // A git-tracked key is refused before it encrypts anything.
      await runGit(repo, ["init", "-q"]);
      await runGit(repo, ["add", "-f", ".hack.secret.key"]);
      const tracked = await runCli({
        repo,
        args: setSecretArgs(repo, "SECRET_TWO"),
        stdin: `${SECOND_SECRET}\n`,
        logger,
      });
      expectOneLineRefusal(
        tracked,
        "Refusing to encrypt with a git-tracked .hack.secret.key"
      );
      expectNoSecretMaterial(tracked, keyText);

      // An unreadable key is refused the same way.
      await runGit(repo, ["rm", "-q", "--cached", ".hack.secret.key"]);
      await chmod(keyPath, 0o000);
      const unreadable = await runCli({
        repo,
        args: setSecretArgs(repo, "SECRET_TWO"),
        stdin: `${SECOND_SECRET}\n`,
        logger,
      });
      expectOneLineRefusal(
        unreadable,
        "Refusing project env key: .hack.secret.key must be"
      );
      expectNoSecretMaterial(unreadable, keyText);

      await chmod(keyPath, 0o600);
      expect(await readFile(file, "utf8")).toBe(layerBefore);
      expect(await tmpSiblings(repo.projectDir)).toEqual([]);
    },
    60_000
  );

  test(`a symlinked .hack/.gitignore refusal prints one line with HACK_LOGGER=${logger}`, async () => {
    const repo = await createRepo();
    await writeFile(layerPath(repo, "tracked"), LAYER);
    const linkTarget = join(repo.root, "elsewhere-gitignore");
    await writeFile(linkTarget, "# synthetic\n");
    await symlink(linkTarget, resolve(repo.projectDir, ".gitignore"));

    const run = await runCli({
      repo,
      args: [
        "env",
        "set",
        "NEW_SETTING",
        "--value-stdin",
        "--local",
        "--path",
        repo.projectRoot,
      ],
      stdin: `${NEW_VALUE}\n`,
      logger,
    });
    expectOneLineRefusal(run, HACK_DIR_GITIGNORE_REFUSAL);
    expect(await readFile(linkTarget, "utf8")).toBe("# synthetic\n");
    expect(await readdir(repo.projectDir)).not.toContain(
      layerPath(repo, "local").split("/").at(-1)
    );
  }, 60_000);

  test(`an unknown scope refusal prints one line with HACK_LOGGER=${logger}`, async () => {
    const repo = await createRepo();
    await writeFile(layerPath(repo, "tracked"), LAYER);

    const run = await runCli({
      repo,
      args: [
        "env",
        "list",
        "--service",
        "nosuch-synthetic-41d7",
        "--path",
        repo.projectRoot,
      ],
      stdin: "",
      logger,
    });
    expectOneLineRefusal(run, ENV_SCOPE_UNKNOWN_MESSAGE);
    expect(`${run.stdout}${run.stderr}`).not.toContain("nosuch-synthetic");
  }, 60_000);

  // Root can create files in a mode-0555 directory.
  test.skipIf(RUNS_AS_ROOT)(
    `set and unset in a non-writable .hack print one line with HACK_LOGGER=${logger}`,
    async () => {
      const repo = await createRepo();
      const tracked = layerPath(repo, "tracked");
      const local = layerPath(repo, "local");
      await writeFile(tracked, LAYER);
      await writeFile(local, LAYER);
      // Make the managed ignore file current, so only the layer write remains.
      const seeded = await runCli({
        repo,
        args: [
          "env",
          "set",
          "KEPT_SETTING",
          "--value-stdin",
          "--local",
          "--path",
          repo.projectRoot,
        ],
        stdin: `${KEPT_VALUE}\n`,
        logger,
      });
      expect(seeded.exitCode).toBe(0);
      const before = (await readdir(repo.projectDir)).sort();
      // The seeding set may reformat the local layer; compare to what it left.
      const trackedBefore = await readFile(tracked, "utf8");
      const localBefore = await readFile(local, "utf8");
      await chmod(repo.projectDir, 0o555);
      try {
        const runs: [readonly string[], string][] = [
          [["env", "set", "NEW_SETTING", "--value-stdin"], tracked],
          [["env", "set", "NEW_SETTING", "--value-stdin", "--local"], local],
          [["env", "unset", "KEPT_SETTING"], tracked],
          [["env", "unset", "KEPT_SETTING", "--local"], local],
        ];
        for (const [args, file] of runs) {
          const run = await runCli({
            repo,
            args: [...args, "--path", repo.projectRoot],
            stdin: `${NEW_VALUE}\n`,
            logger,
          });
          expectOneLineRefusal(
            run,
            `Refusing to replace ${file}: its directory is not writable.`
          );
          // The random staging path and the raw errno never reach the output.
          expect(`${run.stdout}${run.stderr}`).not.toContain(".tmp");
          expect(`${run.stdout}${run.stderr}`).not.toContain("EACCES");
        }
      } finally {
        await chmod(repo.projectDir, 0o755);
      }
      expect((await readdir(repo.projectDir)).sort()).toEqual(before);
      expect(await readFile(tracked, "utf8")).toBe(trackedBefore);
      expect(await readFile(local, "utf8")).toBe(localBefore);
    },
    60_000
  );
}

test.skipIf(RUNS_AS_ROOT)(
  "an atomic write into a non-writable directory is a closed refusal",
  async () => {
    const repo = await createRepo();
    const file = layerPath(repo, "tracked");
    await writeFile(file, LAYER);
    await chmod(repo.projectDir, 0o555);
    try {
      const refusal = await refusalOf(
        writeTextFileAtomicIfChanged(file, `${LAYER}# changed\n`)
      );
      expect(refusal).toBeInstanceOf(ClosedCliError);
      expect(refusal.reason).toBe("directory_not_writable");
      expect(refusal.message).toBe(
        `Refusing to replace ${file}: its directory is not writable. Make that directory writable by your user, then retry.`
      );
    } finally {
      await chmod(repo.projectDir, 0o755);
    }
    expect(await readFile(file, "utf8")).toBe(LAYER);
    expect(await tmpSiblings(repo.projectDir)).toEqual([]);
  }
);

// The CLI prints a closed error as one line; other code still narrows on
// these classes with instanceof, so they keep their names and messages.
test("project key and .hack/.gitignore refusals are closed errors", () => {
  const gitignore = new HackDirGitignoreRefusalError();
  expect(gitignore).toBeInstanceOf(ClosedCliError);
  expect(gitignore).toBeInstanceOf(HackDirGitignoreRefusalError);
  expect(gitignore.name).toBe("HackDirGitignoreRefusalError");
  expect(gitignore.message).toBe(HACK_DIR_GITIGNORE_REFUSAL);

  const key = new ProjectEnvKeyRefusalError("Synthetic key refusal.");
  expect(key).toBeInstanceOf(ClosedCliError);
  expect(key).toBeInstanceOf(ProjectEnvKeyRefusalError);
  expect(key.name).toBe("ProjectEnvKeyRefusalError");
  expect(key.message).toBe("Synthetic key refusal.");
});

test("an unknown scope in a single-value read is a closed refusal", async () => {
  const repo = await createRepo();
  await writeFile(layerPath(repo, "tracked"), LAYER);
  let caught: unknown;
  try {
    await resolveProjectEnvValue({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      envName: null,
      serviceNames: ["api"],
      scope: "nosuch-synthetic-41d7",
      key: "KEPT_SETTING",
    });
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ClosedCliError);
  expect((caught as Error).message).toBe(
    `${ENV_SCOPE_UNKNOWN_MESSAGE} Configured scopes: global, api.`
  );
});

/**
 * Filesystem failures the user must fix (HACK-1330 verifier D1-D5): a refused
 * `env set`, `unset` or `hydrate` prints one closed line that names the file
 * Hack was writing and the remedy, never the raw errno, the random staging
 * path or a stack, under every logger and in the `--json` envelope.
 */
const STAGING_ERRNO_PRELOAD = resolve(
  import.meta.dir,
  "fixtures/staging-errno-preload.ts"
);

const ERRNO_CODES = [
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSPC",
  "EDQUOT",
  "ENOTDIR",
] as const;

function expectNoErrnoOrStaging(run: CliRun): void {
  const output = `${run.stdout}${run.stderr}`;
  expect(output).not.toContain(".tmp");
  for (const code of ERRNO_CODES) {
    expect(output).not.toContain(code);
  }
  expect(output).not.toMatch(/\b(open|mkdir|rename) '/);
}

type JsonFailure = { readonly code: string; readonly message: string };

function jsonFailure(run: CliRun): JsonFailure {
  expect(run.exitCode).toBe(1);
  const envelope: unknown = JSON.parse(run.stdout);
  expect(envelope).toMatchObject({ ok: false });
  return (envelope as { readonly error: JsonFailure }).error;
}

const HYDRATE_INPUT = `NEW_SETTING=${NEW_VALUE}\n`;

function permissionWriteRefusal(path: string): string {
  return `Could not write ${path}: permission denied. Make the file and its directory writable by your user, then retry.`;
}

for (const logger of ["console", "clack", "gum"] as const) {
  // D1: no seeding set first, so the missing `.hack/.gitignore` must be
  // written (through replacePrivateFileAtomic) in a directory that refuses it.
  test.skipIf(RUNS_AS_ROOT)(
    `set --local and hydrate needing .hack/.gitignore in a non-writable .hack print one line with HACK_LOGGER=${logger}`,
    async () => {
      const repo = await createRepo();
      const local = layerPath(repo, "local");
      await writeFile(local, LAYER);
      // The hydration lock lives in .hack/.internal; give hydrate one so it
      // reaches the ignore-file write (D4 covers a missing .internal).
      await mkdir(resolve(repo.projectDir, ".internal"));
      const before = (await readdir(repo.projectDir)).sort();
      const gitignore = resolve(repo.projectDir, ".gitignore");
      await chmod(repo.projectDir, 0o555);
      try {
        const runs: [readonly string[], string][] = [
          [
            ["env", "set", "NEW_SETTING", "--value-stdin", "--local"],
            `${NEW_VALUE}\n`,
          ],
          [["env", "hydrate"], HYDRATE_INPUT],
        ];
        for (const [args, stdin] of runs) {
          const run = await runCli({
            repo,
            args: [...args, "--path", repo.projectRoot],
            stdin,
            logger,
          });
          expectOneLineRefusal(run, permissionWriteRefusal(gitignore));
          expectNoErrnoOrStaging(run);
        }
      } finally {
        await chmod(repo.projectDir, 0o755);
      }
      expect((await readdir(repo.projectDir)).sort()).toEqual(before);
      expect(await readFile(local, "utf8")).toBe(LAYER);
      expect(await readdir(resolve(repo.projectDir, ".internal"))).toEqual([]);
    },
    60_000
  );

  // D2: the first secret must create .hack.secret.key in a repo root that
  // refuses new files (publishPrivateFileExclusive's staging open).
  test.skipIf(RUNS_AS_ROOT)(
    `set --secret creating the key in a non-writable repo root prints one line with HACK_LOGGER=${logger}`,
    async () => {
      const repo = await createRepo();
      const tracked = layerPath(repo, "tracked");
      await writeFile(tracked, LAYER);
      const keyPath = resolve(repo.projectRoot, ".hack.secret.key");
      await chmod(repo.projectRoot, 0o555);
      let run: CliRun;
      try {
        run = await runCli({
          repo,
          args: setSecretArgs(repo, "NEW_SECRET"),
          stdin: `${NEW_VALUE}\n`,
          logger,
        });
      } finally {
        await chmod(repo.projectRoot, 0o755);
      }
      expectOneLineRefusal(run, permissionWriteRefusal(keyPath));
      expectNoErrnoOrStaging(run);
      expect(await readdir(repo.projectRoot)).toEqual([".hack"]);
      expect(await readFile(tracked, "utf8")).toBe(LAYER);
    },
    60_000
  );

  // D3: an unreadable `.hack/.gitignore` (readReplaceablePrivateFile's open).
  test.skipIf(RUNS_AS_ROOT)(
    `set --local with an unreadable .hack/.gitignore prints one line with HACK_LOGGER=${logger}`,
    async () => {
      const repo = await createRepo();
      const local = layerPath(repo, "local");
      await writeFile(local, LAYER);
      const gitignore = resolve(repo.projectDir, ".gitignore");
      await writeFile(gitignore, "# synthetic\n");
      await chmod(gitignore, 0o000);
      const run = await runCli({
        repo,
        args: [
          "env",
          "set",
          "NEW_SETTING",
          "--value-stdin",
          "--local",
          "--path",
          repo.projectRoot,
        ],
        stdin: `${NEW_VALUE}\n`,
        logger,
      });
      expectOneLineRefusal(
        run,
        `Could not read ${gitignore}: permission denied. Make the file readable by your user, then retry.`
      );
      expectNoErrnoOrStaging(run);
      await chmod(gitignore, 0o644);
      expect(await readFile(gitignore, "utf8")).toBe("# synthetic\n");
      expect(await readFile(local, "utf8")).toBe(LAYER);
    },
    60_000
  );

  // D4: hydrate must create .hack/.internal for its lock in a non-writable .hack.
  test.skipIf(RUNS_AS_ROOT)(
    `hydrate needing .hack/.internal in a non-writable .hack prints one line with HACK_LOGGER=${logger}`,
    async () => {
      const repo = await createRepo();
      const internal = resolve(repo.projectDir, ".internal");
      const expected = `Could not create directory ${internal}: permission denied. Make its parent directory writable by your user, then retry.`;
      const before = (await readdir(repo.projectDir)).sort();
      await chmod(repo.projectDir, 0o555);
      try {
        const run = await runCli({
          repo,
          args: ["env", "hydrate", "--path", repo.projectRoot],
          stdin: HYDRATE_INPUT,
          logger,
        });
        expectOneLineRefusal(run, expected);
        expectNoErrnoOrStaging(run);

        const json = await runCli({
          repo,
          args: ["env", "hydrate", "--json", "--path", repo.projectRoot],
          stdin: HYDRATE_INPUT,
          logger,
        });
        // The same code as the other closed env refusals, and no raw errno.
        expect(jsonFailure(json)).toEqual({
          code: "E_UNEXPECTED",
          message: expected,
        });
        expectNoErrnoOrStaging(json);
        expect(json.stdout).not.toContain(NEW_VALUE);
      } finally {
        await chmod(repo.projectDir, 0o755);
      }
      expect((await readdir(repo.projectDir)).sort()).toEqual(before);
    },
    60_000
  );

  // D5: a full disk while staging the layer (writeTextFileAtomicIfChanged).
  test(`set and unset on a full disk print one line with HACK_LOGGER=${logger}`, async () => {
    const repo = await createRepo();
    const tracked = layerPath(repo, "tracked");
    await writeFile(tracked, LAYER);
    const expected = `Refusing to replace ${tracked}: no space is left on the device or the disk quota is exceeded. Free some disk space or quota, then retry.`;
    for (const args of [
      ["env", "set", "NEW_SETTING", "--value-stdin"],
      ["env", "unset", "KEPT_SETTING"],
    ]) {
      const run = await runCli({
        repo,
        args: [...args, "--path", repo.projectRoot],
        stdin: `${NEW_VALUE}\n`,
        logger,
        preload: STAGING_ERRNO_PRELOAD,
        env: { HACK_TEST_STAGING_ERRNO: "ENOSPC" },
      });
      expectOneLineRefusal(run, expected);
      expectNoErrnoOrStaging(run);
    }
    expect(await readFile(tracked, "utf8")).toBe(LAYER);
    expect(await tmpSiblings(repo.projectDir)).toEqual([]);
  }, 60_000);

  test.skipIf(RUNS_AS_ROOT)(
    `set and unset in a non-searchable .hack report a permission problem with HACK_LOGGER=${logger}`,
    async () => {
      const repo = await createRepo();
      await writeFile(layerPath(repo, "tracked"), LAYER);
      await chmod(repo.projectDir, 0o644);
      try {
        for (const args of [
          ["env", "set", "NEW_SETTING", "--value-stdin"],
          ["env", "unset", "KEPT_SETTING"],
        ]) {
          const run = await runCli({
            repo,
            args: [...args, "--path", repo.projectRoot],
            stdin: `${NEW_VALUE}\n`,
            logger,
          });
          expectOneLineRefusal(
            run,
            LEGACY_ADOPTION_SELECTION_MESSAGES.permission
          );
          expect(`${run.stdout}${run.stderr}`).not.toContain(
            LEGACY_ADOPTION_SELECTION_MESSAGES.adoption
          );
        }
      } finally {
        await chmod(repo.projectDir, 0o755);
      }
      expect(await readFile(layerPath(repo, "tracked"), "utf8")).toBe(LAYER);
    },
    60_000
  );
}

test.skipIf(RUNS_AS_ROOT)(
  "a non-searchable .hack is E_PERMISSION in the --json envelope",
  async () => {
    const repo = await createRepo();
    await writeFile(layerPath(repo, "tracked"), LAYER);
    await chmod(repo.projectDir, 0o644);
    try {
      const run = await runCli({
        repo,
        args: ["env", "hydrate", "--json", "--path", repo.projectRoot],
        stdin: HYDRATE_INPUT,
        logger: "console",
      });
      expect(jsonFailure(run)).toEqual({
        code: "E_PERMISSION",
        message: LEGACY_ADOPTION_SELECTION_MESSAGES.permission,
      });
    } finally {
      await chmod(repo.projectDir, 0o755);
    }
  },
  60_000
);

const NO_SPACE_REASON =
  "no space is left on the device or the disk quota is exceeded. Free some disk space or quota, then retry.";
const READ_ONLY_REASON =
  "the filesystem is read-only. Use a writable checkout or remount the filesystem read-write, then retry.";
const NOT_A_DIRECTORY_REASON =
  "a parent of that path is not a directory. Replace that path with a directory, then retry.";

// The rest of the errno class, through both writers: the layer's atomic write
// (`set`) and the `.hack/.gitignore` private replace (`set --local`).
for (const [code, layerReason, privateReason] of [
  ["EDQUOT", NO_SPACE_REASON, NO_SPACE_REASON],
  ["EROFS", READ_ONLY_REASON, READ_ONLY_REASON],
  ["ENOTDIR", NOT_A_DIRECTORY_REASON, NOT_A_DIRECTORY_REASON],
  [
    "EPERM",
    "its directory is not writable. Make that directory writable by your user, then retry.",
    "permission denied. Make the file and its directory writable by your user, then retry.",
  ],
] as const) {
  test(`an injected ${code} while staging is a closed refusal for set and set --local`, async () => {
    const repo = await createRepo();
    const tracked = layerPath(repo, "tracked");
    const local = layerPath(repo, "local");
    await writeFile(tracked, LAYER);
    await writeFile(local, LAYER);
    const gitignore = resolve(repo.projectDir, ".gitignore");
    const runs: [readonly string[], string][] = [
      [
        ["env", "set", "NEW_SETTING", "--value-stdin"],
        `Refusing to replace ${tracked}: ${layerReason}`,
      ],
      [
        ["env", "set", "NEW_SETTING", "--value-stdin", "--local"],
        `Could not write ${gitignore}: ${privateReason}`,
      ],
    ];
    for (const [args, expected] of runs) {
      const run = await runCli({
        repo,
        args: [...args, "--path", repo.projectRoot],
        stdin: `${NEW_VALUE}\n`,
        logger: "console",
        preload: STAGING_ERRNO_PRELOAD,
        env: { HACK_TEST_STAGING_ERRNO: code },
      });
      expectOneLineRefusal(run, expected);
      expectNoErrnoOrStaging(run);
    }
    expect(await readFile(tracked, "utf8")).toBe(LAYER);
    expect(await readFile(local, "utf8")).toBe(LAYER);
    expect(await readdir(repo.projectDir)).not.toContain(".gitignore");
    expect(await tmpSiblings(repo.projectDir)).toEqual([]);
  }, 60_000);
}

test("the write-failure classifier maps only its fixed errno set", () => {
  const cases = {
    EACCES: "permission_denied",
    EPERM: "permission_denied",
    EROFS: "read_only_filesystem",
    ENOSPC: "no_space",
    EDQUOT: "no_space",
    ENOTDIR: "not_a_directory",
  } as const;
  for (const [code, failure] of Object.entries(cases)) {
    const raw = Object.assign(new Error(`${code}: raw, open '/x/.y.tmp'`), {
      code,
    });
    expect(classifyFileWriteError(raw)).toBe(failure);
    const closed = closedFileWriteError({
      error: raw,
      path: "/x/y",
      operation: "write",
    });
    expect(closed).toBeInstanceOf(FileWriteRefusedError);
    expect(closed).toBeInstanceOf(ClosedCliError);
    expect((closed as Error).message).toStartWith("Could not write /x/y: ");
    expect((closed as Error).message).not.toContain(code);
    expect((closed as Error).message).not.toContain(".tmp");
  }
  // Anything else is unexpected and passes through untouched.
  for (const code of ["EEXIST", "ENOENT", "EIO", "ELOOP", "toString"]) {
    const raw = Object.assign(new Error(code), { code });
    expect(classifyFileWriteError(raw)).toBeNull();
    expect(
      closedFileWriteError({ error: raw, path: "/x/y", operation: "write" })
    ).toBe(raw);
  }
  expect(classifyFileWriteError("EACCES")).toBeNull();
});
