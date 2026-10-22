import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
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
  AtomicWriteConflictError,
  writeTextFileAtomicIfChanged,
} from "../src/lib/fs.ts";
import {
  ensureHackDirGitignore,
  HACK_DIR_GITIGNORE_READ_ONLY_WARNING,
  hydrateProjectEnvLocalLayer,
  ProjectEnvHydrationRefusalError,
  type ProjectEnvHydrationRefusalReason,
  resolveProjectEnvConfig,
  resolveProjectEnvConfigPath,
  resolveProjectEnvLocalConfigPath,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { logger } from "../src/ui/logger.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1158: `hack env hydrate` writes many values into the machine-local env
 * layer in one commit. Repeats are byte-identical, changed values rotate with
 * a fresh IV, other local entries survive, and a wrong key, an interrupted
 * write or a concurrent writer leaves the previous layer in place. Every value
 * here is a synthetic test string; every child gets a private HOME.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const WORKER = resolve(
  import.meta.dir,
  "fixtures/project-env-hydrate-worker.ts"
);
const TOKEN = "synthetic-token-3b9e";
const PASSWORD = "synthetic-password-c51a";
const CHANGED = "synthetic-changed-80f2";
const CANARIES = [TOKEN, PASSWORD, CHANGED] as const;

/**
 * Synthetic key material, assembled at runtime so that no key-shaped literal
 * sits in source for secret scanners to flag.
 */
function syntheticKeyMaterial(label: string): string {
  return ["synthetic", label, "key", "material", "0123456789"].join("-");
}

/** Runs `run` with `HACK_ENV_SECRET_KEY` set, restoring the previous value. */
async function withEnvironmentKey<T>(
  keyText: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = process.env.HACK_ENV_SECRET_KEY;
  process.env.HACK_ENV_SECRET_KEY = keyText;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
    } else {
      process.env.HACK_ENV_SECRET_KEY = previous;
    }
  }
}

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
  readonly trackedFile: string;
  readonly localFile: string;
};

async function createRepo(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "hack-env-hydrate-"));
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
    `${JSON.stringify({ name: "env-hydrate", dev_host: "env-hydrate.hack" }, null, 2)}\n`
  );
  await writeFile(
    resolve(projectRoot, ".gitignore"),
    `${PROJECT_ENV_KEY_FILENAME}\n`
  );
  return {
    root,
    projectRoot,
    projectDir,
    trackedFile: resolveProjectEnvConfigPath({ projectDir, envName: null }),
    localFile: resolveProjectEnvLocalConfigPath({ projectDir, envName: null }),
  };
}

async function hydrate(
  repo: Repo,
  entries: Record<string, string>,
  secret = true,
  envName: string | null = null
) {
  return await hydrateProjectEnvLocalLayer({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName,
    scope: "global",
    entries: new Map(Object.entries(entries)),
    secret,
  });
}

async function refusalOf(
  run: () => Promise<unknown>
): Promise<ProjectEnvHydrationRefusalReason> {
  try {
    await run();
  } catch (error: unknown) {
    if (!(error instanceof ProjectEnvHydrationRefusalError)) {
      throw error;
    }
    for (const canary of CANARIES) {
      expect(error.message).not.toContain(canary);
    }
    expect(error.message).toContain("No env layer was changed.");
    return error.reason;
  }
  throw new Error("Expected a hydration refusal");
}

async function resolvedGlobal(repo: Repo): Promise<Record<string, string>> {
  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api"],
  });
  return { ...(resolved?.globalEnv ?? {}) };
}

type LayerValues = Record<string, Record<string, unknown>>;

function layerValues(text: string): LayerValues {
  const parsed: unknown = YAML.parse(text);
  return (parsed as { values: LayerValues }).values;
}

function ciphertextOf(text: string, key: string): string {
  const entry = layerValues(text).global?.[key] as
    | { secure?: unknown }
    | undefined;
  if (typeof entry?.secure !== "string") {
    throw new Error("Expected a stored secure value");
  }
  return entry.secure;
}

/** v1 values are `v1:<iv>:<tag>:<ciphertext>`. */
function ivSegment(ciphertext: string): string {
  return ciphertext.split(":")[1] ?? "";
}

async function stagingFiles(repo: Repo): Promise<string[]> {
  return (await readdir(repo.projectDir)).filter((name) =>
    name.endsWith(".tmp")
  );
}

function lockPath(repo: Repo): string {
  return resolve(repo.projectDir, ".internal", "env-hydrate.lock");
}

async function lockExists(repo: Repo): Promise<boolean> {
  return await Bun.file(lockPath(repo)).exists();
}

async function git(repo: Repo, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repo.projectRoot,
    env: privateCliEnv({
      root: repo.root,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
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

/** A git repo with a committed tracked default and the managed ignore file. */
async function createTrackedRepo(): Promise<Repo> {
  const repo = await createRepo();
  await git(repo, ["init", "-q", "-b", "main"]);
  await ensureHackDirGitignore({ projectDir: repo.projectDir });
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "TRACKED_DEFAULT",
    value: "tracked-default",
    secret: false,
  });
  await commitAll(repo);
  return repo;
}

test("hydration keeps a read-only outdated .hack/.gitignore and warns instead of failing (HACK-1363)", async () => {
  const repo = await createRepo();
  await git(repo, ["init", "-q", "-b", "main"]);
  const gitignore = resolve(repo.projectDir, ".gitignore");
  await writeFile(gitignore, "my-own-entry\n");
  await chmod(gitignore, 0o444);
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    const result = await hydrate(repo, { PUBLIC_FLAG: "on" }, false);
    expect(result).toMatchObject({ changed: true, added: ["PUBLIC_FLAG"] });
    expect(await readFile(repo.localFile, "utf8")).toContain("PUBLIC_FLAG");
    expect(await readFile(gitignore, "utf8")).toBe("my-own-entry\n");
    expect((await lstat(gitignore)).mode & 0o777).toBe(0o444);
    expect(warn.mock.calls).toEqual([
      [{ message: HACK_DIR_GITIGNORE_READ_ONLY_WARNING }],
    ]);
    expect(await stagingFiles(repo)).toEqual([]);
  } finally {
    warn.mockRestore();
    await chmod(gitignore, 0o644);
  }
});

test("a repeated import leaves the local layer and the tracked tree byte-identical", async () => {
  const repo = await createTrackedRepo();
  const tracked = await readFile(repo.trackedFile);

  const first = await hydrate(repo, { API_TOKEN: TOKEN, DB_PASS: PASSWORD });
  expect(first).toMatchObject({
    changed: true,
    createdKey: true,
    added: ["API_TOKEN", "DB_PASS"],
    updated: [],
    unchanged: [],
  });
  const hydrated = await readFile(repo.localFile);
  expect(hydrated.toString("utf8")).not.toContain(TOKEN);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const repeat = await hydrate(repo, { DB_PASS: PASSWORD, API_TOKEN: TOKEN });
    expect(repeat).toMatchObject({
      changed: false,
      createdKey: false,
      added: [],
      updated: [],
      unchanged: ["API_TOKEN", "DB_PASS"],
    });
  }
  expect((await readFile(repo.localFile)).equals(hydrated)).toBe(true);
  expect((await readFile(repo.trackedFile)).equals(tracked)).toBe(true);
  expect(await git(repo, ["status", "--porcelain"])).toBe("");
  expect(await resolvedGlobal(repo)).toMatchObject({
    TRACKED_DEFAULT: "tracked-default",
    API_TOKEN: TOKEN,
    DB_PASS: PASSWORD,
  });
  expect(await lockExists(repo)).toBe(false);
}, 30_000);

test("a changed value gets a fresh IV while unchanged entries keep their ciphertext", async () => {
  const repo = await createRepo();
  await hydrate(repo, { API_TOKEN: TOKEN, DB_PASS: PASSWORD });
  const before = await readFile(repo.localFile, "utf8");

  const result = await hydrate(repo, { API_TOKEN: CHANGED, DB_PASS: PASSWORD });
  expect(result).toMatchObject({
    changed: true,
    added: [],
    updated: ["API_TOKEN"],
    unchanged: ["DB_PASS"],
  });
  const after = await readFile(repo.localFile, "utf8");
  expect(ciphertextOf(after, "API_TOKEN")).not.toBe(
    ciphertextOf(before, "API_TOKEN")
  );
  expect(ivSegment(ciphertextOf(after, "API_TOKEN"))).not.toBe(
    ivSegment(ciphertextOf(before, "API_TOKEN"))
  );
  expect(ciphertextOf(after, "DB_PASS")).toBe(ciphertextOf(before, "DB_PASS"));
  expect(await resolvedGlobal(repo)).toMatchObject({
    API_TOKEN: CHANGED,
    DB_PASS: PASSWORD,
  });
});

test("other local entries, scopes, removal markers and scalar types survive", async () => {
  const repo = await createTrackedRepo();
  const tracked = await readFile(repo.trackedFile);
  await writeFile(
    repo.localFile,
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    # operator note: hand-edited",
      "    OPERATOR_OVERRIDE: operator-value",
      "    PORT: 3000",
      "    TRACKED_DEFAULT: null",
      "  api:",
      "    SCOPED: scoped-value",
      "",
    ].join("\n")
  );
  const handEdited = await readFile(repo.localFile);

  // An import that changes nothing does not rewrite (or reformat) the layer.
  const noop = await hydrate(
    repo,
    { OPERATOR_OVERRIDE: "operator-value", PORT: "3000" },
    false
  );
  expect(noop).toMatchObject({
    changed: false,
    unchanged: ["OPERATOR_OVERRIDE", "PORT"],
  });
  expect((await readFile(repo.localFile)).equals(handEdited)).toBe(true);

  const first = await hydrate(
    repo,
    { PORT: "3000", API_URL: "http://synthetic.test" },
    false
  );
  expect(first).toMatchObject({
    changed: true,
    added: ["API_URL"],
    unchanged: ["PORT"],
  });
  const text = await readFile(repo.localFile, "utf8");
  expect(layerValues(text)).toEqual({
    global: {
      OPERATOR_OVERRIDE: "operator-value",
      PORT: 3000,
      TRACKED_DEFAULT: null,
      API_URL: "http://synthetic.test",
    },
    api: { SCOPED: "scoped-value" },
  });
  expect((await readFile(repo.trackedFile)).equals(tracked)).toBe(true);

  const repeat = await hydrate(
    repo,
    { PORT: "3000", API_URL: "http://synthetic.test" },
    false
  );
  expect(repeat.changed).toBe(false);
  expect(await readFile(repo.localFile, "utf8")).toBe(text);
  const resolved = await resolvedGlobal(repo);
  expect(resolved.OPERATOR_OVERRIDE).toBe("operator-value");
  expect(resolved.TRACKED_DEFAULT).toBeUndefined();
  expect(await git(repo, ["status", "--porcelain"])).toBe("");
}, 30_000);

test("a secret that does not open under the current key refuses the whole import", async () => {
  const repo = await createRepo();
  await hydrate(repo, { API_TOKEN: TOKEN });
  const original = await readFile(repo.localFile);
  const keyFile = resolve(repo.projectRoot, PROJECT_ENV_KEY_FILENAME);
  // Synthetic replacement key: the stored entry cannot open under it.
  await writeFile(keyFile, "synthetic-replacement-key-material-0123456789\n");

  expect(await refusalOf(() => hydrate(repo, { DB_PASS: PASSWORD }))).toBe(
    "wrong_key"
  );
  expect(await refusalOf(() => hydrate(repo, { PLAIN: "plain" }, false))).toBe(
    "wrong_key"
  );
  await rm(keyFile);
  expect(await refusalOf(() => hydrate(repo, { DB_PASS: PASSWORD }))).toBe(
    "wrong_key"
  );
  // No replacement key was minted, nothing was staged and the lock is free.
  expect(await Bun.file(keyFile).exists()).toBe(false);
  expect((await readFile(repo.localFile)).equals(original)).toBe(true);
  expect(await stagingFiles(repo)).toEqual([]);
  expect(await lockExists(repo)).toBe(false);
});

test("secret hydration will not mint a key file that shadows HACK_ENV_SECRET_KEY", async () => {
  const repo = await createRepo();
  await withEnvironmentKey(syntheticKeyMaterial("environment"), async () => {
    expect(await refusalOf(() => hydrate(repo, { API_TOKEN: TOKEN }))).toBe(
      "key_env_only"
    );
  });
  expect(
    await Bun.file(resolve(repo.projectRoot, PROJECT_ENV_KEY_FILENAME)).exists()
  ).toBe(false);
  expect(await Bun.file(repo.localFile).exists()).toBe(false);
});

test("a git-tracked local layer is refused", async () => {
  const repo = await createTrackedRepo();
  const overlayLocal = resolveProjectEnvLocalConfigPath({
    projectDir: repo.projectDir,
    envName: "dev",
  });
  await writeFile(
    overlayLocal,
    "version: 1\nenvironment: dev\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  await git(repo, ["add", "-f", overlayLocal]);
  const original = await readFile(overlayLocal);

  expect(
    await refusalOf(() => hydrate(repo, { API_TOKEN: TOKEN }, true, "dev"))
  ).toBe("tracked_layer");
  expect((await readFile(overlayLocal)).equals(original)).toBe(true);
  // Positive control: the untracked base local layer still hydrates.
  expect((await hydrate(repo, { API_TOKEN: TOKEN })).changed).toBe(true);
}, 30_000);

test("a checkout where git cannot report tracking refuses instead of writing", async () => {
  const repo = await createTrackedRepo();
  await hydrate(repo, { API_TOKEN: TOKEN });
  const original = await readFile(repo.localFile);
  // A damaged index makes `git ls-files` exit 128, as a safe.directory
  // refusal does; that is not the same as "not a repository".
  await writeFile(resolve(repo.projectRoot, ".git", "index"), "not an index\n");

  expect(await refusalOf(() => hydrate(repo, { API_TOKEN: CHANGED }))).toBe(
    "tracking_unknown"
  );
  expect(
    await refusalOf(() => hydrate(repo, { PLAIN: "plain" }, false, "dev"))
  ).toBe("tracking_unknown");
  expect((await readFile(repo.localFile)).equals(original)).toBe(true);
  expect(
    await Bun.file(
      resolveProjectEnvLocalConfigPath({
        projectDir: repo.projectDir,
        envName: "dev",
      })
    ).exists()
  ).toBe(false);
  expect(await stagingFiles(repo)).toEqual([]);
  expect(await lockExists(repo)).toBe(false);
}, 30_000);

test("an existing local layer that is not a valid env file is refused, never replaced", async () => {
  const repo = await createRepo();
  const invalidLayers = [
    // Not YAML at all.
    `values: [unclosed\n  API_TOKEN: ${TOKEN}\n`,
    // Valid YAML, wrong shape: a scope that is not a mapping.
    "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: operator notes\n",
    // Valid YAML, wrong version.
    "version: 99\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n",
  ];
  for (const layer of invalidLayers) {
    await writeFile(repo.localFile, layer);
    for (const secret of [true, false]) {
      expect(
        await refusalOf(() => hydrate(repo, { API_TOKEN: TOKEN }, secret))
      ).toBe("unreadable_layer");
      expect(await readFile(repo.localFile, "utf8")).toBe(layer);
    }
  }
  expect(await stagingFiles(repo)).toEqual([]);
  expect(await lockExists(repo)).toBe(false);

  // Positive control: once the layer is removed, the same import succeeds.
  await rm(repo.localFile);
  expect((await hydrate(repo, { API_TOKEN: TOKEN })).changed).toBe(true);
});

test("existing secrets are checked with the key file before HACK_ENV_SECRET_KEY, as readers do", async () => {
  const repo = await createRepo();
  // Creates the key file; the stored secret is encrypted under it.
  await hydrate(repo, { API_TOKEN: TOKEN });

  await withEnvironmentKey(syntheticKeyMaterial("environment"), async () => {
    const plain = await hydrate(repo, { PLAIN: "plain" }, false);
    expect(plain).toMatchObject({ changed: true, added: ["PLAIN"] });
    const secret = await hydrate(repo, {
      API_TOKEN: CHANGED,
      DB_PASS: PASSWORD,
    });
    expect(secret).toMatchObject({
      changed: true,
      createdKey: false,
      added: ["DB_PASS"],
      updated: ["API_TOKEN"],
    });
    // Readers resolve with the same priority and open every entry.
    expect(await resolvedGlobal(repo)).toMatchObject({
      PLAIN: "plain",
      API_TOKEN: CHANGED,
      DB_PASS: PASSWORD,
    });
  });
});

test("a plain import never downgrades a stored secret to plaintext", async () => {
  const repo = await createRepo();
  await hydrate(repo, { API_TOKEN: TOKEN });
  const original = await readFile(repo.localFile);

  // Same value or a new one, alone or with other keys: all refused.
  const attempts: readonly Record<string, string>[] = [
    { API_TOKEN: TOKEN },
    { API_TOKEN: CHANGED },
    { OTHER: "plain", API_TOKEN: TOKEN },
  ];
  for (const entries of attempts) {
    expect(await refusalOf(() => hydrate(repo, entries, false))).toBe(
      "secret_downgrade"
    );
  }
  expect((await readFile(repo.localFile)).equals(original)).toBe(true);
  expect(await stagingFiles(repo)).toEqual([]);
  expect(await lockExists(repo)).toBe(false);

  // Positive controls: other plain keys, and a secret repeat, still work.
  expect((await hydrate(repo, { OTHER: "plain" }, false)).added).toEqual([
    "OTHER",
  ]);
  expect((await hydrate(repo, { API_TOKEN: TOKEN })).unchanged).toEqual([
    "API_TOKEN",
  ]);
  expect(
    ciphertextOf(await readFile(repo.localFile, "utf8"), "API_TOKEN")
  ).toBe(ciphertextOf(original.toString("utf8"), "API_TOKEN"));
});

test("a held lock refuses, and a lock from an exited process is reported as stale", async () => {
  const repo = await createRepo();
  await hydrate(repo, { API_TOKEN: TOKEN });
  const original = await readFile(repo.localFile);

  await writeFile(lockPath(repo), `${process.pid}\n`);
  expect(await refusalOf(() => hydrate(repo, { API_TOKEN: CHANGED }))).toBe(
    "locked"
  );
  // The refusal never removes a lock it does not own.
  expect(await lockExists(repo)).toBe(true);

  const exited = Bun.spawn(["true"], {
    env: privateCliEnv({ root: repo.root }),
  });
  await exited.exited;
  await writeFile(lockPath(repo), `${exited.pid}\n`);
  let message = "";
  try {
    await hydrate(repo, { API_TOKEN: CHANGED });
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : "";
  }
  expect(message).toContain(lockPath(repo));
  expect(await refusalOf(() => hydrate(repo, { API_TOKEN: CHANGED }))).toBe(
    "stale_lock"
  );
  expect((await readFile(repo.localFile)).equals(original)).toBe(true);

  await rm(lockPath(repo));
  expect((await hydrate(repo, { API_TOKEN: CHANGED })).changed).toBe(true);
});

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  marker: string
): Promise<string> {
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
  return seen;
}

function spawnWorker(repo: Repo, pauseAt: "rename" | "staging") {
  const worker = Bun.spawn(
    [process.execPath, WORKER, repo.projectRoot, repo.projectDir, pauseAt],
    {
      cwd: repo.projectRoot,
      env: privateCliEnv({ root: repo.root }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  worker.stdin.write(`API_TOKEN=${CHANGED}\nDB_PASS=${CHANGED}\n`);
  worker.stdin.end();
  return worker;
}

test("an import killed before its commit leaves every key at its previous value", async () => {
  const repo = await createTrackedRepo();
  await hydrate(repo, { API_TOKEN: TOKEN, DB_PASS: PASSWORD });
  const original = await readFile(repo.localFile);

  const worker = spawnWorker(repo, "rename");
  await readUntil(worker.stdout, "prepared\n");
  // The whole new layer is staged and fsynced, but not committed.
  expect((await readFile(repo.localFile)).equals(original)).toBe(true);
  // A second hydration while the first holds the lock refuses.
  expect(await refusalOf(() => hydrate(repo, { API_TOKEN: CHANGED }))).toBe(
    "locked"
  );
  worker.kill("SIGKILL");
  await worker.exited;

  // No key changed: the previous layer is intact and still resolves.
  expect((await readFile(repo.localFile)).equals(original)).toBe(true);
  expect(await resolvedGlobal(repo)).toMatchObject({
    API_TOKEN: TOKEN,
    DB_PASS: PASSWORD,
  });
  // The staging orphan and the stale lock are ignored, so the tree is clean.
  expect(await stagingFiles(repo)).toHaveLength(1);
  expect(await git(repo, ["status", "--porcelain"])).toBe("");
  // The killed process cannot release its lock; it is reported, not taken over.
  expect(await refusalOf(() => hydrate(repo, { API_TOKEN: CHANGED }))).toBe(
    "stale_lock"
  );
  await rm(lockPath(repo));
  const retried = await hydrate(repo, {
    API_TOKEN: CHANGED,
    DB_PASS: CHANGED,
  });
  expect(retried.updated).toEqual(["API_TOKEN", "DB_PASS"]);
  expect(await resolvedGlobal(repo)).toMatchObject({
    API_TOKEN: CHANGED,
    DB_PASS: CHANGED,
  });
}, 30_000);

test("a layer changed by another writer during an import is not overwritten", async () => {
  const repo = await createRepo();
  await hydrate(repo, { API_TOKEN: TOKEN });

  const worker = spawnWorker(repo, "staging");
  await readUntil(worker.stdout, "prepared\n");
  // A concurrent `hack env set --local` commits its own change meanwhile.
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "OPERATOR_OVERRIDE",
    value: "operator-value",
    secret: false,
    local: true,
  });
  const concurrent = await readFile(repo.localFile);
  await writeFile(resolve(repo.projectDir, "go"), "");

  const [stdout, exitCode] = await Promise.all([
    readUntil(worker.stdout, "\n"),
    worker.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).toBe("refused:concurrent_write\n");
  // The other writer's layer stands; no imported key was applied.
  expect((await readFile(repo.localFile)).equals(concurrent)).toBe(true);
  expect(await resolvedGlobal(repo)).toMatchObject({
    API_TOKEN: TOKEN,
    OPERATOR_OVERRIDE: "operator-value",
  });
  expect((await resolvedGlobal(repo)).DB_PASS).toBeUndefined();
  expect(await stagingFiles(repo)).toEqual([]);
  expect(await lockExists(repo)).toBe(false);
}, 30_000);

test("a compare-and-swap write refuses when the file no longer matches", async () => {
  const repo = await createRepo();
  const target = resolve(repo.projectDir, "cas.yaml");
  await writeFile(target, "current: 1\n");
  await expect(
    writeTextFileAtomicIfChanged(target, "next: 2\n", {
      expectedExisting: "stale: 0\n",
    })
  ).rejects.toBeInstanceOf(AtomicWriteConflictError);
  await expect(
    writeTextFileAtomicIfChanged(target, "next: 2\n", {
      expectedExisting: null,
    })
  ).rejects.toBeInstanceOf(AtomicWriteConflictError);
  expect(await readFile(target, "utf8")).toBe("current: 1\n");
  expect(await stagingFiles(repo)).toEqual([]);
  expect(
    await writeTextFileAtomicIfChanged(target, "next: 2\n", {
      expectedExisting: "current: 1\n",
    })
  ).toEqual({ changed: true });
});

async function runCli(
  repo: Repo,
  args: readonly string[],
  stdin: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
  for (const canary of CANARIES) {
    expect(stdout).not.toContain(canary);
    expect(stderr).not.toContain(canary);
  }
  return { exitCode, stdout, stderr };
}

test("`hack env hydrate` imports from stdin or a file and never prints values", async () => {
  const repo = await createTrackedRepo();
  const base = ["env", "hydrate", "--secret", "--path", repo.projectRoot];
  const input = `# synthetic\nAPI_TOKEN=${TOKEN}\nexport DB_PASS="${PASSWORD}"\n`;

  const first = await runCli(repo, [...base, "--json"], input);
  expect(first.exitCode).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({
    file: repo.localFile,
    local: true,
    scope: "global",
    changed: true,
    added: ["API_TOKEN", "DB_PASS"],
  });
  const hydrated = await readFile(repo.localFile);

  const repeat = await runCli(repo, [...base, "--json"], input);
  expect(JSON.parse(repeat.stdout)).toMatchObject({
    changed: false,
    unchanged: ["API_TOKEN", "DB_PASS"],
  });
  expect((await readFile(repo.localFile)).equals(hydrated)).toBe(true);
  expect(await git(repo, ["status", "--porcelain"])).toBe("");

  const file = join(repo.root, "entries.json");
  await writeFile(file, JSON.stringify({ API_TOKEN: CHANGED }));
  const fromFile = await runCli(
    repo,
    [...base, "--file", file, "--format", "json"],
    ""
  );
  expect(fromFile.exitCode).toBe(0);
  expect(fromFile.stdout + fromFile.stderr).toContain(
    "0 added, 1 updated, 0 unchanged"
  );
  expect(await resolvedGlobal(repo)).toMatchObject({
    API_TOKEN: CHANGED,
    DB_PASS: PASSWORD,
  });
}, 60_000);

test("`hack env hydrate` refuses values in argv and malformed input without echo", async () => {
  const repo = await createRepo();
  const base = ["env", "hydrate", "--path", repo.projectRoot];

  const argv = await runCli(repo, [...base, `API_TOKEN=${TOKEN}`], "");
  expect(argv.exitCode).not.toBe(0);
  expect(argv.stdout + argv.stderr).toContain("Unexpected arguments");

  const malformed = await runCli(
    repo,
    base,
    `API_TOKEN=${TOKEN}\n${PASSWORD}\n`
  );
  expect(malformed.exitCode).not.toBe(0);
  expect(malformed.stdout + malformed.stderr).toContain(
    "Hydration input line 2"
  );
  expect(await Bun.file(repo.localFile).exists()).toBe(false);
}, 60_000);
