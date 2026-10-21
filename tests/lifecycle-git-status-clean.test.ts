import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1278: Compose lifecycle commands must leave `git status` unchanged in a
 * clean, already-initialized checkout. The fixture matches a project that an
 * earlier Hack version initialized: `.hack/` holds only authored config, with
 * no committed `.hack/.gitignore`. A stub `docker` stands in for the engine,
 * and HOME and HACK_HOME are private to the fixture.
 */
const CLI = resolve(import.meta.dir, "..", "index.ts");

const STUB = [
  "#!/bin/sh",
  'if [ "$1" = "compose" ]; then',
  '  case " $* " in',
  '    *" ps "*)',
  '      printf "%s\\n" \'{"Service":"web","State":"running","ExitCode":0}\'',
  "      exit 0",
  "      ;;",
  "  esac",
  "fi",
  "exit 0",
  "",
].join("\n");

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Hack Test",
  GIT_AUTHOR_EMAIL: "hack@example.com",
  GIT_COMMITTER_NAME: "Hack Test",
  GIT_COMMITTER_EMAIL: "hack@example.com",
} as const;

let root: string;
let repoRoot: string;

function cliEnv(): Record<string, string> {
  return privateCliEnv({
    root,
    env: {
      // Stub docker plus base system tools (git) only.
      PATH: `${join(root, "bin")}:/usr/bin:/bin`,
      HACK_HOME: join(root, "hack-home"),
      HACK_NO_INTERACTIVE: "1",
      ...GIT_ENV,
    },
  });
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: cliEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}

async function hack(args: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env: cliEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `hack ${args.join(" ")} exited ${exitCode}\n${stdout}\n${stderr}`
    );
  }
}

async function porcelain(cwd: string): Promise<string> {
  return await git(["status", "--porcelain", "--untracked-files=all"], cwd);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-git-clean-")));
  repoRoot = join(root, "repo");
  const hackDir = join(repoRoot, ".hack");
  await mkdir(hackDir, { recursive: true });
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "docker"), STUB);
  await chmod(join(root, "bin", "docker"), 0o755);
  await writeFile(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify({
      name: "gitclean",
      dev_host: "gitclean.hack",
      internal: { dns: false, tls: false },
      logs: { follow_backend: "compose", snapshot_backend: "compose" },
    })}\n`
  );
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    ["services:", "  web:", "    image: alpine:3.22", ""].join("\n")
  );
  await writeFile(join(repoRoot, "README.md"), "# gitclean\n");
  await git(["init", "-q", "-b", "main"], repoRoot);
  await git(["add", "-A"], repoRoot);
  await git(["commit", "-q", "-m", "initialized project"], repoRoot);
  expect(await porcelain(repoRoot)).toBe("");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const LIFECYCLE: readonly (readonly string[])[] = [
  ["up", "--detach", "--json"],
  ["restart"],
  ["run", "web", "true"],
  ["exec", "web", "true"],
  ["down", "--json"],
];

test("up, restart, run, exec and down leave git status unchanged", async () => {
  await hack(["up", "--detach", "--json"], repoRoot);
  // up generated runtime files under .hack/.internal; git must not see them.
  expect(
    await lstat(join(repoRoot, ".hack", ".internal")).then((s) =>
      s.isDirectory()
    )
  ).toBe(true);
  expect(await porcelain(repoRoot)).toBe("");
  await hack(["down", "--json"], repoRoot);
  expect(await porcelain(repoRoot)).toBe("");

  for (const args of LIFECYCLE) {
    await hack(args, repoRoot);
    expect({ args, status: await porcelain(repoRoot) }).toEqual({
      args,
      status: "",
    });
  }
  expect(
    await lstat(join(repoRoot, ".hack", ".gitignore")).catch(() => null)
  ).toBeNull();
  const exclude = await readFile(
    join(repoRoot, ".git", "info", "exclude"),
    "utf8"
  );
  expect(exclude).toContain("/.hack/.internal/");
}, 120_000);

test("up and down in a linked worktree leave both checkouts clean", async () => {
  // Target the base instance from the worktree. With the default
  // `worktree.auto_branch`, `up` also records the derived branch in the
  // authored `.hack/hack.branches.json`; that is a separate behavior from the
  // ignore rules this test covers.
  const configPath = join(repoRoot, ".hack", "hack.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    `${JSON.stringify({ ...config, worktree: { auto_branch: false } })}\n`
  );
  await git(["commit", "-q", "-am", "base instance in worktrees"], repoRoot);
  const worktree = join(root, "feature");
  await git(["worktree", "add", "-q", "-b", "feature", worktree], repoRoot);
  expect(await porcelain(worktree)).toBe("");

  await hack(["up", "--detach", "--json"], worktree);
  expect(await porcelain(worktree)).toBe("");
  expect(await porcelain(repoRoot)).toBe("");
  await hack(["down", "--json"], worktree);
  expect(await porcelain(worktree)).toBe("");
  expect(await porcelain(repoRoot)).toBe("");

  // The rule lives in the shared common dir, not in the worktree's own git dir
  // or tree, so every checkout of the repository is covered.
  const exclude = await readFile(
    join(repoRoot, ".git", "info", "exclude"),
    "utf8"
  );
  expect(exclude).toContain("/.hack/.internal/");
  expect(
    await lstat(join(worktree, ".hack", ".gitignore")).catch(() => null)
  ).toBeNull();
  expect(
    await lstat(join(repoRoot, ".git", "worktrees", "feature", "info")).catch(
      () => null
    )
  ).toBeNull();

  // Every managed entry is ignored in the linked worktree, including the
  // branch-instance and env-state paths this run did not generate.
  for (const path of [
    ".hack/.branch/compose.feature.override.yml",
    ".hack/.env",
    ".hack/.env.state.json",
    ".hack/hack.env.local.yaml",
  ]) {
    expect({ path, ignored: await isIgnored(path, worktree) }).toEqual({
      path,
      ignored: true,
    });
  }
  // Authored files stay visible to git.
  expect(await isIgnored(".hack/hack.config.json", worktree)).toBe(false);
}, 120_000);

async function isIgnored(path: string, cwd: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "check-ignore", "-q", "--no-index", path], {
    cwd,
    env: cliEnv(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}
