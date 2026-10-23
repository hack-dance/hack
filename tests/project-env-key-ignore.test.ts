import { afterEach, expect, test } from "bun:test";
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

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_KEY_FILENAME,
} from "../src/constants.ts";
import { resolveProjectEnvConfigPath } from "../src/lib/project-env-config.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1375: the checkout-local `.hack.secret.key` and its root `.gitignore`
 * entry are atomic in effect. When the entry cannot be written, no key is
 * created, so the retry the refusal suggests cannot succeed with a key git
 * would commit; and an existing key git does not ignore is repaired before a
 * `--secret` write uses it, or refused.
 *
 * Every child runs the source CLI with a private HOME, HACK_HOME and Docker
 * client config, keychain fallback disabled, and git's global and system
 * configuration out of reach. Each fixture writes the env layer first so
 * `--secret` uses the project key, never the keychain. Values are synthetic.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const FIRST_VALUE = ["synthetic", "first", "c41e"].join("-");
const NEXT_VALUE = ["synthetic", "next", "9b07"].join("-");
const LAYER =
  "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    PLAIN_SETTING: kept\n";
const BASE_GITIGNORE = "node_modules/\n";

/** Permission bits do not bind an effective uid of 0. */
const RUNS_AS_ROOT = (process.geteuid?.() ?? process.getuid?.() ?? -1) === 0;

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    const entries = await readdir(tempDir, {
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
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

type Repo = {
  readonly root: string;
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly layer: string;
  readonly keyPath: string;
  readonly gitignore: string;
};

function gitEnv(root: string): Record<string, string> {
  return privateCliEnv({
    root,
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

async function git(
  repo: Repo,
  args: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const proc = Bun.spawn(["git", "-C", repo.projectRoot, ...args], {
    env: gitEnv(repo.root),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { exitCode, stdout };
}

/** A project with its env layer and root `.gitignore`, in git unless `git: false`. */
async function createRepo(opts: { readonly git: boolean }): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "hack-env-key-ignore-"));
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
    `${JSON.stringify({ name: "env-key-ignore", dev_host: "env-key-ignore.hack" }, null, 2)}\n`
  );
  const layer = resolveProjectEnvConfigPath({ projectDir, envName: null });
  await writeFile(layer, LAYER);
  const gitignore = resolve(projectRoot, ".gitignore");
  await writeFile(gitignore, BASE_GITIGNORE);
  const repo: Repo = {
    root,
    projectRoot,
    projectDir,
    layer,
    keyPath: resolve(projectRoot, PROJECT_ENV_KEY_FILENAME),
    gitignore,
  };
  if (opts.git) {
    expect((await git(repo, ["init", "-q"])).exitCode).toBe(0);
  }
  return repo;
}

type CliRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runCli(opts: {
  readonly repo: Repo;
  readonly args: readonly string[];
  readonly stdin: string;
}): Promise<CliRun> {
  const proc = Bun.spawn(
    [
      process.execPath,
      ENTRYPOINT,
      ...opts.args,
      "--path",
      opts.repo.projectRoot,
    ],
    {
      cwd: opts.repo.projectRoot,
      env: privateCliEnv({
        root: opts.repo.root,
        env: {
          HACK_HOME: join(opts.repo.root, "hack-home"),
          HACK_GLOBAL_CONFIG_PATH: join(opts.repo.root, "hack-config.json"),
          HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
          HACK_LAUNCHD_DISABLE: "1",
          HACK_LOGGER: "console",
          HACK_NO_INTERACTIVE: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
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

async function setSecret(
  repo: Repo,
  key: string,
  value: string
): Promise<CliRun> {
  return await runCli({
    repo,
    args: ["env", "set", key, "--secret", "--value-stdin"],
    stdin: `${value}\n`,
  });
}

async function keyExists(repo: Repo): Promise<boolean> {
  return (await lstat(repo.keyPath).catch(() => null)) !== null;
}

/** Whether `git status` offers the key for commit. */
async function keyIsCommittable(repo: Repo): Promise<boolean> {
  const status = await git(repo, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  expect(status.exitCode).toBe(0);
  return status.stdout
    .split("\n")
    .some((line) => line.endsWith(` ${PROJECT_ENV_KEY_FILENAME}`));
}

function expectOneLineRefusal(run: CliRun, expected: string): void {
  expect(run.exitCode).toBe(1);
  const lines = `${run.stdout}\n${run.stderr}`
    .split("\n")
    .filter((line) => /[A-Za-z]/.test(line));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(expected);
  const output = `${run.stdout}${run.stderr}`;
  expect(output).not.toMatch(/\bat\s.*\.ts:\d+/);
  expect(output).not.toContain(FIRST_VALUE);
  expect(output).not.toContain(NEXT_VALUE);
}

function expectNoKeyMaterial(run: CliRun, keyText: string): void {
  expect(keyText.length).toBeGreaterThan(0);
  expect(`${run.stdout}${run.stderr}`).not.toContain(keyText);
}

function unignoredRefusal(repo: Repo): string {
  return `Refusing to use ${PROJECT_ENV_KEY_FILENAME}: git does not ignore it, so it could be committed, and Hack could not add it to ${repo.gitignore}.`;
}

/** Creates the key with a first secret, then drops its ignore entry (the pre-fix state). */
async function createUnignoredKey(repo: Repo): Promise<string> {
  const first = await setSecret(repo, "FIRST_SECRET", FIRST_VALUE);
  expect(first.exitCode).toBe(0);
  const keyText = (await readFile(repo.keyPath, "utf8")).trim();
  await writeFile(repo.gitignore, BASE_GITIGNORE);
  expect(await keyIsCommittable(repo)).toBe(true);
  return keyText;
}

test.skipIf(RUNS_AS_ROOT)(
  "a read-only root .gitignore refuses the first secret without creating the key, and the retry after fixing it ignores the key",
  async () => {
    const repo = await createRepo({ git: true });
    await chmod(repo.gitignore, 0o444);

    // The reported sequence: refuse, then retry as the refusal suggests.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const run = await setSecret(repo, "NEW_SECRET", NEXT_VALUE);
      expectOneLineRefusal(
        run,
        `E_PERMISSION: Could not write ${repo.gitignore}: permission denied. Make the file and its directory writable by your user, then retry.`
      );
      expect(await keyExists(repo)).toBe(false);
      expect(await readFile(repo.layer, "utf8")).toBe(LAYER);
    }
    expect(await keyIsCommittable(repo)).toBe(false);

    await chmod(repo.gitignore, 0o644);
    const retry = await setSecret(repo, "NEW_SECRET", NEXT_VALUE);
    expect(retry.exitCode).toBe(0);
    expect(await keyExists(repo)).toBe(true);
    expectNoKeyMaterial(retry, (await readFile(repo.keyPath, "utf8")).trim());
    expect(await readFile(repo.gitignore, "utf8")).toBe(
      `${BASE_GITIGNORE}\n# project env key\n${PROJECT_ENV_KEY_FILENAME}\n`
    );
    expect(await keyIsCommittable(repo)).toBe(false);
    expect(await readFile(repo.layer, "utf8")).toContain("NEW_SECRET");
  },
  60_000
);

test("an existing key git does not ignore is repaired by the next secret set", async () => {
  const repo = await createRepo({ git: true });
  const keyText = await createUnignoredKey(repo);

  const run = await setSecret(repo, "NEXT_SECRET", NEXT_VALUE);

  expect(run.exitCode).toBe(0);
  expectNoKeyMaterial(run, keyText);
  expect((await readFile(repo.keyPath, "utf8")).trim()).toBe(keyText);
  expect(await readFile(repo.gitignore, "utf8")).toContain(
    `\n${PROJECT_ENV_KEY_FILENAME}\n`
  );
  expect(await keyIsCommittable(repo)).toBe(false);
  expect(await readFile(repo.layer, "utf8")).toContain("NEXT_SECRET");
}, 60_000);

test("secret hydration repairs an existing key git does not ignore", async () => {
  const repo = await createRepo({ git: true });
  const keyText = await createUnignoredKey(repo);

  const run = await runCli({
    repo,
    args: ["env", "hydrate", "--secret"],
    stdin: `HYDRATED_SECRET=${NEXT_VALUE}\n`,
  });

  expect(run.exitCode).toBe(0);
  expectNoKeyMaterial(run, keyText);
  expect(await keyIsCommittable(repo)).toBe(false);
}, 60_000);

test.skipIf(RUNS_AS_ROOT)(
  "an existing unignored key with a read-only root .gitignore is refused before use",
  async () => {
    const repo = await createRepo({ git: true });
    const keyText = await createUnignoredKey(repo);
    const layerBefore = await readFile(repo.layer, "utf8");
    await chmod(repo.gitignore, 0o444);

    const run = await setSecret(repo, "NEXT_SECRET", NEXT_VALUE);

    expectOneLineRefusal(run, unignoredRefusal(repo));
    expectNoKeyMaterial(run, keyText);
    expect(await readFile(repo.layer, "utf8")).toBe(layerBefore);
    expect(await readFile(repo.gitignore, "utf8")).toBe(BASE_GITIGNORE);
    expect((await readFile(repo.keyPath, "utf8")).trim()).toBe(keyText);
  },
  60_000
);

test.skipIf(RUNS_AS_ROOT)(
  "negative control: a key ignored by another rule needs no root .gitignore write",
  async () => {
    const repo = await createRepo({ git: true });
    const keyText = await createUnignoredKey(repo);
    await writeFile(
      resolve(repo.projectRoot, ".git", "info", "exclude"),
      `${PROJECT_ENV_KEY_FILENAME}\n`
    );
    expect(await keyIsCommittable(repo)).toBe(false);
    await chmod(repo.gitignore, 0o444);

    const run = await setSecret(repo, "NEXT_SECRET", NEXT_VALUE);

    expect(run.exitCode).toBe(0);
    expectNoKeyMaterial(run, keyText);
    expect(await readFile(repo.gitignore, "utf8")).toBe(BASE_GITIGNORE);
  },
  60_000
);

test("a rule that re-includes the key is refused both before creating a key and before using one", async () => {
  const repo = await createRepo({ git: true });
  const reincluding = `${PROJECT_ENV_KEY_FILENAME}\n!${PROJECT_ENV_KEY_FILENAME}\n`;
  await writeFile(repo.gitignore, reincluding);

  const first = await setSecret(repo, "NEW_SECRET", NEXT_VALUE);
  expectOneLineRefusal(first, unignoredRefusal(repo));
  expect(await keyExists(repo)).toBe(false);
  expect(await readFile(repo.layer, "utf8")).toBe(LAYER);

  // An existing key under the same rule is refused before it encrypts.
  await writeFile(repo.gitignore, BASE_GITIGNORE);
  const keyText = await createUnignoredKey(repo);
  await writeFile(repo.gitignore, reincluding);
  const layerBefore = await readFile(repo.layer, "utf8");
  const next = await setSecret(repo, "NEXT_SECRET", NEXT_VALUE);
  expectOneLineRefusal(next, unignoredRefusal(repo));
  expectNoKeyMaterial(next, keyText);
  expect(await readFile(repo.layer, "utf8")).toBe(layerBefore);
}, 60_000);

test("outside git an existing key is used without writing a root .gitignore", async () => {
  const repo = await createRepo({ git: false });
  const first = await setSecret(repo, "FIRST_SECRET", FIRST_VALUE);
  expect(first.exitCode).toBe(0);
  // A new key still gets its entry, so a later `git init` ignores it.
  expect(await readFile(repo.gitignore, "utf8")).toContain(
    `\n${PROJECT_ENV_KEY_FILENAME}\n`
  );
  await rm(repo.gitignore);

  const run = await setSecret(repo, "NEXT_SECRET", NEXT_VALUE);

  expect(run.exitCode).toBe(0);
  expect(await lstat(repo.gitignore).catch(() => null)).toBeNull();
}, 60_000);
