import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
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
  resolveProjectEnvConfig,
  resolveProjectEnvConfigPath,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
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

async function setSecret(repo: Repo, value: string) {
  return await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "API_TOKEN",
    value,
    secret: true,
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

test("a write killed before its commit rename leaves the previous layer resolvable", async () => {
  const repo = await createRepo();
  await setSecret(repo, FIRST);
  const original = await readFile(repo.envFile);

  const worker = Bun.spawn(
    [process.execPath, WORKER, repo.projectRoot, repo.projectDir],
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
  expect((await readFile(repo.envFile)).equals(original)).toBe(true);
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
  expect((await readFile(repo.envFile)).equals(original)).toBe(true);
  expect(await resolvedToken(repo)).toBe(FIRST);

  // The next writer commits normally without adopting the orphan.
  const retried = await setSecret(repo, SECOND);
  expect(retried.changed).toBe(true);
  expect(await resolvedToken(repo)).toBe(SECOND);
  expect(storedCiphertext(await readFile(repo.envFile, "utf8"))).not.toBe(
    storedCiphertext(staged)
  );
}, 30_000);

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
