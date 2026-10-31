import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { INVALID_ENV_SELECTION_MESSAGE } from "../src/cli/env-selection.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { HackCliError, type HackErrorCode } from "../src/lib/cli-result.ts";
import {
  isHardLinkUnsupportedError,
  publishByExclusivePlaceholder,
} from "../src/lib/exclusive-publish.ts";
import {
  type AtomicWriteRefusal,
  AtomicWriteRefusedError,
  ensureDirForWrite,
  ensureRealDirectoryForWrite,
  FileWriteRefusedError,
} from "../src/lib/fs.ts";
import {
  ENV_CONFIG_NAME_MAX_LENGTH,
  parseEnvConfigSelection,
} from "../src/lib/project.ts";
import {
  HACK_DIR_GITIGNORE_REFUSAL,
  HackDirGitignoreRefusalError,
  ProjectEnvKeyLockTimeoutError,
  resolveProjectEnvConfigPath,
} from "../src/lib/project-env-config.ts";
import {
  ProjectsRegistryLockTimeoutError,
  withProjectsRegistryLock,
} from "../src/lib/projects-registry-lock.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1377: env write refusals still raw after HACK-1330.
 *
 * 1. A filesystem without hard links (ExFAT, FAT) refused every env write
 *    with a raw ENOTSUP from the lock's and the key's `link(2)` publish; the
 *    publish now falls back to an exclusive reservation plus rename.
 * 2. A dangling `.hack/.internal` symlink made hydrate print a raw EEXIST.
 * 3. A very long `--env` name printed a raw ENAMETOOLONG with a staging path.
 * 4. A stale project env key lock timed out with a stack.
 * 5. A `.hack/.gitignore` directory printed a line with no code.
 * 6. Mappings whose revert failed no test.
 *
 * Every value is a synthetic test string; every child gets a private HOME,
 * HACK_HOME and Docker client config inside a temp directory, never the
 * keychain; an env layer exists before any `--secret` set.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const ERRNO_PRELOAD = resolve(
  import.meta.dir,
  "fixtures/staging-errno-preload.ts"
);
const KEPT_VALUE = "synthetic-kept-41c7";
const NEW_VALUE = "synthetic-new-90ad";
const LAYER = `version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    KEPT_SETTING: ${KEPT_VALUE}\n`;
const HYDRATE_INPUT = `NEW_SETTING=${NEW_VALUE}\n`;

/** Permission bits do not bind root; permission-based cases skip under it. */
const RUNS_AS_ROOT = (process.geteuid?.() ?? process.getuid?.() ?? -1) === 0;

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
}, 30_000);

type Repo = {
  readonly root: string;
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly tracked: string;
};

async function createRepo(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "hack-env-gaps-"));
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
    `${JSON.stringify({ name: "env-gaps", dev_host: "env-gaps.hack" }, null, 2)}\n`
  );
  const tracked = resolveProjectEnvConfigPath({ projectDir, envName: null });
  await writeFile(tracked, LAYER);
  return { root, projectRoot, projectDir, tracked };
}

type CliRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runCli(opts: {
  readonly repo: Repo;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly logger?: string;
  /** Injected errno: the preload fails one filesystem step of one path. */
  readonly inject?: {
    readonly code: string;
    readonly step: string;
    readonly path: string;
  };
}): Promise<CliRun> {
  const preload = opts.inject ? ["--preload", ERRNO_PRELOAD] : [];
  const injected = opts.inject
    ? {
        HACK_TEST_STAGING_ERRNO: opts.inject.code,
        HACK_TEST_ERRNO_STEP: opts.inject.step,
        HACK_TEST_ERRNO_PATH: opts.inject.path,
      }
    : {};
  const proc = Bun.spawn(
    [process.execPath, ...preload, ENTRYPOINT, ...opts.args],
    {
      cwd: opts.repo.projectRoot,
      env: privateCliEnv({
        root: opts.repo.root,
        env: {
          HACK_HOME: join(opts.repo.root, "hack-home"),
          HACK_GLOBAL_CONFIG_PATH: join(opts.repo.root, "hack-config.json"),
          HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
          HACK_LOGGER: opts.logger ?? "console",
          HACK_NO_INTERACTIVE: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          ...injected,
        },
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  proc.stdin.write(opts.stdin ?? "");
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

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

/** Output lines that carry text, ignoring the clack frame (`│`, `■`, ...). */
function textLines(run: CliRun): string[] {
  return `${run.stdout}\n${run.stderr}`
    .split("\n")
    .filter((line) => /[A-Za-z]/.test(line));
}

const RAW_ERRNO_CODES = [
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
  "EEXIST",
  "ENAMETOOLONG",
  "EISDIR",
  "ENOENT",
  "EROFS",
] as const;

/** One closed line: no stack, no source path, no value, no errno, no staging name. */
function expectOneLineRefusal(run: CliRun, expected: string): void {
  expect(run.exitCode).toBe(1);
  const lines = textLines(run);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(expected);
  expectNoRawDetail(run);
}

function expectNoRawDetail(run: CliRun): void {
  const output = `${run.stdout}${run.stderr}`;
  expect(output).not.toMatch(/\bat\s.*\.ts:\d+/);
  expect(output).not.toContain(REPO_ROOT);
  expect(output).not.toContain(KEPT_VALUE);
  expect(output).not.toContain(NEW_VALUE);
  expect(output).not.toContain(".tmp");
  expect(output).not.toContain(".owner");
  for (const code of RAW_ERRNO_CODES) {
    expect(output).not.toContain(code);
  }
  expect(output).not.toMatch(/\b(open|mkdir|rename|link) '/);
}

/** Exit 0 with only the success line: no warning, error or raw detail. */
function expectSuccess(run: CliRun): void {
  expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({
    exitCode: 0,
    stdout: "",
  });
  expect(run.stderr).toStartWith("SUCCESS: Updated ");
  expect(textLines(run)).toHaveLength(1);
  expectNoRawDetail(run);
}

type JsonFailure = { readonly code: string; readonly message: string };

function jsonFailure(run: CliRun): JsonFailure {
  expect(run.exitCode).toBe(1);
  const envelope: unknown = JSON.parse(run.stdout);
  expect(envelope).toMatchObject({ ok: false });
  return (envelope as { readonly error: JsonFailure }).error;
}

function setArgs(repo: Repo, key: string, ...extra: string[]): string[] {
  return [
    "env",
    "set",
    key,
    "--value-stdin",
    ...extra,
    "--path",
    repo.projectRoot,
  ];
}

/** Names in `directory` that a failed or finished write must not leave. */
async function leftovers(directory: string): Promise<string[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  return names.filter(
    (name) =>
      name.endsWith(".tmp") || name.endsWith(".owner") || name.endsWith(".lock")
  );
}

// ---------------------------------------------------------------------------
// 1. No hard links: the exclusive publish falls back to reservation + rename.
// ---------------------------------------------------------------------------

/** Every `link(2)` fails as it does on ExFAT (macOS) or FAT (Linux). */
function noHardLinks(code: "ENOTSUP" | "EPERM") {
  return { code, step: "link", path: "." } as const;
}

for (const code of ["ENOTSUP", "EPERM"] as const) {
  for (const git of [false, true]) {
    test(`with link(2) failing ${code}, the first --secret ${git ? "in a git checkout " : ""}creates the key and later writes still lock`, async () => {
      const repo = await createRepo();
      if (git) {
        await runGit(repo, ["init", "-q"]);
      }
      const keyPath = resolve(repo.projectRoot, ".hack.secret.key");

      const first = await runCli({
        repo,
        args: setArgs(repo, "FIRST_SECRET", "--secret"),
        stdin: `${NEW_VALUE}\n`,
        inject: noHardLinks(code),
      });
      expectSuccess(first);
      expectNoRawDetail(first);
      const keyText = (await readFile(keyPath, "utf8")).trim();
      expect(keyText.length).toBeGreaterThan(0);
      expect((await lstat(keyPath)).mode & 0o777).toBe(0o600);

      // The lock was released (a second write would otherwise time out), the
      // key was adopted, and nothing was left behind.
      const second = await runCli({
        repo,
        args: setArgs(repo, "SECOND_SECRET", "--secret"),
        stdin: `${NEW_VALUE}\n`,
        inject: noHardLinks(code),
      });
      expect(second.exitCode).toBe(0);
      expect((await readFile(keyPath, "utf8")).trim()).toBe(keyText);
      const layer = await readFile(repo.tracked, "utf8");
      expect(layer).toContain("FIRST_SECRET");
      expect(layer).toContain("SECOND_SECRET");
      expect(layer).toContain(KEPT_VALUE);
      expect(layer).not.toContain(NEW_VALUE);
      expect(await leftovers(repo.projectRoot)).toEqual([]);
      expect(await leftovers(repo.projectDir)).toEqual([]);
      expect(await leftovers(resolve(repo.projectDir, ".internal"))).toEqual(
        []
      );
      if (git) {
        expect(await leftovers(resolve(repo.projectRoot, ".git"))).toEqual([]);
      }
    }, 60_000);
  }
}

test("with link(2) failing ENOTSUP, concurrent sets of different keys are all kept", async () => {
  const repo = await createRepo();
  const keys = ["ALPHA_SETTING", "BRAVO_SETTING", "CHARLIE_SETTING"];
  const runs = await Promise.all(
    keys.map(
      async (key) =>
        await runCli({
          repo,
          args: setArgs(repo, key),
          stdin: `${NEW_VALUE}\n`,
          inject: noHardLinks("ENOTSUP"),
        })
    )
  );
  expect(runs.map((run) => run.exitCode)).toEqual([0, 0, 0]);
  const layer = await readFile(repo.tracked, "utf8");
  for (const key of keys) {
    expect(layer).toContain(key);
  }
  expect(layer).toContain(KEPT_VALUE);
  expect(await leftovers(resolve(repo.projectDir, ".internal"))).toEqual([]);
}, 60_000);

test("only link(2) errors that mean no hard links select the fallback", () => {
  for (const code of ["ENOTSUP", "EOPNOTSUPP", "EPERM"]) {
    expect(isHardLinkUnsupportedError({ code })).toBe(true);
  }
  for (const code of ["EEXIST", "EACCES", "EXDEV", "ENOENT", "EMLINK"]) {
    expect(isHardLinkUnsupportedError({ code })).toBe(false);
  }
  expect(isHardLinkUnsupportedError("ENOTSUP")).toBe(false);
  expect(isHardLinkUnsupportedError(null)).toBe(false);
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hack-publish-"));
  tempDirs.add(directory);
  return directory;
}

test("the reservation fallback publishes the complete file and consumes the source", async () => {
  const directory = await scratch();
  const source = join(directory, ".target.staged.tmp");
  const target = join(directory, "target");
  await writeFile(source, "complete\n", { mode: 0o600 });

  expect(await publishByExclusivePlaceholder({ source, target })).toBe(true);
  expect(await readFile(target, "utf8")).toBe("complete\n");
  expect(await readdir(directory)).toEqual(["target"]);
});

test("the reservation fallback never replaces an existing file", async () => {
  const directory = await scratch();
  const source = join(directory, ".target.staged.tmp");
  const target = join(directory, "target");
  await writeFile(source, "mine\n");
  await writeFile(target, "theirs\n");

  expect(await publishByExclusivePlaceholder({ source, target })).toBe(false);
  expect(await readFile(target, "utf8")).toBe("theirs\n");
  expect(await readFile(source, "utf8")).toBe("mine\n");
});

test("the reservation fallback never follows or replaces a symlink", async () => {
  const directory = await scratch();
  const source = join(directory, ".target.staged.tmp");
  const target = join(directory, "target");
  const elsewhere = join(directory, "elsewhere");
  await writeFile(source, "mine\n");
  await symlink(elsewhere, target);

  expect(await publishByExclusivePlaceholder({ source, target })).toBe(false);
  expect(await readlink(target)).toBe(elsewhere);
  expect(await readdir(directory)).not.toContain("elsewhere");
});

test("a failed rename removes the reservation it created", async () => {
  const directory = await scratch();
  const target = join(directory, "target");
  let caught: unknown;
  try {
    await publishByExclusivePlaceholder({
      source: join(directory, "missing-source"),
      target,
    });
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: "ENOENT" });
  expect(await readdir(directory)).toEqual([]);
});

// Real ExFAT: opt-in on macOS, because it attaches and mounts a disk image.
// `HACK_TEST_EXFAT=1 bun test tests/project-env-write-refusal-gaps.test.ts`
const EXFAT_ENABLED =
  process.platform === "darwin" && process.env.HACK_TEST_EXFAT === "1";

async function sh(
  command: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const proc = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { exitCode, stdout };
}

test.skipIf(!EXFAT_ENABLED)(
  "on a real ExFAT volume the first --secret creates the key, in and out of git",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "hack-exfat-"));
    tempDirs.add(base);
    const image = join(base, "volume.img");
    const mountPoint = join(base, "mnt");
    await mkdir(mountPoint);
    expect((await sh(["mkfile", "-n", "64m", image])).exitCode).toBe(0);
    const attached = await sh([
      "hdiutil",
      "attach",
      "-nomount",
      "-imagekey",
      "diskimage-class=CRawDiskImage",
      image,
    ]);
    const device = attached.stdout.trim().split(/\s+/)[0] ?? "";
    expect(device).toMatch(/^\/dev\/disk\d+$/);
    try {
      expect(
        (await sh(["newfs_exfat", "-v", "hackexfat", device])).exitCode
      ).toBe(0);
      expect(
        (await sh(["diskutil", "mount", "-mountPoint", mountPoint, device]))
          .exitCode
      ).toBe(0);
      const mounts = await sh(["mount"]);
      expect(mounts.stdout).toMatch(new RegExp(`${device} on .*\\(exfat`));
      for (const git of [false, true]) {
        const root = await mkdtemp(join(mountPoint, "case-"));
        const projectRoot = join(root, "repo");
        const projectDir = join(projectRoot, ".hack");
        await mkdir(projectDir, { recursive: true });
        await writeFile(
          join(projectDir, PROJECT_COMPOSE_FILENAME),
          "services:\n  api:\n    image: alpine:3.20\n"
        );
        await writeFile(
          join(projectDir, PROJECT_CONFIG_FILENAME),
          `${JSON.stringify({ name: "env-exfat", dev_host: "env-exfat.hack" })}\n`
        );
        const tracked = resolveProjectEnvConfigPath({
          projectDir,
          envName: null,
        });
        await writeFile(tracked, LAYER);
        const repo: Repo = { root, projectRoot, projectDir, tracked };
        if (git) {
          await runGit(repo, ["init", "-q"]);
        }
        for (const key of ["FIRST_SECRET", "SECOND_SECRET"]) {
          const run = await runCli({
            repo,
            args: setArgs(repo, key, "--secret"),
            stdin: `${NEW_VALUE}\n`,
          });
          expectSuccess(run);
        }
        const keyText = (
          await readFile(join(projectRoot, ".hack.secret.key"), "utf8")
        ).trim();
        expect(keyText.length).toBeGreaterThan(0);
        expect(await readFile(tracked, "utf8")).toContain("SECOND_SECRET");
        expect(await leftovers(join(projectDir, ".internal"))).toEqual([]);
        if (git) {
          expect(await leftovers(join(projectRoot, ".git"))).toEqual([]);
        }
      }
    } finally {
      await sh(["diskutil", "unmount", "force", mountPoint]);
      await sh(["hdiutil", "detach", "-force", device]);
    }
  },
  120_000
);

// ---------------------------------------------------------------------------
// 2. A symlinked or non-directory `.hack/.internal` refuses hydrate closed.
// ---------------------------------------------------------------------------

const INTERNAL_REFUSAL = (internal: string) =>
  `E_PATH_CONFLICT: Could not create directory ${internal}: that path is a symlink or not a directory. Replace it with a regular directory, then retry.`;

for (const kind of ["dangling", "live"] as const) {
  test(`hydrate with a ${kind} .hack/.internal symlink is a closed E_PATH_CONFLICT`, async () => {
    const repo = await createRepo();
    const internal = resolve(repo.projectDir, ".internal");
    const elsewhere = resolve(repo.root, "elsewhere");
    if (kind === "live") {
      await mkdir(elsewhere);
    }
    await symlink(elsewhere, internal);

    for (const logger of ["console", "clack", "gum"]) {
      const run = await runCli({
        repo,
        args: ["env", "hydrate", "--path", repo.projectRoot],
        stdin: HYDRATE_INPUT,
        logger,
      });
      expectOneLineRefusal(run, INTERNAL_REFUSAL(internal));
    }
    const json = await runCli({
      repo,
      args: ["env", "hydrate", "--json", "--path", repo.projectRoot],
      stdin: HYDRATE_INPUT,
    });
    expect(jsonFailure(json)).toEqual({
      code: "E_PATH_CONFLICT",
      message: INTERNAL_REFUSAL(internal).replace("E_PATH_CONFLICT: ", ""),
    });
    // Nothing was created through the link, and the link is untouched.
    expect(await readlink(internal)).toBe(elsewhere);
    expect(await readdir(elsewhere).catch(() => null)).toEqual(
      kind === "live" ? [] : null
    );
    expect(await readFile(repo.tracked, "utf8")).toBe(LAYER);
  }, 60_000);
}

test("ensureDirForWrite refuses a dangling symlink or a file closed, not as EEXIST", async () => {
  const directory = await scratch();
  const dangling = join(directory, "dangling");
  const file = join(directory, "file");
  await symlink(join(directory, "nowhere"), dangling);
  await writeFile(file, "x");
  for (const path of [dangling, file]) {
    let caught: unknown;
    try {
      await ensureDirForWrite(path);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileWriteRefusedError);
    expect(caught).toMatchObject({
      code: "E_PATH_CONFLICT",
      failure: "not_a_directory_entry",
      message: INTERNAL_REFUSAL(path).replace("E_PATH_CONFLICT: ", ""),
    });
  }
  // A real directory (new or existing) is fine.
  await ensureRealDirectoryForWrite(join(directory, "fresh"));
  await ensureRealDirectoryForWrite(join(directory, "fresh"));
  expect((await lstat(join(directory, "fresh"))).isDirectory()).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. A too-long `--env` name is a closed E_USAGE; ENAMETOOLONG is closed too.
// ---------------------------------------------------------------------------

const LONGEST_NAME = "e".repeat(ENV_CONFIG_NAME_MAX_LENGTH);
const TOO_LONG_NAME = "e".repeat(215);

test("overlay names are accepted up to the limit and refused beyond it", () => {
  expect(ENV_CONFIG_NAME_MAX_LENGTH).toBe(128);
  expect(parseEnvConfigSelection(LONGEST_NAME)).toBe(LONGEST_NAME);
  expect(parseEnvConfigSelection(`${LONGEST_NAME}e`)).toBeUndefined();
  expect(parseEnvConfigSelection(TOO_LONG_NAME)).toBeUndefined();
  expect(INVALID_ENV_SELECTION_MESSAGE).toContain("at most 128 characters");
});

test("set, unset and hydrate refuse a too-long --env before touching the project", async () => {
  const repo = await createRepo();
  for (const args of [
    setArgs(repo, "NEW_SETTING", "--env", TOO_LONG_NAME),
    ["env", "unset", "KEPT_SETTING", "--env", TOO_LONG_NAME],
  ]) {
    const run = await runCli({ repo, args, stdin: `${NEW_VALUE}\n` });
    expect(run.exitCode).toBe(1);
    // A usage error found while parsing arguments also prints the help.
    expect(run.stderr).toContain(`ERROR: ${INVALID_ENV_SELECTION_MESSAGE}`);
    const output = `${run.stdout}${run.stderr}`;
    for (const raw of ["ENAMETOOLONG", ".owner", "hack.env.e", NEW_VALUE]) {
      expect(output).not.toContain(raw);
    }
    expect(output).not.toMatch(/\bat\s.*\.ts:\d+/);
    expect(output).not.toContain(TOO_LONG_NAME);
  }
  const json = await runCli({
    repo,
    args: [
      "env",
      "hydrate",
      "--json",
      "--env",
      TOO_LONG_NAME,
      "--path",
      repo.projectRoot,
    ],
    stdin: HYDRATE_INPUT,
  });
  expect(jsonFailure(json)).toEqual({
    code: "E_USAGE",
    message: INVALID_ENV_SELECTION_MESSAGE,
  });
  expect((await readdir(repo.projectDir)).sort()).toEqual(
    [
      PROJECT_COMPOSE_FILENAME,
      PROJECT_CONFIG_FILENAME,
      basename(repo.tracked),
    ].sort()
  );
}, 60_000);

test("an overlay name at the limit still writes its layer", async () => {
  const repo = await createRepo();
  const run = await runCli({
    repo,
    args: setArgs(repo, "NEW_SETTING", "--env", LONGEST_NAME),
    stdin: `${NEW_VALUE}\n`,
  });
  expectSuccess(run);
  const overlay = resolveProjectEnvConfigPath({
    projectDir: repo.projectDir,
    envName: LONGEST_NAME,
  });
  expect(await readFile(overlay, "utf8")).toContain("NEW_SETTING");
}, 60_000);

const NAME_TOO_LONG_REASON =
  "a file name or the path is too long for the filesystem. Use a shorter name or move the project to a shorter path, then retry.";

test("an injected ENAMETOOLONG at the layer staging and at its lock is a closed E_PATH_CONFLICT", async () => {
  const repo = await createRepo();
  const stagingPattern = "/\\.hack\\.env\\.default\\.yaml\\.[^/]+\\.tmp$";
  const lockOwnerPattern =
    "/hack\\.env\\.default\\.yaml\\.lock\\.[^/]+\\.owner$";
  for (const [path, expected] of [
    [
      stagingPattern,
      `E_PATH_CONFLICT: Refusing to replace ${repo.tracked}: ${NAME_TOO_LONG_REASON}`,
    ],
    [
      lockOwnerPattern,
      `E_PATH_CONFLICT: Could not write ${repo.tracked}: ${NAME_TOO_LONG_REASON}`,
    ],
  ] as const) {
    for (const args of [
      setArgs(repo, "NEW_SETTING"),
      ["env", "unset", "KEPT_SETTING", "--path", repo.projectRoot],
    ]) {
      const run = await runCli({
        repo,
        args,
        stdin: `${NEW_VALUE}\n`,
        inject: { code: "ENAMETOOLONG", step: "open", path },
      });
      expectOneLineRefusal(run, expected);
    }
  }
  expect(await readFile(repo.tracked, "utf8")).toBe(LAYER);
  expect(await leftovers(repo.projectDir)).toEqual([]);
}, 60_000);

// ---------------------------------------------------------------------------
// 4. A stale project env key lock is a closed E_LOCKED naming the remedy.
// ---------------------------------------------------------------------------

test("a key lock held by a live unrelated PID times out as a closed E_LOCKED", async () => {
  const repo = await createRepo();
  await runGit(repo, ["init", "-q"]);
  const lockPath = resolve(
    await realpath(repo.projectRoot),
    ".git",
    ".hack.secret.key.lock"
  );
  // This test runner is alive and is not the CLI child: a reused PID.
  await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600 });
  const expected = `E_LOCKED: Timed out waiting for the project env key lock ${lockPath}; nothing was written. Another hack command may be creating the key: retry when it finishes. If no other hack command is running, the lock is stale: remove ${lockPath}, then retry.`;

  const run = await runCli({
    repo,
    args: setArgs(repo, "NEW_SECRET", "--secret"),
    stdin: `${NEW_VALUE}\n`,
  });
  expectOneLineRefusal(run, expected);
  expect(await readFile(lockPath, "utf8")).toBe(`${process.pid}\n`);
  expect((await readdir(repo.projectRoot)).sort()).toEqual([".git", ".hack"]);
  expect(await readFile(repo.tracked, "utf8")).toBe(LAYER);
}, 60_000);

test("a lock timeout reports a busy recovery guard, and the key refusal names it", async () => {
  const directory = await scratch();
  const lockPath = join(directory, "resource.lock");
  // A dead owner (a PID far above any pid_max) with its recovery guard held.
  await writeFile(lockPath, "2147483646\n", { mode: 0o600 });
  await mkdir(`${lockPath}.recovery`);
  let caught: unknown;
  try {
    await withProjectsRegistryLock({
      lockPath,
      timeoutMs: 50,
      run: async () => "ran",
    });
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProjectsRegistryLockTimeoutError);
  expect((caught as ProjectsRegistryLockTimeoutError).recoveryBusy).toBe(true);

  const plain = new ProjectEnvKeyLockTimeoutError({
    lockPath,
    recoveryBusy: false,
  });
  const busy = new ProjectEnvKeyLockTimeoutError({
    lockPath,
    recoveryBusy: true,
  });
  expect(plain).toBeInstanceOf(HackCliError);
  expect(plain.code).toBe("E_LOCKED");
  expect(plain.message).toEndWith(
    `the lock is stale: remove ${lockPath}, then retry.`
  );
  expect(busy.message).toEndWith(
    `the lock is stale: remove ${lockPath} and the directory ${lockPath}.recovery, then retry.`
  );
});

// ---------------------------------------------------------------------------
// 5. A `.hack/.gitignore` directory is E_PATH_CONFLICT, as docs/env.md says.
// ---------------------------------------------------------------------------

test("a .hack/.gitignore directory is E_PATH_CONFLICT for set --local and hydrate --json", async () => {
  const repo = await createRepo();
  const gitignore = resolve(repo.projectDir, ".gitignore");
  await mkdir(gitignore);

  for (const logger of ["console", "clack", "gum"]) {
    const run = await runCli({
      repo,
      args: setArgs(repo, "NEW_SETTING", "--local"),
      stdin: `${NEW_VALUE}\n`,
      logger,
    });
    expectOneLineRefusal(run, `E_PATH_CONFLICT: ${HACK_DIR_GITIGNORE_REFUSAL}`);
  }
  const json = await runCli({
    repo,
    args: ["env", "hydrate", "--json", "--path", repo.projectRoot],
    stdin: HYDRATE_INPUT,
  });
  expect(jsonFailure(json)).toEqual({
    code: "E_PATH_CONFLICT",
    message: HACK_DIR_GITIGNORE_REFUSAL,
  });
  expect((await lstat(gitignore)).isDirectory()).toBe(true);
  expect(new HackDirGitignoreRefusalError().code).toBe("E_PATH_CONFLICT");
}, 60_000);

// ---------------------------------------------------------------------------
// 6. Mappings whose revert used to fail no test.
// ---------------------------------------------------------------------------

const KEY_LOCK_OWNER_PATTERN =
  "/\\.hack\\.secret\\.key\\.lock\\.[^/]+\\.owner$";

// The git dir cannot hold the key lock: the key is created unserialized, as
// before, instead of the lock failure being reported.
for (const code of ["ENOENT", "EPERM", "EROFS", "EACCES"] as const) {
  test(`an injected ${code} at the key lock creates the key without the lock`, async () => {
    const repo = await createRepo();
    await runGit(repo, ["init", "-q"]);
    const run = await runCli({
      repo,
      args: setArgs(repo, "NEW_SECRET", "--secret"),
      stdin: `${NEW_VALUE}\n`,
      inject: { code, step: "open", path: KEY_LOCK_OWNER_PATTERN },
    });
    expectSuccess(run);
    const key = await readFile(
      resolve(repo.projectRoot, ".hack.secret.key"),
      "utf8"
    );
    expect(key.trim().length).toBeGreaterThan(0);
    expect(await readFile(repo.tracked, "utf8")).toContain("NEW_SECRET");
    expect(await leftovers(resolve(repo.projectRoot, ".git"))).toEqual([]);
  }, 60_000);
}

const ATOMIC_WRITE_REFUSALS: Readonly<
  Record<AtomicWriteRefusal, readonly [HackErrorCode, string]>
> = {
  unreadable: [
    "E_PERMISSION",
    "it exists but cannot be read, so its contents cannot be kept",
  ],
  not_regular_file: ["E_PATH_CONFLICT", "it is not a regular file"],
  not_writable: ["E_PERMISSION", "it is not writable"],
  owner_not_preserved: [
    "E_PERMISSION",
    "its owner and group cannot be preserved",
  ],
  group_not_preserved: [
    "E_PERMISSION",
    "its group cannot be preserved because you are not a member of that group",
  ],
  directory_not_writable: [
    "E_PERMISSION",
    "its directory is not writable. Make that directory writable by your user, then retry",
  ],
  read_only_filesystem: [
    "E_PERMISSION",
    "the filesystem is read-only. Use a writable checkout or remount the filesystem read-write, then retry",
  ],
  no_space: [
    "E_NO_SPACE",
    "no space is left on the device or the disk quota is exceeded. Free some disk space or quota, then retry",
  ],
  not_a_directory: [
    "E_PATH_CONFLICT",
    "a parent of that path is not a directory. Replace that path with a directory, then retry",
  ],
  name_too_long: ["E_PATH_CONFLICT", NAME_TOO_LONG_REASON.replace(/\.$/, "")],
};

test("every atomic-write refusal has its fixed code and message", () => {
  for (const [reason, [code, text]] of Object.entries(ATOMIC_WRITE_REFUSALS)) {
    const refusal = new AtomicWriteRefusedError({
      path: "/synthetic/layer.yaml",
      reason: reason as AtomicWriteRefusal,
    });
    expect({ reason, code: refusal.code, message: refusal.message }).toEqual({
      reason,
      code,
      message: `Refusing to replace /synthetic/layer.yaml: ${text}.`,
    });
  }
});

test("a directory at the layer path is a closed E_PATH_CONFLICT", async () => {
  const repo = await createRepo();
  await rm(repo.tracked);
  await mkdir(repo.tracked);
  const run = await runCli({
    repo,
    args: setArgs(repo, "NEW_SETTING"),
    stdin: `${NEW_VALUE}\n`,
  });
  expectOneLineRefusal(
    run,
    `E_PATH_CONFLICT: Refusing to replace ${repo.tracked}: it is not a regular file.`
  );
}, 60_000);

test.skipIf(RUNS_AS_ROOT)(
  "a read-only layer is a closed E_PERMISSION not_writable",
  async () => {
    const repo = await createRepo();
    await chmod(repo.tracked, 0o444);
    const run = await runCli({
      repo,
      args: setArgs(repo, "NEW_SETTING"),
      stdin: `${NEW_VALUE}\n`,
    });
    expectOneLineRefusal(
      run,
      `E_PERMISSION: Refusing to replace ${repo.tracked}: it is not writable.`
    );
    expect(await readFile(repo.tracked, "utf8")).toBe(LAYER);
  },
  60_000
);

test("an injected EISDIR while staging the layer is a closed not_regular_file refusal", async () => {
  const repo = await createRepo();
  const run = await runCli({
    repo,
    args: setArgs(repo, "NEW_SETTING"),
    stdin: `${NEW_VALUE}\n`,
    inject: {
      code: "EISDIR",
      step: "open",
      path: "/\\.hack\\.env\\.default\\.yaml\\.[^/]+\\.tmp$",
    },
  });
  expectOneLineRefusal(
    run,
    `E_PATH_CONFLICT: Refusing to replace ${repo.tracked}: it is not a regular file.`
  );
  expect(await readFile(repo.tracked, "utf8")).toBe(LAYER);
  expect(await leftovers(repo.projectDir)).toEqual([]);
}, 60_000);
