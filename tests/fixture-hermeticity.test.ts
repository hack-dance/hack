import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { restoreEnv } from "./helpers/env.ts";
import {
  FIXTURE_GIT_IDENTITY,
  fixtureGitEnv,
  fixtureGitShellEnv,
  runFixtureGit,
  runFixtureGitSync,
} from "./helpers/fixture-git.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1459: test fixtures must not reach outside their temp roots through the
 * caller's environment. A caller-exported `GIT_DIR` once made fixture `git`
 * commit, branch and register worktrees in another repository, and a
 * contributor's global `core.hooksPath` refused fixture commits.
 */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-fixture-hermeticity-"));
  roots.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): string {
  const result = runFixtureGitSync({ cwd, args });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout;
}

/** Every file below `root`, with its bytes, so any write shows up. */
function tree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        files[relative(root, path)] = readFileSync(path).toString("base64");
      }
    }
  };
  walk(root);
  return files;
}

async function withCallerEnv<T>(
  env: Readonly<Record<string, string>>,
  run: () => Promise<T>
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      restoreEnv(key, value);
    }
  }
}

test("fixture git ignores a caller-exported GIT_DIR, work tree, index and global hooks", async () => {
  const root = await scratchRoot();
  // The repository a caller's environment points at.
  const scratch = join(root, "scratch");
  await mkdir(scratch);
  git(scratch, ["init", "--quiet", "-b", "main"]);
  await writeFile(join(scratch, "tracked.txt"), "scratch\n");
  git(scratch, ["add", "tracked.txt"]);
  git(scratch, ["commit", "--quiet", "-m", "scratch"]);
  const before = tree(scratch);
  // A global config whose hook refuses every commit and leaves a marker.
  const hooks = join(root, "hostile-hooks");
  const marker = join(root, "hostile-hook-ran");
  await mkdir(hooks);
  for (const hook of ["pre-commit", "post-checkout", "reference-transaction"]) {
    await writeFile(
      join(hooks, hook),
      `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`
    );
    await chmod(join(hooks, hook), 0o755);
  }
  const globalConfig = join(root, "hostile-gitconfig");
  await writeFile(
    globalConfig,
    `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgsign = true\n[user]\n\tname = Hostile\n\temail = hostile@example.invalid\n`
  );

  const fixture = join(root, "fixture");
  const linked = join(root, "linked");
  await mkdir(fixture);
  await withCallerEnv(
    {
      GIT_DIR: join(scratch, ".git"),
      GIT_WORK_TREE: scratch,
      GIT_INDEX_FILE: join(scratch, ".git", "index"),
      GIT_OBJECT_DIRECTORY: join(scratch, ".git", "objects"),
      GIT_COMMON_DIR: join(scratch, ".git"),
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_AUTHOR_NAME: "Hostile",
      GIT_COMMITTER_NAME: "Hostile",
    },
    async () => {
      // Every route a fixture uses: the sync and async runners, a raw spawn
      // with the shared env, and the src/lib/shell.ts options.
      git(fixture, ["init", "--quiet", "-b", "main"]);
      await writeFile(join(fixture, "fixture.txt"), "fixture\n");
      expect(
        (await runFixtureGit({ cwd: fixture, args: ["add", "fixture.txt"] }))
          .exitCode
      ).toBe(0);
      const commit = Bun.spawnSync(
        ["git", "commit", "--quiet", "-m", "fixture"],
        { cwd: fixture, env: fixtureGitEnv(), stdout: "pipe", stderr: "pipe" }
      );
      expect(commit.exitCode, commit.stderr.toString()).toBe(0);
      const { env, unsetEnvKeys } = fixtureGitShellEnv();
      for (const key of [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_COMMON_DIR",
      ]) {
        expect(Object.hasOwn(env, key)).toBe(false);
        expect(unsetEnvKeys).toContain(key);
      }
      git(fixture, ["worktree", "add", "--quiet", "-b", "feature", linked]);
    }
  );

  // The fixture got its commit, identity and linked worktree...
  expect(git(fixture, ["log", "-1", "--format=%an <%ae>|%cn"]).trim()).toBe(
    `${FIXTURE_GIT_IDENTITY.name} <${FIXTURE_GIT_IDENTITY.email}>|${FIXTURE_GIT_IDENTITY.name}`
  );
  expect(git(fixture, ["ls-files"]).trim()).toBe("fixture.txt");
  expect(git(linked, ["branch", "--show-current"]).trim()).toBe("feature");
  // ...and the repository the caller pointed at is byte-for-byte unchanged.
  expect(tree(scratch)).toEqual(before);
  expect(git(scratch, ["worktree", "list", "--porcelain"])).not.toContain(
    linked
  );
  expect(existsSync(marker)).toBe(false);
});

test("a fixture HOME's own global git config cannot add hooks, signing or identity", async () => {
  const root = await scratchRoot();
  const home = join(root, "home");
  const hooks = join(root, "hooks");
  const marker = join(root, "hook-ran");
  await mkdir(home);
  await mkdir(hooks);
  await writeFile(
    join(hooks, "pre-commit"),
    `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`
  );
  await chmod(join(hooks, "pre-commit"), 0o755);
  await writeFile(
    join(home, ".gitconfig"),
    `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgsign = true\n[user]\n\tname = Home\n\temail = home@example.invalid\n`
  );
  const repo = join(root, "repo");
  await mkdir(repo);
  const run = (args: readonly string[]) => {
    const result = runFixtureGitSync({ cwd: repo, args, env: { HOME: home } });
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  };
  run(["init", "--quiet", "-b", "main"]);
  await writeFile(join(repo, "file.txt"), "file\n");
  run(["add", "file.txt"]);
  run(["commit", "--quiet", "-m", "fixture"]);
  expect(run(["log", "-1", "--format=%ae"]).trim()).toBe(
    FIXTURE_GIT_IDENTITY.email
  );
  expect(existsSync(marker)).toBe(false);
});

test("fixture git and the private CLI env never carry an ambient Docker selection or runner home", async () => {
  const root = await scratchRoot();
  await withCallerEnv(
    {
      DOCKER_HOST: `unix://${join(root, "missing-docker.sock")}`,
      DOCKER_CONTEXT: "hack-test-missing-context",
      XDG_CONFIG_HOME: join(root, "runner-xdg"),
    },
    async () => {
      // A caller that copies the runner's values into the fixture env.
      const gitEnv = fixtureGitEnv({
        env: {
          ...privateCliEnv({ root }),
          DOCKER_HOST: process.env.DOCKER_HOST,
          DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        },
      });
      expect(gitEnv.DOCKER_HOST).toBeUndefined();
      expect(gitEnv.DOCKER_CONTEXT).toBeUndefined();
      expect(gitEnv.XDG_CONFIG_HOME).toBeUndefined();
      // A private HOME passed on purpose is kept.
      expect(gitEnv.HOME).toBe(join(root, "user-home"));
      // A copy of the runner's own HOME is not.
      expect(
        fixtureGitEnv({ env: { HOME: process.env.HOME ?? "/" } }).HOME
      ).toBeUndefined();
      const cliEnv = privateCliEnv({ root });
      expect(cliEnv.DOCKER_HOST).toBeUndefined();
      expect(cliEnv.DOCKER_CONTEXT).toBeUndefined();
    }
  );
});

test("a Git variable set on purpose passes through gitEnv but never overrides the hermetic settings", () => {
  const env = fixtureGitEnv({
    env: { GIT_INDEX_FILE: "/caller/index" },
    gitEnv: {
      GIT_INDEX_FILE: "/fixture/index",
      GIT_CONFIG_GLOBAL: "/caller/gitconfig",
      NOT_GIT: "ignored",
    },
  });
  expect(env.GIT_INDEX_FILE).toBe("/fixture/index");
  expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  expect(env.NOT_GIT).toBeUndefined();
});

// -----------------------------------------------------------------------------
// Every fixture `git` spawn in tests/ goes through the shared environment.
// -----------------------------------------------------------------------------

const TESTS_ROOT = resolve(import.meta.dir);
/** Files whose `["git"` text is data (scanner examples), not a spawn. */
const NOT_SPAWNS: ReadonlyMap<string, string> = new Map([
  [
    "cli-spawn-env-isolation.test.ts",
    "holds spawn snippets as strings for the CLI spawn scanner",
  ],
  ["fixture-hermeticity.test.ts", "this scanner's own patterns"],
  ["fixture-git.ts", "the shared helper, which builds the environment itself"],
]);
const GIT_SPAWN =
  /(?:\b(?:spawn|spawnSync|exec|execFile)\(\s*|\b(?:cmd|argv)\s*:\s*)\[\s*"git"/g;
const SHARED_ENV = /fixtureGit(?:Shell)?Env\(|runFixtureGit(?:Sync)?\(/;

/** The text of the call or object literal that holds a `["git"` argv. */
function spawnSite(text: string, at: number): string {
  let depth = 0;
  let start = at;
  // Walk back to the call's `(` or the options object's `{`.
  for (let i = at; i >= 0; i--) {
    const c = text[i];
    if (c === ")" || c === "}" || c === "]") {
      depth++;
    } else if (c === "(" || c === "{" || c === "[") {
      if (depth === 0 && (c === "(" || c === "{")) {
        start = i;
        break;
      }
      depth = Math.max(0, depth - 1);
    }
  }
  depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "{" || c === "[") {
      depth++;
    } else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return text.slice(start);
}

test("every fixture git spawn in tests/ uses the shared hermetic environment", () => {
  const unrouted: string[] = [];
  for (const file of new Bun.Glob("**/*.ts").scanSync(TESTS_ROOT)) {
    const name = file.split("/").pop() ?? file;
    if (NOT_SPAWNS.has(name) || file.startsWith("apps/")) {
      continue;
    }
    const text = readFileSync(join(TESTS_ROOT, file), "utf8");
    for (const match of text.matchAll(GIT_SPAWN)) {
      if (!SHARED_ENV.test(spawnSite(text, match.index ?? 0))) {
        const line = text.slice(0, match.index).split("\n").length;
        unrouted.push(`tests/${file}:${line}`);
      }
    }
  }
  expect(unrouted).toEqual([]);
  // Positive control: the scan still finds a routed fixture spawn.
  const routed = readFileSync(
    join(TESTS_ROOT, "native-env-metadata.test.ts"),
    "utf8"
  );
  const sites = [...routed.matchAll(GIT_SPAWN)];
  expect(sites.length).toBeGreaterThan(0);
  for (const site of sites) {
    expect(spawnSite(routed, site.index ?? 0)).toMatch(SHARED_ENV);
  }
});
