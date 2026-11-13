import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";

/**
 * Legacy `.hack/.env` mutations (`hack env set` and `unset` in a project
 * without YAML layers) get the machine-local git gate (HACK-2165): a file
 * git tracks is refused before any value is written; an ignored one works.
 * Fresh CLI subprocesses with a temp HOME and project; synthetic values only.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const SENTINEL = "synthetic-legacy-local-value";

let root: string | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-env-legacy-git-"));
  await mkdir(join(root, "home"), { recursive: true });
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

function base(): string {
  if (!root) {
    throw new Error("Missing temp root");
  }
  return root;
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(base(), "home"),
    TMPDIR: join(base(), "home"),
    HACK_GLOBAL_CONFIG_PATH: join(base(), "home", "hack-config.json"),
    HACK_LOGGER: "console",
    HACK_SECRETS_FILE_KEY: "legacy-git-privacy-test-key",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
}

async function run(
  args: readonly string[],
  stdin?: string,
  extraEnv: Record<string, string> = {}
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn([process.execPath, ENTRYPOINT, ...args], {
    cwd: REPO_ROOT,
    env: env(extraEnv),
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: fixtureGitEnv({ env: { HOME: join(base(), "home") } }),
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await proc.exited).toBe(0);
}

async function legacyProject(): Promise<string> {
  const projectRoot = join(base(), "legacy");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "legacy-git", dev_host: "legacy-git.hack" })}\n`
  );
  await git(projectRoot, ["init", "-q", "-b", "main"]);
  return projectRoot;
}

test(
  "legacy env set and unset refuse a tracked .hack/.env and write nothing",
  async () => {
    const projectRoot = await legacyProject();
    const envFile = join(projectRoot, ".hack", ".env");
    await writeFile(envFile, "KEPT=1\n", { mode: 0o600 });
    await git(projectRoot, ["add", "-f", "--", envFile]);

    const set = await run(
      ["env", "set", "NEW_VALUE", "--value-stdin", "--path", projectRoot],
      `${SENTINEL}\n`
    );
    expect(set.exitCode).not.toBe(0);
    expect(set.output).toContain("git tracks");
    expect(set.output).not.toContain(SENTINEL);

    const unset = await run([
      "env",
      "unset",
      "KEPT",
      "--path",
      projectRoot,
      "--no-interactive",
    ]);
    expect(unset.exitCode).not.toBe(0);
    expect(unset.output).toContain("git tracks");
    expect(await readFile(envFile, "utf8")).toBe("KEPT=1\n");
  },
  { timeout: 60_000 }
);

test(
  "legacy env set still writes an untracked .hack/.env that info/exclude ignores",
  async () => {
    const projectRoot = await legacyProject();
    const set = await run(
      ["env", "set", "NEW_VALUE", "--value-stdin", "--path", projectRoot],
      `${SENTINEL}\n`
    );
    expect(set.exitCode).toBe(0);
    expect(
      await readFile(join(projectRoot, ".hack", ".env"), "utf8")
    ).toContain("NEW_VALUE");
  },
  { timeout: 60_000 }
);

test(
  "a local write through an alias to a project inside a repository fails closed when git refuses",
  async () => {
    // The repository holds the project in a subdirectory; the alias lives
    // outside every repository; git is made to refuse the checkout.
    const repoRoot = join(base(), "outer");
    const projectRoot = join(repoRoot, "sub", "proj");
    const projectDir = join(projectRoot, ".hack");
    await mkdir(projectDir, { recursive: true });
    await git(repoRoot, ["init", "-q", "-b", "main"]);
    await writeFile(
      join(projectDir, "docker-compose.yml"),
      "services:\n  api:\n    image: alpine:3.20\n"
    );
    await writeFile(
      join(projectDir, "hack.config.json"),
      `${JSON.stringify({ name: "alias-proj", dev_host: "alias-proj.hack" })}\n`
    );
    await writeFile(
      join(projectDir, "hack.env.default.yaml"),
      "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
    );
    const alias = join(base(), "alias");
    await symlink(projectRoot, alias);

    const set = await run(
      [
        "env",
        "set",
        "ALIAS_VALUE",
        "--local",
        "--value-stdin",
        "--path",
        alias,
      ],
      `${SENTINEL}\n`,
      { GIT_CEILING_DIRECTORIES: repoRoot }
    );
    expect(set.exitCode).not.toBe(0);
    expect(set.output).toContain("could not report whether it tracks");
    expect(set.output).not.toContain(SENTINEL);
    expect(
      await Bun.file(join(projectDir, "hack.env.local.yaml")).exists()
    ).toBe(false);
  },
  { timeout: 60_000 }
);
