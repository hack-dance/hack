import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Disposable Git fixtures for env-secret tests: a Hack project committed in a
 * primary checkout plus one linked worktree, and a private Git runner.
 *
 * Git never reads the runner's HOME, global or system config: HOME is the
 * fixture's private home, and global/system config are disabled.
 */

export type SecretWorktreeFixture = {
  readonly primaryRoot: string;
  readonly linkedRoot: string;
};

/** Runs git with a private HOME and no global/system config; throws on failure. */
export function runFixtureGit(opts: {
  readonly cwd: string;
  readonly home: string;
  readonly args: readonly string[];
}): string {
  const result = Bun.spawnSync(["git", ...opts.args], {
    cwd: opts.cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: opts.home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Hack Test",
      GIT_AUTHOR_EMAIL: "hack-test@example.invalid",
      GIT_COMMITTER_NAME: "Hack Test",
      GIT_COMMITTER_EMAIL: "hack-test@example.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${opts.args[0] ?? ""} failed (exit ${result.exitCode}): ${result.stderr.toString()}`
    );
  }
  return result.stdout.toString();
}

/**
 * Creates `<parent>/primary` (a committed Hack project with one `api` service
 * and a plaintext-only env overlay) and `<parent>/linked`, a linked worktree on
 * a new branch. Nothing secret-related is pre-seeded: no key, no secure value
 * and no Hack ignore rules, so the CLI under test owns all of them.
 */
export async function createSecretWorktreeFixture(opts: {
  readonly parent: string;
  readonly home: string;
  readonly name: string;
}): Promise<SecretWorktreeFixture> {
  const primaryRoot = resolve(opts.parent, "primary");
  const linkedRoot = resolve(opts.parent, "linked");
  const hackDir = join(primaryRoot, ".hack");
  await mkdir(hackDir, { recursive: true });
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify({ name: opts.name, dev_host: `${opts.name}.hack` }, null, 2)}\n`
  );
  await writeFile(
    join(hackDir, "hack.env.default.yaml"),
    "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    PLAIN_FLAG: plain\n"
  );
  await writeFile(join(primaryRoot, "README.md"), "# fixture\n");
  runFixtureGit({
    cwd: primaryRoot,
    home: opts.home,
    args: ["init", "-q", "-b", "main"],
  });
  runFixtureGit({ cwd: primaryRoot, home: opts.home, args: ["add", "-A"] });
  runFixtureGit({
    cwd: primaryRoot,
    home: opts.home,
    args: ["commit", "-q", "-m", "fixture: init"],
  });
  runFixtureGit({
    cwd: primaryRoot,
    home: opts.home,
    args: ["worktree", "add", "-q", "-b", "feature", linkedRoot],
  });
  return { primaryRoot, linkedRoot };
}
