import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  chown,
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
import { YAML } from "bun";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_KEY_FILENAME,
} from "../src/constants.ts";
import {
  AtomicWriteRefusedError,
  writeTextFileAtomicIfChanged,
} from "../src/lib/fs.ts";
import {
  ensureHackDirGitignore,
  resolveProjectEnvConfig,
  resolveProjectEnvConfigPath,
  resolveProjectEnvLocalConfigPath,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1152 (pattern HACK-P08): repeating an unchanged secret write keeps the
 * stored ciphertext, a changed value rotates it with a fresh IV, and an
 * interrupted write leaves the previous layer resolvable. Every value here is a
 * synthetic test string; every child gets a private HOME.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const WORKER = resolve(import.meta.dir, "fixtures/project-env-set-worker.ts");
const RENAME_FAILURE_WORKER = resolve(
  import.meta.dir,
  "fixtures/atomic-write-rename-failure-worker.ts"
);
const FOREIGN_OWNER_WORKER = resolve(
  import.meta.dir,
  "fixtures/atomic-write-foreign-owner-worker.ts"
);
const FIRST = "synthetic-first-6f1c";
const SECOND = "synthetic-second-92ad";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

type Repo = {
  readonly root: string;
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envFile: string;
};

async function createRepo(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "hack-env-stable-"));
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
    `${JSON.stringify({ name: "env-stable", dev_host: "env-stable.hack" }, null, 2)}\n`
  );
  await writeFile(
    resolve(projectRoot, ".gitignore"),
    `${PROJECT_ENV_KEY_FILENAME}\n`
  );
  return {
    root,
    projectRoot,
    projectDir,
    envFile: resolveProjectEnvConfigPath({ projectDir, envName: null }),
  };
}

type Layer = "tracked" | "local";

function layerPath(repo: Repo, layer: Layer): string {
  return layer === "local"
    ? resolveProjectEnvLocalConfigPath({
        projectDir: repo.projectDir,
        envName: null,
      })
    : repo.envFile;
}

async function setSecret(repo: Repo, value: string, layer: Layer = "tracked") {
  return await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "API_TOKEN",
    value,
    secret: true,
    local: layer === "local",
  });
}

async function resolvedToken(repo: Repo): Promise<string | undefined> {
  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api"],
  });
  return resolved?.globalEnv.API_TOKEN;
}

function storedCiphertext(text: string): string {
  const parsed: unknown = YAML.parse(text);
  const secure = (
    parsed as { values?: { global?: { API_TOKEN?: { secure?: unknown } } } }
  ).values?.global?.API_TOKEN?.secure;
  if (typeof secure !== "string") {
    throw new Error("Expected a stored secure value");
  }
  return secure;
}

/** v1 values are `v1:<iv>:<tag>:<ciphertext>`. */
function ivSegment(ciphertext: string): string {
  return ciphertext.split(":")[1] ?? "";
}

async function git(repo: Repo, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repo.projectRoot,
    env: fixtureGitEnv({
      env: privateCliEnv({
        root: repo.root,
        env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      }),
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ""} failed`);
  }
  return stdout;
}

async function commitAll(repo: Repo): Promise<void> {
  await git(repo, ["add", "-A"]);
  await git(repo, [
    "-c",
    "user.name=Hack Test",
    "-c",
    "user.email=hack@example.com",
    "commit",
    "-q",
    "-m",
    "fixture",
  ]);
}

test("repeating an unchanged secret keeps the tracked file byte-identical", async () => {
  const repo = await createRepo();
  await git(repo, ["init", "-q", "-b", "main"]);
  const first = await setSecret(repo, FIRST);
  expect(first.changed).toBe(true);
  expect(first.createdKey).toBe(true);
  await commitAll(repo);
  const committed = await readFile(repo.envFile);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const repeat = await setSecret(repo, FIRST);
    expect(repeat.changed).toBe(false);
    expect(repeat.createdKey).toBe(false);
  }
  expect((await readFile(repo.envFile)).equals(committed)).toBe(true);
  expect(await git(repo, ["status", "--porcelain"])).toBe("");
  expect(await resolvedToken(repo)).toBe(FIRST);
});

test("a changed secret rotates ciphertext with a fresh IV and resolves", async () => {
  const repo = await createRepo();
  await setSecret(repo, FIRST);
  const before = storedCiphertext(await readFile(repo.envFile, "utf8"));

  const changed = await setSecret(repo, SECOND);
  expect(changed.changed).toBe(true);
  const after = storedCiphertext(await readFile(repo.envFile, "utf8"));
  expect(after).not.toBe(before);
  expect(ivSegment(after)).not.toBe(ivSegment(before));
  expect(await resolvedToken(repo)).toBe(SECOND);

  // Returning to an earlier value is a change, not a reuse of old ciphertext.
  await setSecret(repo, FIRST);
  const reverted = storedCiphertext(await readFile(repo.envFile, "utf8"));
  expect(reverted).not.toBe(before);
  expect(reverted).not.toBe(after);
  expect(await resolvedToken(repo)).toBe(FIRST);
});

test("an entry that no longer opens under the current key is re-encrypted", async () => {
  const repo = await createRepo();
  await setSecret(repo, FIRST);
  const sealedUnderOldKey = storedCiphertext(
    await readFile(repo.envFile, "utf8")
  );
  // Synthetic replacement key: the stored entry cannot open under it.
  await writeFile(
    resolve(repo.projectRoot, PROJECT_ENV_KEY_FILENAME),
    "synthetic-replacement-key-material-0123456789\n"
  );

  const result = await setSecret(repo, FIRST);
  expect(result.changed).toBe(true);
  const rotated = storedCiphertext(await readFile(repo.envFile, "utf8"));
  expect(rotated).not.toBe(sealedUnderOldKey);
  expect(await resolvedToken(repo)).toBe(FIRST);
});

test("plain and secret forms of the same value are never treated as unchanged", async () => {
  const repo = await createRepo();
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "API_TOKEN",
    value: FIRST,
    secret: false,
  });
  const upgraded = await setSecret(repo, FIRST);
  expect(upgraded.changed).toBe(true);
  const text = await readFile(repo.envFile, "utf8");
  expect(text).not.toContain(FIRST);
  storedCiphertext(text);
  expect(await resolvedToken(repo)).toBe(FIRST);
});

test("a rewrite keeps the layer's permission bits", async () => {
  const repo = await createRepo();
  await setSecret(repo, FIRST);
  await chmod(repo.envFile, 0o640);
  await setSecret(repo, SECOND);
  expect((await stat(repo.envFile)).mode & 0o777).toBe(0o640);
});

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  marker: string
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  try {
    while (!seen.includes(marker)) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(`Worker exited before ${marker.trim()}`);
      }
      seen += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

test("a symlinked layer keeps its link and the write lands at the link target", async () => {
  const repo = await createRepo();
  const shared = resolve(repo.projectRoot, "shared");
  await mkdir(shared);
  const linkTarget = resolve(shared, "hack.env.default.yaml");
  await writeFile(
    linkTarget,
    "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  await symlink(linkTarget, repo.envFile);

  expect((await setSecret(repo, FIRST)).changed).toBe(true);
  expect((await lstat(repo.envFile)).isSymbolicLink()).toBe(true);
  storedCiphertext(await readFile(linkTarget, "utf8"));
  expect(await resolvedToken(repo)).toBe(FIRST);
  // Neither directory keeps a staging file after a committed write.
  for (const dir of [repo.projectDir, shared]) {
    expect(
      (await readdir(dir)).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
  }
});

test("an outside symlinked layer is refused without changing the target", async () => {
  const repo = await createRepo();
  const outside = resolve(repo.root, "outside.yaml");
  const original =
    "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n";
  await writeFile(outside, original);
  await symlink(outside, repo.envFile);
  await expect(setSecret(repo, FIRST)).rejects.toThrow("Refused env layer");
  expect(await readFile(outside, "utf8")).toBe(original);
  expect((await lstat(repo.envFile)).isSymbolicLink()).toBe(true);
  expect((await readdir(repo.root)).sort()).toEqual(["outside.yaml", "repo"]);
});

test("a write that fails after staging removes its staging file", async () => {
  const repo = await createRepo();
  const target = resolve(repo.projectDir, "occupied.yaml");
  await writeFile(target, "synthetic: before\n");

  const worker = Bun.spawn([process.execPath, RENAME_FAILURE_WORKER, target], {
    cwd: repo.projectRoot,
    env: privateCliEnv({ root: repo.root }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  worker.stdin.write("synthetic: after\n");
  await worker.stdin.end();
  const [stdout, exitCode] = await Promise.all([
    new Response(worker.stdout).text(),
    worker.exited,
  ]);
  expect({ stdout, exitCode }).toEqual({ stdout: "failed\n", exitCode: 0 });
  expect(await readFile(target, "utf8")).toBe("synthetic: before\n");
  expect(await tmpSiblings(repo.projectDir)).toEqual([]);
}, 30_000);

test("a directory at the target is refused before anything is staged", async () => {
  const repo = await createRepo();
  const target = resolve(repo.projectDir, "occupied.yaml");
  await mkdir(target);

  const refusal = await refusalOf(
    writeTextFileAtomicIfChanged(target, "synthetic: content\n")
  );
  expect(refusal.reason).toBe("not_regular_file");
  expect((await stat(target)).isDirectory()).toBe(true);
  expect(await tmpSiblings(repo.projectDir)).toEqual([]);
});

const RUNS_AS_ROOT =
  typeof process.getuid === "function" && process.getuid() === 0;

/** Synthetic layer holding a key the failed write must not drop. */
const OTHER_LAYER =
  "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    OTHER_SETTING: synthetic-other-31b7\n";

// Root bypasses permission bits, so these refusals only apply to other users.
test.skipIf(RUNS_AS_ROOT)(
  "an existing layer that cannot be read is refused, not replaced",
  async () => {
    const repo = await createRepo();
    await writeFile(repo.envFile, OTHER_LAYER);
    await chmod(repo.envFile, 0o000);
    try {
      const refusal = await refusalOf(setSecret(repo, FIRST));
      expect(refusal.reason).toBe("unreadable");
      expect(refusal.message).not.toContain(FIRST);
      expect(await tmpSiblings(repo.projectDir)).toEqual([]);
    } finally {
      await chmod(repo.envFile, 0o600);
    }
    expect(await readFile(repo.envFile, "utf8")).toBe(OTHER_LAYER);
  }
);

test.skipIf(RUNS_AS_ROOT)(
  "a readable layer that is not writable is refused, not replaced",
  async () => {
    const repo = await createRepo();
    await writeFile(repo.envFile, OTHER_LAYER);
    await chmod(repo.envFile, 0o444);
    const before = await stat(repo.envFile);

    const refusal = await refusalOf(setSecret(repo, FIRST));
    expect(refusal.reason).toBe("not_writable");
    expect(await readFile(repo.envFile, "utf8")).toBe(OTHER_LAYER);
    const after = await stat(repo.envFile);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o444);
    expect(await tmpSiblings(repo.projectDir)).toEqual([]);
  }
);

test("a rewrite keeps the layer's group", async () => {
  const repo = await createRepo();
  await setSecret(repo, FIRST);
  const current = (await stat(repo.envFile)).gid;
  // Any other group this process belongs to can be assigned without root.
  const other = (process.getgroups?.() ?? []).find((gid) => gid !== current);
  if (other === undefined) {
    return;
  }
  await chown(repo.envFile, (await stat(repo.envFile)).uid, other);

  expect((await setSecret(repo, SECOND)).changed).toBe(true);
  expect((await stat(repo.envFile)).gid).toBe(other);
  expect(await resolvedToken(repo)).toBe(SECOND);
});

// Root can chown to any user, so the refusal only applies to other users.
test.skipIf(RUNS_AS_ROOT)(
  "a layer whose owner cannot be kept is refused, not replaced",
  async () => {
    const repo = await createRepo();
    await writeFile(repo.envFile, OTHER_LAYER);
    const before = await stat(repo.envFile);

    const worker = Bun.spawn(
      [process.execPath, FOREIGN_OWNER_WORKER, repo.envFile],
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
      stdout: "refused:owner_not_preserved\n",
      exitCode: 0,
    });
    expect(await readFile(repo.envFile, "utf8")).toBe(OTHER_LAYER);
    expect((await stat(repo.envFile)).ino).toBe(before.ino);
    expect(await tmpSiblings(repo.projectDir)).toEqual([]);
  },
  30_000
);

test("an in-project dangling symlink layer is replaced by a regular file", async () => {
  const repo = await createRepo();
  await symlink(resolve(repo.projectRoot, "missing.yaml"), repo.envFile);

  expect((await setSecret(repo, FIRST)).changed).toBe(true);
  expect((await lstat(repo.envFile)).isFile()).toBe(true);
  expect(await resolvedToken(repo)).toBe(FIRST);
});

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

for (const layer of ["tracked", "local"] as const) {
  test(`a ${layer} write killed before its commit rename leaves the layer resolvable and git clean`, async () => {
    await assertKilledWriteIsRecoverable(layer);
  }, 30_000);
}

async function assertKilledWriteIsRecoverable(layer: Layer): Promise<void> {
  const repo = await createRepo();
  const layerFile = layerPath(repo, layer);
  await git(repo, ["init", "-q", "-b", "main"]);
  // `hack init` writes the managed `.hack/.gitignore`; `--local` writes heal it.
  await ensureHackDirGitignore({ projectDir: repo.projectDir });
  await setSecret(repo, FIRST, layer);
  await commitAll(repo);
  expect(await git(repo, ["status", "--porcelain"])).toBe("");
  const original = await readFile(layerFile);

  const worker = Bun.spawn(
    [process.execPath, WORKER, repo.projectRoot, repo.projectDir, layer],
    {
      cwd: repo.projectRoot,
      env: privateCliEnv({ root: repo.root }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  worker.stdin.write(SECOND);
  await worker.stdin.end();
  await readUntil(worker.stdout, "prepared\n");
  // The replacement is fully staged and fsynced, but not yet committed.
  expect((await readFile(layerFile)).equals(original)).toBe(true);
  worker.kill("SIGKILL");
  await worker.exited;

  const abandoned = (await readdir(repo.projectDir)).filter((name) =>
    name.endsWith(".tmp")
  );
  expect(abandoned).toHaveLength(1);
  const staged = await readFile(
    join(repo.projectDir, abandoned[0] ?? ""),
    "utf8"
  );
  expect(storedCiphertext(staged)).not.toBe(
    storedCiphertext(original.toString("utf8"))
  );

  // The old layer is intact and still resolves; the orphan is not a layer.
  expect((await readFile(layerFile)).equals(original)).toBe(true);
  expect(await resolvedToken(repo)).toBe(FIRST);
  // The orphan holds the whole layer, so it must be ignored: `git add -A`
  // would otherwise commit machine-local values, and the tree would be dirty.
  expect(await git(repo, ["status", "--porcelain"])).toBe("");
  await git(repo, ["add", "-A"]);
  expect(await git(repo, ["diff", "--cached", "--name-only"])).toBe("");

  // The next writer commits normally without adopting the orphan.
  const retried = await setSecret(repo, SECOND, layer);
  expect(retried.changed).toBe(true);
  expect(await resolvedToken(repo)).toBe(SECOND);
  expect(storedCiphertext(await readFile(layerFile, "utf8"))).not.toBe(
    storedCiphertext(staged)
  );
}

async function runCli(
  repo: Repo,
  args: readonly string[],
  stdin: string
): Promise<number> {
  const proc = Bun.spawn([process.execPath, ENTRYPOINT, ...args], {
    cwd: repo.projectRoot,
    env: privateCliEnv({
      root: repo.root,
      env: {
        HACK_GLOBAL_CONFIG_PATH: join(repo.root, "hack-config.json"),
        HACK_LOGGER: "console",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdin);
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stdout).not.toContain(FIRST);
  expect(stderr).not.toContain(FIRST);
  return exitCode;
}

test("repeat `env set --secret --value-stdin` leaves git status clean", async () => {
  const repo = await createRepo();
  await writeFile(
    repo.envFile,
    "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  await git(repo, ["init", "-q", "-b", "main"]);
  const setArgs = [
    "env",
    "set",
    "API_TOKEN",
    "--secret",
    "--value-stdin",
    "--path",
    repo.projectRoot,
  ];
  expect(await runCli(repo, setArgs, `${FIRST}\n`)).toBe(0);
  await commitAll(repo);
  const committed = await readFile(repo.envFile);

  expect(await runCli(repo, setArgs, `${FIRST}\n`)).toBe(0);
  expect((await readFile(repo.envFile)).equals(committed)).toBe(true);
  expect(await git(repo, ["status", "--porcelain"])).toBe("");

  // Positive control: a changed value does reach the tracked file.
  expect(await runCli(repo, setArgs, `${SECOND}\n`)).toBe(0);
  expect(await git(repo, ["status", "--porcelain"])).toBe(
    " M .hack/hack.env.default.yaml\n"
  );
}, 60_000);

test.skipIf(RUNS_AS_ROOT)(
  "`env set` on an unreadable layer fails and keeps the layer",
  async () => {
    const repo = await createRepo();
    await writeFile(repo.envFile, OTHER_LAYER);
    await chmod(repo.envFile, 0o000);
    let exitCode: number;
    try {
      exitCode = await runCli(
        repo,
        [
          "env",
          "set",
          "API_TOKEN",
          "--secret",
          "--value-stdin",
          "--path",
          repo.projectRoot,
        ],
        `${FIRST}\n`
      );
    } finally {
      await chmod(repo.envFile, 0o600);
    }
    expect(exitCode).not.toBe(0);
    expect(await readFile(repo.envFile, "utf8")).toBe(OTHER_LAYER);
    expect(await tmpSiblings(repo.projectDir)).toEqual([]);
  },
  60_000
);
