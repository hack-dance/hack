import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
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
  PROJECT_ENV_KEY_FILENAME,
} from "../src/constants.ts";
import { createPrivateFileExclusive } from "../src/lib/private-file.ts";
import {
  ensureProjectEnvSecretKey,
  ProjectEnvKeyRefusalError,
  resolveProjectEnvConfig,
  resolveProjectEnvSharedKeyLocation,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";

const tempDirs = new Set<string>();
const restorePermissions: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const restore of restorePermissions.splice(0)) {
    await restore();
  }
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
});

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `git ${args.join(" ")} failed`);
  }
  return stdout.trim();
}

async function createWorktreeFixture(): Promise<{
  readonly sandbox: string;
  readonly primaryRoot: string;
  readonly linkedRoot: string;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), "hack-worktree-key-"));
  tempDirs.add(sandbox);

  const primaryRoot = resolve(sandbox, "primary");
  await mkdir(resolve(primaryRoot, ".hack"), { recursive: true });
  await writeFile(
    resolve(primaryRoot, ".hack", PROJECT_COMPOSE_FILENAME),
    "services:\n  api: {}\n"
  );
  await writeFile(
    resolve(primaryRoot, ".hack", PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      { name: "worktree-key-test", dev_host: "worktree-key.hack" },
      null,
      2
    )}\n`
  );
  await writeFile(resolve(primaryRoot, "README.md"), "# fixture\n");
  await runGit(["init", "-b", "main"], primaryRoot);
  await runGit(["config", "user.name", "Hack Test"], primaryRoot);
  await runGit(["config", "user.email", "hack@example.com"], primaryRoot);
  await runGit(["add", "."], primaryRoot);
  await runGit(["commit", "-m", "init"], primaryRoot);

  const linkedRoot = resolve(sandbox, "linked");
  await runGit(
    ["worktree", "add", "-b", "feature/key-flow", linkedRoot],
    primaryRoot
  );

  return { sandbox, primaryRoot, linkedRoot };
}

test("ensure from a linked worktree writes a new key to the shared location", async () => {
  const fixture = await createWorktreeFixture();

  const ensured = await ensureProjectEnvSecretKey({
    projectRoot: fixture.linkedRoot,
  });
  expect(ensured.created).toBe(true);
  expect(ensured.warnings).toEqual([]);

  const location = await resolveProjectEnvSharedKeyLocation({
    projectRoot: fixture.linkedRoot,
  });
  expect(location).not.toBeNull();
  expect(location?.linkedWorktree).toBe(true);
  expect(ensured.keyPath).toBe(location?.path ?? "");

  const info = await stat(ensured.keyPath);
  expect(info.mode & 0o777).toBe(0o600);

  expect(
    await Bun.file(
      resolve(fixture.linkedRoot, PROJECT_ENV_KEY_FILENAME)
    ).exists()
  ).toBe(false);

  const primaryEnsured = await ensureProjectEnvSecretKey({
    projectRoot: fixture.primaryRoot,
  });
  expect(primaryEnsured.created).toBe(false);
  expect(primaryEnsured.keyText).toBe(ensured.keyText);
});

test("secrets encrypted in a worktree decrypt in the primary and vice versa", async () => {
  const fixture = await createWorktreeFixture();

  await setProjectEnvValue({
    projectRoot: fixture.linkedRoot,
    projectDir: resolve(fixture.linkedRoot, ".hack"),
    envName: null,
    scope: "api",
    key: "FROM_WORKTREE",
    value: "worktree-secret",
    secret: true,
  });
  await setProjectEnvValue({
    projectRoot: fixture.primaryRoot,
    projectDir: resolve(fixture.primaryRoot, ".hack"),
    envName: null,
    scope: "api",
    key: "FROM_PRIMARY",
    value: "primary-secret",
    secret: true,
  });

  const inPrimary = await resolveProjectEnvConfig({
    projectRoot: fixture.primaryRoot,
    projectDir: resolve(fixture.primaryRoot, ".hack"),
    envName: null,
    serviceNames: ["api"],
  });
  expect(inPrimary?.serviceEnv.api?.FROM_PRIMARY).toBe("primary-secret");

  const inWorktree = await resolveProjectEnvConfig({
    projectRoot: fixture.linkedRoot,
    projectDir: resolve(fixture.linkedRoot, ".hack"),
    envName: null,
    serviceNames: ["api"],
  });
  expect(inWorktree?.serviceEnv.api?.FROM_WORKTREE).toBe("worktree-secret");
});

test("ensure from a worktree adopts the primary checkout key instead of minting a new one", async () => {
  const fixture = await createWorktreeFixture();

  const primaryKeyPath = resolve(fixture.primaryRoot, PROJECT_ENV_KEY_FILENAME);
  await writeFile(primaryKeyPath, "primary-key-text\n");
  await chmod(primaryKeyPath, 0o600);

  const ensured = await ensureProjectEnvSecretKey({
    projectRoot: fixture.linkedRoot,
  });
  expect(ensured.created).toBe(false);
  expect(ensured.keyText).toBe("primary-key-text");
  expect(ensured.warnings).toEqual([]);

  const location = await resolveProjectEnvSharedKeyLocation({
    projectRoot: fixture.linkedRoot,
  });
  expect(ensured.keyPath).toBe(location?.path ?? "");
  expect((await readFile(ensured.keyPath, "utf8")).trim()).toBe(
    "primary-key-text"
  );
  expect(
    await Bun.file(
      resolve(fixture.linkedRoot, PROJECT_ENV_KEY_FILENAME)
    ).exists()
  ).toBe(false);
});

test("degraded git falls back to a checkout-local key with a divergence warning", async () => {
  const fixture = await createWorktreeFixture();

  await writeFile(
    resolve(fixture.linkedRoot, ".git"),
    `gitdir: ${resolve(fixture.sandbox, "missing", "gitdir")}\n`
  );
  const ensured = await ensureProjectEnvSecretKey({
    projectRoot: fixture.linkedRoot,
  });

  expect(ensured.created).toBe(true);
  expect(ensured.keyPath).toBe(
    resolve(fixture.linkedRoot, PROJECT_ENV_KEY_FILENAME)
  );
  expect(ensured.warnings.length).toBeGreaterThan(0);
  expect(ensured.warnings[0]).toContain("diverge");
});

// Root bypasses mode bits; this permission control requires an unprivileged host.
test.skipIf(process.getuid?.() === 0)(
  "failed shared-location write falls back to a local key with a divergence warning",
  async () => {
    const fixture = await createWorktreeFixture();

    const location = await resolveProjectEnvSharedKeyLocation({
      projectRoot: fixture.linkedRoot,
    });
    if (!location) {
      throw new Error("expected shared key location");
    }
    const commonDir = resolve(location.path, "..");
    await chmod(commonDir, 0o555);
    restorePermissions.push(async () => {
      await chmod(commonDir, 0o755);
    });

    const ensured = await ensureProjectEnvSecretKey({
      projectRoot: fixture.linkedRoot,
    });

    expect(ensured.created).toBe(true);
    expect(ensured.keyPath).toBe(
      resolve(fixture.linkedRoot, PROJECT_ENV_KEY_FILENAME)
    );
    expect(ensured.warnings.length).toBeGreaterThan(0);
    expect(ensured.warnings[0]).toContain(location.path);
  }
);

const KEY_SENTINEL = "synthetic-committed-key-text-never-in-output";
const VALUE_SENTINEL = "synthetic-secret-value-never-in-output";

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Runs the current-branch CLI with an isolated HOME and global config. */
async function runHackCli(opts: {
  readonly sandbox: string;
  readonly args: readonly string[];
}): Promise<CliResult> {
  const home = resolve(opts.sandbox, "home");
  await mkdir(home, { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    HACK_GLOBAL_CONFIG_PATH: resolve(home, "hack.config.json"),
  };
  Reflect.deleteProperty(env, "HACK_ENV_SECRET_KEY");
  const proc = Bun.spawn(
    ["bun", resolve(import.meta.dir, "../index.ts"), ...opts.args],
    {
      cwd: opts.sandbox,
      env,
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
  return { exitCode, stdout, stderr };
}

function envAddSecretArgs(projectRoot: string): readonly string[] {
  return [
    "env",
    "add",
    "API_TOKEN",
    VALUE_SENTINEL,
    "--secret",
    "--path",
    projectRoot,
  ];
}

function expectNoPrivateText(result: CliResult): void {
  for (const text of [KEY_SENTINEL, VALUE_SENTINEL]) {
    expect(result.stdout).not.toContain(text);
    expect(result.stderr).not.toContain(text);
  }
}

async function commitKeyFile(primaryRoot: string): Promise<void> {
  await runGit(["add", "-f", PROJECT_ENV_KEY_FILENAME], primaryRoot);
  await runGit(["commit", "-m", "commit key"], primaryRoot);
}

test("env add --secret refuses a dangling key symlink and never creates its target", async () => {
  const fixture = await createWorktreeFixture();
  const leakPath = resolve(fixture.primaryRoot, "leak.txt");
  await symlink(
    "leak.txt",
    resolve(fixture.primaryRoot, PROJECT_ENV_KEY_FILENAME)
  );

  const result = await runHackCli({
    sandbox: fixture.sandbox,
    args: envAddSecretArgs(fixture.primaryRoot),
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Refusing project env key");
  expect(await Bun.file(leakPath).exists()).toBe(false);
  expect(
    await Bun.file(
      resolve(fixture.primaryRoot, ".hack", "hack.env.default.yaml")
    ).exists()
  ).toBe(false);
  expectNoPrivateText(result);
});

test("env add --secret refuses a key symlink to a tracked file without disclosing it", async () => {
  const fixture = await createWorktreeFixture();
  const trackedPath = resolve(fixture.primaryRoot, "committed-key.txt");
  await writeFile(trackedPath, `${KEY_SENTINEL}\n`);
  await runGit(["add", "committed-key.txt"], fixture.primaryRoot);
  await runGit(["commit", "-m", "track key text"], fixture.primaryRoot);
  await symlink(
    "committed-key.txt",
    resolve(fixture.primaryRoot, PROJECT_ENV_KEY_FILENAME)
  );

  const result = await runHackCli({
    sandbox: fixture.sandbox,
    args: envAddSecretArgs(fixture.primaryRoot),
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Refusing project env key");
  expect(await readFile(trackedPath, "utf8")).toBe(`${KEY_SENTINEL}\n`);
  expectNoPrivateText(result);
});

test("env add --secret refuses to encrypt with a committed key and keeps the key text out of output", async () => {
  const fixture = await createWorktreeFixture();
  await writeFile(
    resolve(fixture.primaryRoot, PROJECT_ENV_KEY_FILENAME),
    `${KEY_SENTINEL}\n`,
    { mode: 0o600 }
  );
  await commitKeyFile(fixture.primaryRoot);

  const result = await runHackCli({
    sandbox: fixture.sandbox,
    args: envAddSecretArgs(fixture.primaryRoot),
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Refusing to encrypt with a git-tracked");
  expect(
    await Bun.file(
      resolve(fixture.primaryRoot, ".hack", "hack.env.default.yaml")
    ).exists()
  ).toBe(false);
  expectNoPrivateText(result);
});

test("a linked worktree refuses a committed primary key before copying it to the shared location", async () => {
  const fixture = await createWorktreeFixture();
  await writeFile(
    resolve(fixture.primaryRoot, PROJECT_ENV_KEY_FILENAME),
    `${KEY_SENTINEL}\n`
  );
  await commitKeyFile(fixture.primaryRoot);

  const error = await ensureProjectEnvSecretKey({
    projectRoot: fixture.linkedRoot,
  }).then(
    () => null,
    (caught: unknown) => caught
  );

  expect(error).toBeInstanceOf(ProjectEnvKeyRefusalError);
  expect(String(error)).not.toContain(KEY_SENTINEL);
  const location = await resolveProjectEnvSharedKeyLocation({
    projectRoot: fixture.linkedRoot,
  });
  expect(location).not.toBeNull();
  expect(await Bun.file(location?.path ?? "").exists()).toBe(false);
});

// v4 compatibility choice: decrypting with a tracked key keeps working (hack
// doctor reports the committed key); only encryption refuses it.
test("decrypting with a git-tracked key stays allowed for v4 compatibility while encryption refuses", async () => {
  const fixture = await createWorktreeFixture();
  const projectDir = resolve(fixture.primaryRoot, ".hack");
  await setProjectEnvValue({
    projectRoot: fixture.primaryRoot,
    projectDir,
    envName: null,
    scope: "api",
    key: "API_TOKEN",
    value: VALUE_SENTINEL,
    secret: true,
  });
  await commitKeyFile(fixture.primaryRoot);

  const resolved = await resolveProjectEnvConfig({
    projectRoot: fixture.primaryRoot,
    projectDir,
    envName: null,
    serviceNames: ["api"],
  });
  expect(resolved?.serviceEnv.api?.API_TOKEN).toBe(VALUE_SENTINEL);

  await expect(
    setProjectEnvValue({
      projectRoot: fixture.primaryRoot,
      projectDir,
      envName: null,
      scope: "api",
      key: "OTHER_TOKEN",
      value: VALUE_SENTINEL,
      secret: true,
    })
  ).rejects.toThrow("Refusing to encrypt with a git-tracked");
});

test("a new checkout-local key is created 0600 even under a restrictive umask", async () => {
  const fixture = await createWorktreeFixture();
  const previousUmask = process.umask(0o277);
  let ensured: Awaited<ReturnType<typeof ensureProjectEnvSecretKey>>;
  try {
    ensured = await ensureProjectEnvSecretKey({
      projectRoot: fixture.primaryRoot,
    });
  } finally {
    process.umask(previousUmask);
  }
  expect(ensured.created).toBe(true);
  expect(ensured.keyPath).toBe(
    resolve(fixture.primaryRoot, PROJECT_ENV_KEY_FILENAME)
  );
  const info = await lstat(ensured.keyPath);
  expect(info.isFile()).toBe(true);
  expect(info.mode & 0o777).toBe(0o600);
  expect((await readFile(ensured.keyPath, "utf8")).trim()).toBe(
    ensured.keyText
  );
});

test("concurrent key creation across checkouts converges on one shared key", async () => {
  const fixture = await createWorktreeFixture();
  const results = await Promise.all([
    ensureProjectEnvSecretKey({ projectRoot: fixture.linkedRoot }),
    ensureProjectEnvSecretKey({ projectRoot: fixture.linkedRoot }),
  ]);
  const location = await resolveProjectEnvSharedKeyLocation({
    projectRoot: fixture.linkedRoot,
  });
  const stored = (await readFile(location?.path ?? "", "utf8")).trim();
  for (const result of results) {
    expect(result.keyPath).toBe(location?.path ?? "");
    expect(result.keyText).toBe(stored);
  }
  expect(results.filter((result) => result.created).length).toBe(1);
});

test("a whitespace-only key file is refused instead of being replaced", async () => {
  const fixture = await createWorktreeFixture();
  const keyPath = resolve(fixture.primaryRoot, PROJECT_ENV_KEY_FILENAME);
  await writeFile(keyPath, "\n");

  await expect(
    ensureProjectEnvSecretKey({ projectRoot: fixture.primaryRoot })
  ).rejects.toBeInstanceOf(ProjectEnvKeyRefusalError);
  expect(await readFile(keyPath, "utf8")).toBe("\n");
});

// Negative control: replacing createPrivateFileExclusive with Bun.write makes
// this test fail, because Bun.write follows the dangling link and creates it.
test("exclusive private-file creation never follows a dangling symlink", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "hack-private-file-"));
  tempDirs.add(sandbox);
  const leakPath = resolve(sandbox, "leak.txt");
  const linkPath = resolve(sandbox, PROJECT_ENV_KEY_FILENAME);
  await symlink("leak.txt", linkPath);

  await expect(
    createPrivateFileExclusive({ path: linkPath, text: `${KEY_SENTINEL}\n` })
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await Bun.file(leakPath).exists()).toBe(false);
  expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
});
