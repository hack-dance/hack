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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { ClosedCliError } from "../src/lib/cli-result.ts";
import { AtomicWriteRefusedError } from "../src/lib/fs.ts";
import {
  resolveProjectEnvConfigPath,
  resolveProjectEnvLocalConfigPath,
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

const RUNS_AS_ROOT =
  typeof process.getuid === "function" && process.getuid() === 0;

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
}): Promise<CliRun> {
  const proc = Bun.spawn([process.execPath, ENTRYPOINT, ...opts.args], {
    cwd: opts.repo.projectRoot,
    env: privateCliEnv({
      root: opts.repo.root,
      env: {
        HACK_GLOBAL_CONFIG_PATH: join(opts.repo.root, "hack-config.json"),
        HACK_LOGGER: opts.logger,
        HACK_NO_INTERACTIVE: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
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
