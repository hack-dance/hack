import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as privateFiles from "node:fs/promises";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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
  PROJECT_ENV_FILENAME,
} from "../src/constants.ts";
import { removeDotEnvKey, upsertDotEnvValue } from "../src/lib/hack-env.ts";
import { PRIVATE_ENV_FILE_REFUSAL } from "../src/lib/private-env-file.ts";
import {
  REPLACEABLE_READ_ATTEMPTS,
  replacePrivateFileAtomic,
} from "../src/lib/private-file.ts";
import {
  materializeProjectEnv,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { restoreEnv } from "./helpers/env.ts";

// Synthetic values; none of them may appear in a refusal.
const SENTINEL_KEY = "SYNTHETIC_PRIVATE_ENV_KEY";
const SENTINEL_VALUE = "synthetic-private-env-value-never-in-errors";
const OUTSIDE_TEXT = "OUTSIDE_SENTINEL=synthetic-outside-file-never-read\n";

let root: string | null = null;
let previousHome: string | undefined;
let previousGlobalConfigPath: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-private-env-file-"));
  previousHome = process.env.HOME;
  previousGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  // No real HOME or global config is read or written by these tests.
  process.env.HOME = join(root, "home");
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "home", "hack.config.json");
  await mkdir(join(root, "home"), { recursive: true });
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
  restoreEnv("HOME", previousHome);
  restoreEnv("HACK_GLOBAL_CONFIG_PATH", previousGlobalConfigPath);
});

async function createProject(): Promise<{
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envFile: string;
  readonly outsideFile: string;
}> {
  if (!root) {
    throw new Error("Missing temp root");
  }
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api: {}\n"
  );
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ name: "private-env-test", dev_host: "private-env.hack" })}\n`
  );
  const outsideFile = resolve(root, "outside.env");
  await writeFile(outsideFile, OUTSIDE_TEXT);
  return {
    projectRoot,
    projectDir,
    envFile: resolve(projectDir, PROJECT_ENV_FILENAME),
    outsideFile,
  };
}

function expectClosedRefusal(error: unknown, paths: readonly string[]): void {
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error ? error.message : "").toBe(
    PRIVATE_ENV_FILE_REFUSAL
  );
  for (const privateText of [
    SENTINEL_KEY,
    SENTINEL_VALUE,
    "OUTSIDE_SENTINEL",
    ...paths,
  ]) {
    expect(String(error)).not.toContain(privateText);
  }
}

/**
 * Starts `run` and settles it to its rejection (or null). Taking a thunk rather
 * than a promise keeps every operation started inside the await that observes
 * it: a promise started earlier can reject while the test awaits something
 * else, which Bun reports as an unhandled rejection (HACK-1292).
 */
async function caught(run: () => Promise<unknown>): Promise<unknown> {
  return await run().then(
    () => null,
    (error: unknown) => error
  );
}

async function stagingLeftovers(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
}

test("upsertDotEnvValue creates .hack/.env with mode 0600", async () => {
  const project = await createProject();
  const result = await upsertDotEnvValue({
    envFile: project.envFile,
    key: SENTINEL_KEY,
    value: SENTINEL_VALUE,
  });
  expect(result.changed).toBe(true);
  expect((await stat(project.envFile)).mode & 0o777).toBe(0o600);
  expect(await readFile(project.envFile, "utf8")).toContain(
    `${SENTINEL_KEY}=${SENTINEL_VALUE}`
  );
  expect(await stagingLeftovers(project.projectDir)).toEqual([]);
});

test("upsertDotEnvValue replaces .hack/.env atomically rather than writing in place", async () => {
  const project = await createProject();
  await upsertDotEnvValue({
    envFile: project.envFile,
    key: SENTINEL_KEY,
    value: "first",
  });
  // A second name for the old inode keeps the old bytes only if the writer
  // renamed a new file over the path instead of truncating and rewriting it.
  const previousName = resolve(project.projectDir, "previous-inode");
  await link(project.envFile, previousName);
  const before = await stat(project.envFile);

  await upsertDotEnvValue({
    envFile: project.envFile,
    key: SENTINEL_KEY,
    value: "second",
  });

  const after = await stat(project.envFile);
  expect(after.ino).not.toBe(before.ino);
  expect(after.mode & 0o777).toBe(0o600);
  expect(await readFile(previousName, "utf8")).toContain(
    `${SENTINEL_KEY}=first`
  );
  expect(await readFile(project.envFile, "utf8")).toContain(
    `${SENTINEL_KEY}=second`
  );
  expect(await stagingLeftovers(project.projectDir)).toEqual([]);
});

test("an unchanged .hack/.env with group or other bits is tightened to 0600", async () => {
  const project = await createProject();
  await upsertDotEnvValue({
    envFile: project.envFile,
    key: SENTINEL_KEY,
    value: SENTINEL_VALUE,
  });
  const text = await readFile(project.envFile, "utf8");
  await chmod(project.envFile, 0o644);

  const result = await upsertDotEnvValue({
    envFile: project.envFile,
    key: SENTINEL_KEY,
    value: SENTINEL_VALUE,
  });
  expect(result.changed).toBe(false);
  expect((await stat(project.envFile)).mode & 0o777).toBe(0o600);
  expect(await readFile(project.envFile, "utf8")).toBe(text);
});

test("removeDotEnvKey keeps mode 0600 on the rewritten file", async () => {
  const project = await createProject();
  await upsertDotEnvValue({
    envFile: project.envFile,
    key: SENTINEL_KEY,
    value: SENTINEL_VALUE,
  });
  await upsertDotEnvValue({
    envFile: project.envFile,
    key: "KEEP",
    value: "1",
  });
  const result = await removeDotEnvKey({
    envFile: project.envFile,
    key: SENTINEL_KEY,
  });
  expect(result.changed).toBe(true);
  expect((await stat(project.envFile)).mode & 0o777).toBe(0o600);
  expect(await readFile(project.envFile, "utf8")).toBe("KEEP=1\n");
});

test("negative control: a symlinked .hack/.env is refused without reading or writing its target", async () => {
  const project = await createProject();
  await symlink(project.outsideFile, project.envFile);

  // Each attempt starts only inside the caught() that awaits it, so the two
  // refusals cannot race each other.
  for (const attempt of [
    () =>
      upsertDotEnvValue({
        envFile: project.envFile,
        key: SENTINEL_KEY,
        value: SENTINEL_VALUE,
      }),
    () =>
      removeDotEnvKey({ envFile: project.envFile, key: "OUTSIDE_SENTINEL" }),
  ]) {
    expectClosedRefusal(await caught(attempt), [
      project.envFile,
      project.outsideFile,
    ]);
  }

  expect(await readFile(project.outsideFile, "utf8")).toBe(OUTSIDE_TEXT);
  expect((await lstat(project.envFile)).isSymbolicLink()).toBe(true);
  expect(await stagingLeftovers(project.projectDir)).toEqual([]);
});

test("negative control: a dangling .hack/.env symlink is refused and its target is never created", async () => {
  const project = await createProject();
  const missingTarget = resolve(project.projectRoot, "..", "never-created.env");
  await symlink(missingTarget, project.envFile);

  expectClosedRefusal(
    await caught(() =>
      upsertDotEnvValue({
        envFile: project.envFile,
        key: SENTINEL_KEY,
        value: SENTINEL_VALUE,
      })
    ),
    [project.envFile, missingTarget]
  );
  await expect(lstat(missingTarget)).rejects.toThrow();
  expect(await stagingLeftovers(project.projectDir)).toEqual([]);
});

test("negative control: an env overlay file that is a symlink is refused", async () => {
  const project = await createProject();
  const overlayFile = `${project.envFile}.staging`;
  await symlink(project.outsideFile, overlayFile);

  expectClosedRefusal(
    await caught(() =>
      upsertDotEnvValue({
        envFile: overlayFile,
        key: SENTINEL_KEY,
        value: SENTINEL_VALUE,
      })
    ),
    [overlayFile, project.outsideFile, "staging"]
  );
  expect(await readFile(project.outsideFile, "utf8")).toBe(OUTSIDE_TEXT);
});

test("negative control: a symlinked .hack directory is refused and the linked directory is untouched", async () => {
  if (!root) {
    throw new Error("Missing temp root");
  }
  const outsideDir = resolve(root, "outside-hack");
  await mkdir(outsideDir);
  const projectRoot = resolve(root, "linked-repo");
  await mkdir(projectRoot);
  const projectDir = resolve(projectRoot, ".hack");
  await symlink(outsideDir, projectDir);
  const envFile = resolve(projectDir, PROJECT_ENV_FILENAME);

  expectClosedRefusal(
    await caught(() =>
      upsertDotEnvValue({ envFile, key: SENTINEL_KEY, value: SENTINEL_VALUE })
    ),
    [envFile, outsideDir]
  );
  expect(await readdir(outsideDir)).toEqual([]);
});

test("a directory at the .hack/.env path is refused with the same closed diagnostic", async () => {
  const project = await createProject();
  await mkdir(project.envFile);
  expectClosedRefusal(
    await caught(() =>
      upsertDotEnvValue({
        envFile: project.envFile,
        key: SENTINEL_KEY,
        value: SENTINEL_VALUE,
      })
    ),
    [project.envFile]
  );
});

test("materializeProjectEnv writes .hack/.env with mode 0600 by atomic replace", async () => {
  const project = await createProject();
  await setProjectEnvValue({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    envName: null,
    scope: "global",
    key: SENTINEL_KEY,
    value: SENTINEL_VALUE,
    secret: false,
  });
  await writeFile(project.envFile, "STALE=1\n", { mode: 0o644 });
  await chmod(project.envFile, 0o644);
  const previousName = resolve(project.projectDir, "previous-inode");
  await link(project.envFile, previousName);

  const result = await materializeProjectEnv({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    envName: null,
    serviceName: null,
    serviceNames: ["api"],
  });

  expect(result.changed).toBe(true);
  expect((await stat(project.envFile)).mode & 0o777).toBe(0o600);
  expect(await readFile(project.envFile, "utf8")).toContain(
    `${SENTINEL_KEY}=${SENTINEL_VALUE}`
  );
  expect(await readFile(previousName, "utf8")).toBe("STALE=1\n");
  expect(await stagingLeftovers(project.projectDir)).toEqual([]);
});

test("negative control: materializeProjectEnv refuses a symlinked .hack/.env target", async () => {
  const project = await createProject();
  await setProjectEnvValue({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    envName: null,
    scope: "global",
    key: SENTINEL_KEY,
    value: SENTINEL_VALUE,
    secret: false,
  });
  await symlink(project.outsideFile, project.envFile);

  expectClosedRefusal(
    await caught(() =>
      materializeProjectEnv({
        projectRoot: project.projectRoot,
        projectDir: project.projectDir,
        envName: null,
        serviceName: null,
        serviceNames: ["api"],
      })
    ),
    [project.envFile, project.outsideFile]
  );
  expect(await readFile(project.outsideFile, "utf8")).toBe(OUTSIDE_TEXT);
  expect((await lstat(project.envFile)).isSymbolicLink()).toBe(true);
});

test("negative control: replacePrivateFileAtomic itself refuses a symlinked target without the read guard", async () => {
  const project = await createProject();
  const danglingTarget = resolve(
    project.projectRoot,
    "..",
    "never-created.env"
  );
  const danglingLink = `${project.envFile}.dangling`;
  await symlink(project.outsideFile, project.envFile);
  await symlink(danglingTarget, danglingLink);

  // Called directly, so the earlier O_NOFOLLOW read in the env-file callers
  // cannot mask a missing check in the replace step.
  for (const path of [project.envFile, danglingLink]) {
    expectClosedRefusal(
      await caught(() =>
        replacePrivateFileAtomic({
          path,
          directories: [project.projectDir],
          text: `${SENTINEL_KEY}=${SENTINEL_VALUE}\n`,
          refusal: () => new Error(PRIVATE_ENV_FILE_REFUSAL),
        })
      ),
      [path, project.outsideFile, danglingTarget]
    );
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  }
  expect(await readFile(project.outsideFile, "utf8")).toBe(OUTSIDE_TEXT);
  await expect(lstat(danglingTarget)).rejects.toThrow();
  expect(await stagingLeftovers(project.projectDir)).toEqual([]);
});

/**
 * HACK-1422: env files are read without the layer lock (the preflight of
 * `upsertDotEnvValue`/`removeDotEnvKey`, and every resolver). A concurrent
 * writer's atomic rename landing between the reader's `lstat` and its
 * no-follow `open` used to fail the reader with the symlink refusal. `open` is
 * intercepted so the replacement lands exactly in that window.
 */
function replaceOnOpen(opts: {
  readonly envFile: string;
  readonly replace: (call: number) => Promise<void>;
}): { readonly calls: () => number; readonly restore: () => void } {
  const originalOpen = privateFiles.open;
  let calls = 0;
  const intercept = spyOn(privateFiles, "open").mockImplementation(
    async (...args) => {
      if (args[0] === opts.envFile) {
        calls += 1;
        await opts.replace(calls);
      }
      return await Reflect.apply(originalOpen, privateFiles, args);
    }
  );
  return { calls: () => calls, restore: () => intercept.mockRestore() };
}

/** Renames a complete sibling over `path`, as `replacePrivateFileAtomic` does. */
async function renameOver(path: string, text: string): Promise<void> {
  const sibling = `${path}.${randomUUID()}.racing`;
  await writeFile(sibling, text, { mode: 0o600 });
  await privateFiles.rename(sibling, path);
}

test("a set whose unlocked read races another writer's atomic replace keeps both keys (HACK-1422)", async () => {
  const project = await createProject();
  await writeFile(project.envFile, "PRESET=1\n", { mode: 0o600 });
  const racing = replaceOnOpen({
    envFile: project.envFile,
    replace: async (call) => {
      if (call === 1) {
        await renameOver(project.envFile, "OTHER=2\nPRESET=1\n");
      }
    },
  });
  try {
    const result = await upsertDotEnvValue({
      envFile: project.envFile,
      key: SENTINEL_KEY,
      value: SENTINEL_VALUE,
    });
    expect(result.changed).toBe(true);
  } finally {
    racing.restore();
  }
  expect(racing.calls()).toBeGreaterThan(1);
  expect(await readFile(project.envFile, "utf8")).toBe(
    `OTHER=2\nPRESET=1\n${SENTINEL_KEY}=${SENTINEL_VALUE}\n`
  );
  expect((await stat(project.envFile)).mode & 0o777).toBe(0o600);
});

test("negative control: an env file replaced on every read attempt is refused closed after the bounded retries", async () => {
  const project = await createProject();
  await writeFile(project.envFile, `${SENTINEL_KEY}=${SENTINEL_VALUE}\n`, {
    mode: 0o600,
  });
  const racing = replaceOnOpen({
    envFile: project.envFile,
    replace: async (call) => {
      await renameOver(
        project.envFile,
        `${SENTINEL_KEY}=${SENTINEL_VALUE}\nCHURN=${call}\n`
      );
    },
  });
  let error: unknown;
  try {
    error = await caught(() =>
      removeDotEnvKey({ envFile: project.envFile, key: SENTINEL_KEY })
    );
  } finally {
    racing.restore();
  }
  expectClosedRefusal(error, [project.envFile]);
  expect(racing.calls()).toBe(REPLACEABLE_READ_ATTEMPTS);
  expect(await readFile(project.envFile, "utf8")).toBe(
    `${SENTINEL_KEY}=${SENTINEL_VALUE}\nCHURN=${REPLACEABLE_READ_ATTEMPTS}\n`
  );
  expect(await readdir(project.projectDir)).not.toContain(".internal");
});

test("negative control: a symlink swapped in between the read's lstat and open is still refused at once", async () => {
  const project = await createProject();
  await writeFile(project.envFile, "PRESET=1\n", { mode: 0o600 });
  const racing = replaceOnOpen({
    envFile: project.envFile,
    replace: async (call) => {
      if (call === 1) {
        const swapped = `${project.envFile}.swapped`;
        await symlink(project.outsideFile, swapped);
        await privateFiles.rename(swapped, project.envFile);
      }
    },
  });
  let error: unknown;
  try {
    error = await caught(() =>
      upsertDotEnvValue({
        envFile: project.envFile,
        key: SENTINEL_KEY,
        value: SENTINEL_VALUE,
      })
    );
  } finally {
    racing.restore();
  }
  expectClosedRefusal(error, [project.envFile, project.outsideFile]);
  expect(racing.calls()).toBe(1);
  expect(await readFile(project.outsideFile, "utf8")).toBe(OUTSIDE_TEXT);
  expect((await lstat(project.envFile)).isSymbolicLink()).toBe(true);
});
