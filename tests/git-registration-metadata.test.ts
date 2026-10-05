import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixture = "";
let env: Record<string, string | undefined>;
const children: Bun.Subprocess[] = [];
const combinedArgs = [
  "rev-parse",
  "--path-format=absolute",
  "--git-common-dir",
  "--sq",
  "--symbolic-full-name",
  "--revs-only",
  "HEAD",
];
const identityArgs = [
  "rev-parse",
  "--path-format=absolute",
  "--git-common-dir",
];
const branchArgs = ["branch", "--show-current"];

function isolatedEnv(root: string) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
    ),
    HOME: join(root, "home"),
    XDG_CACHE_HOME: join(root, "home", "cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "home", "gitconfig"),
    GIT_CEILING_DIRECTORIES: root,
  };
}

async function canUseReftable() {
  const root = await mkdtemp(join(tmpdir(), "hack-git-reftable-capability-"));
  try {
    await mkdir(join(root, "home"));
    const child = Bun.spawn(
      ["git", "init", "--ref-format=reftable", join(root, "repo")],
      {
        env: isolatedEnv(root),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    if (exitCode === 0) {
      return true;
    }
    if (
      (stderr.includes("unknown option") && stderr.includes("ref-format")) ||
      (stderr.includes("unknown ref storage format") &&
        stderr.includes("reftable"))
    ) {
      return false;
    }
    throw new Error(`Reftable capability probe failed: ${stderr}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const reftableAvailable = await canUseReftable();

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "hack-git-metadata-")));
  const home = join(fixture, "home");
  await mkdir(home);
  env = isolatedEnv(fixture);
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  await rm(fixture, { recursive: true, force: true });
});

async function git(repoRoot: string, args: readonly string[]) {
  const child = Bun.spawn(["git", "-C", repoRoot, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Git fixture failed: ${args.join(" ")}\n${stderr}`);
  }
  return stdout;
}

async function init(name = "repo", extra: readonly string[] = []) {
  const repoRoot = join(fixture, name);
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main", ...extra]);
  return repoRoot;
}

async function commit(repoRoot: string) {
  await git(repoRoot, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
}

async function observe(opts: {
  readonly repoRoot: string;
  readonly mode?: string;
  readonly env?: Record<string, string | undefined>;
}) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/git-registration-metadata-worker.ts"),
      opts.repoRoot,
      opts.mode ?? "real",
    ],
    {
      env: opts.env ?? env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const report: unknown = JSON.parse(stdout);
  return report;
}

function expected(opts: {
  readonly repoRoot: string;
  readonly repoIdentity: string | null;
  readonly gitBranch: string | null;
  readonly fallback?: "branch" | "both";
  readonly injected?: boolean;
}) {
  const commands = [combinedArgs];
  if (opts.fallback === "both") {
    commands.push(identityArgs);
  }
  if (opts.fallback) {
    commands.push(branchArgs);
  }
  return {
    metadata: { repoIdentity: opts.repoIdentity, gitBranch: opts.gitBranch },
    commands: commands.map((args) => ["git", "-C", opts.repoRoot, ...args]),
    injected: opts.injected ?? false,
  };
}

for (const name of ["repo", "repo with spaces", "repo\nwith newline"]) {
  test(`committed ${JSON.stringify(name)} returns both fields from one real Git child`, async () => {
    const repoRoot = await init(name);
    await commit(repoRoot);
    expect(await observe({ repoRoot })).toEqual(
      expected({
        repoRoot,
        repoIdentity: join(repoRoot, ".git"),
        gitBranch: "main",
      })
    );
  });
}

test("unborn branch keeps successful identity and uses exactly one branch fallback", async () => {
  const repoRoot = await init();
  expect(await observe({ repoRoot })).toEqual(
    expected({
      repoRoot,
      repoIdentity: join(repoRoot, ".git"),
      gitBranch: "main",
      fallback: "branch",
    })
  );
});

test("failed branch fallback cannot erase a successful unborn repository identity", async () => {
  const repoRoot = await init();
  expect(await observe({ repoRoot, mode: "branch-failure" })).toEqual(
    expected({
      repoRoot,
      repoIdentity: join(repoRoot, ".git"),
      gitBranch: null,
      fallback: "branch",
      injected: true,
    })
  );
});

test("detached HEAD and a branch/tag name collision preserve branch semantics", async () => {
  const repoRoot = await init();
  await commit(repoRoot);
  await git(repoRoot, ["tag", "main"]);
  expect(await observe({ repoRoot })).toEqual(
    expected({
      repoRoot,
      repoIdentity: join(repoRoot, ".git"),
      gitBranch: "main",
    })
  );
  await git(repoRoot, ["checkout", "--detach"]);
  expect(await observe({ repoRoot })).toEqual(
    expected({
      repoRoot,
      repoIdentity: join(repoRoot, ".git"),
      gitBranch: null,
    })
  );
});

test("linked worktree identity is shared while committed, unborn and detached branches remain local", async () => {
  const primary = await init();
  await commit(primary);
  const repoRoot = join(fixture, "linked");
  await git(primary, ["worktree", "add", "-b", "feature/linked", repoRoot]);
  const repoIdentity = join(primary, ".git");
  expect(await observe({ repoRoot })).toEqual(
    expected({ repoRoot, repoIdentity, gitBranch: "feature/linked" })
  );
  await git(repoRoot, ["symbolic-ref", "HEAD", "refs/heads/unborn-linked"]);
  expect(await observe({ repoRoot })).toEqual(
    expected({
      repoRoot,
      repoIdentity,
      gitBranch: "unborn-linked",
      fallback: "branch",
    })
  );
  await git(repoRoot, ["checkout", "--detach", "main"]);
  expect(await observe({ repoRoot })).toEqual(
    expected({ repoRoot, repoIdentity, gitBranch: null })
  );
});

test("Git resolves a symbolic branch chain instead of using literal HEAD contents", async () => {
  const repoRoot = await init();
  await commit(repoRoot);
  await git(repoRoot, ["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
  await git(repoRoot, ["symbolic-ref", "HEAD", "refs/heads/alias"]);
  expect(await observe({ repoRoot })).toEqual(
    expected({
      repoRoot,
      repoIdentity: join(repoRoot, ".git"),
      gitBranch: "main",
    })
  );
});

test("separate Git directory with ref-like newline content cannot become a fake branch", async () => {
  const repoIdentity = join(fixture, "common\nrefs", "heads", "pretend");
  await mkdir(join(fixture, "common\nrefs", "heads"), { recursive: true });
  const repoRoot = await init("separate", ["--separate-git-dir", repoIdentity]);
  expect(await observe({ repoRoot })).toEqual(
    expected({ repoRoot, repoIdentity, gitBranch: "main", fallback: "branch" })
  );
  await commit(repoRoot);
  expect(await observe({ repoRoot })).toEqual(
    expected({ repoRoot, repoIdentity, gitBranch: "main" })
  );
});

test("repository identity remains canonical through a checkout symlink", async () => {
  const primary = await init();
  await commit(primary);
  const repoRoot = join(fixture, "alias");
  await symlink(primary, repoRoot);
  expect(await observe({ repoRoot })).toEqual(
    expected({
      repoRoot,
      repoIdentity: join(primary, ".git"),
      gitBranch: "main",
    })
  );
});

test("an escaped quote in a real branch uses Git's branch fallback without decoding shell syntax", async () => {
  const repoRoot = await init();
  await commit(repoRoot);
  const gitBranch = "feature/quo'te";
  await git(repoRoot, ["checkout", "-b", gitBranch]);
  expect(await observe({ repoRoot })).toEqual(
    expected({
      repoRoot,
      repoIdentity: join(repoRoot, ".git"),
      gitBranch,
      fallback: "branch",
    })
  );
});

for (const mode of [
  "nonzero",
  "no-separator",
  "relative-path",
  "nul-path",
  "unquoted-ref",
]) {
  test(`${mode} combined output cannot replace real identity or branch`, async () => {
    const repoRoot = await init();
    await commit(repoRoot);
    expect(await observe({ repoRoot, mode })).toEqual(
      expected({
        repoRoot,
        repoIdentity: join(repoRoot, ".git"),
        gitBranch: "main",
        fallback: "both",
        injected: true,
      })
    );
  });
}

for (const mode of ["non-head-ref", "backslash-ref", "double-quote-ref"]) {
  test(`${mode} uses the authoritative branch fallback`, async () => {
    const repoRoot = await init();
    await commit(repoRoot);
    expect(await observe({ repoRoot, mode })).toEqual(
      expected({
        repoRoot,
        repoIdentity: join(repoRoot, ".git"),
        gitBranch: "main",
        fallback: "branch",
        injected: true,
      })
    );
  });
}

test("non-Git and missing directories preserve independent null results", async () => {
  const nonGit = join(fixture, "non-git");
  await mkdir(nonGit);
  for (const repoRoot of [nonGit, join(fixture, "missing")]) {
    expect(await observe({ repoRoot })).toEqual(
      expected({
        repoRoot,
        repoIdentity: null,
        gitBranch: null,
        fallback: "both",
      })
    );
  }
});

test("unavailable Git preserves independent null results", async () => {
  const repoRoot = await init();
  const emptyPath = join(fixture, "empty-bin");
  await mkdir(emptyPath);
  expect(await observe({ repoRoot, env: { ...env, PATH: emptyPath } })).toEqual(
    expected({
      repoRoot,
      repoIdentity: null,
      gitBranch: null,
      fallback: "both",
    })
  );
});

test("inherited explicit Git directory still determines metadata", async () => {
  const primary = await init();
  await commit(primary);
  const repoRoot = join(fixture, "caller");
  await mkdir(repoRoot);
  const repoIdentity = join(primary, ".git");
  expect(
    await observe({
      repoRoot,
      env: { ...env, GIT_DIR: repoIdentity, GIT_WORK_TREE: primary },
    })
  ).toEqual(expected({ repoRoot, repoIdentity, gitBranch: "main" }));
});

test.skipIf(!reftableAvailable)(
  "reftable metadata is Git-derived for unborn and committed branches (capability-qualified)",
  async () => {
    const repoRoot = await init("reftable", ["--ref-format=reftable"]);
    const repoIdentity = join(repoRoot, ".git");
    expect(await observe({ repoRoot })).toEqual(
      expected({
        repoRoot,
        repoIdentity,
        gitBranch: "main",
        fallback: "branch",
      })
    );
    await commit(repoRoot);
    expect(await observe({ repoRoot })).toEqual(
      expected({ repoRoot, repoIdentity, gitBranch: "main" })
    );
  }
);
