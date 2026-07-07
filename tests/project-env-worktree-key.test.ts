import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_KEY_FILENAME,
} from "../src/constants.ts";
import {
  ensureProjectEnvSecretKey,
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
  process.env.HACK_ENV_SECRET_KEY = undefined;
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

test("failed shared-location write falls back to a local key with a divergence warning", async () => {
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
});
