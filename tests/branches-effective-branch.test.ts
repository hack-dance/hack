import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveEffectiveBranch } from "../src/lib/branches.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
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

async function createFixture(opts: { readonly branch: string }): Promise<{
  readonly primaryRoot: string;
  readonly linkedRoot: string;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), "hack-effective-branch-"));
  tempDirs.add(sandbox);

  const primaryRoot = resolve(sandbox, "primary");
  await mkdir(primaryRoot, { recursive: true });
  await writeFile(resolve(primaryRoot, "README.md"), "# fixture\n");
  await runGit(["init", "-b", "main"], primaryRoot);
  await runGit(["config", "user.name", "Hack Test"], primaryRoot);
  await runGit(["config", "user.email", "hack@example.com"], primaryRoot);
  await runGit(["add", "."], primaryRoot);
  await runGit(["commit", "-m", "init"], primaryRoot);

  const linkedRoot = resolve(sandbox, "linked");
  await runGit(["worktree", "add", "-b", opts.branch, linkedRoot], primaryRoot);

  return { primaryRoot, linkedRoot };
}

test("linked worktree defaults to the sanitized current git branch", async () => {
  const fixture = await createFixture({ branch: "feature/My_Branch" });

  const resolved = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: fixture.linkedRoot,
    autoBranchEnabled: true,
  });

  expect(resolved.source).toBe("worktree");
  expect(resolved.branch).toBe("feature-my-branch");
  expect(resolved.gitBranch).toBe("feature/My_Branch");
});

test("explicit branch always wins over the worktree default", async () => {
  const fixture = await createFixture({ branch: "feature/other" });

  const resolved = await resolveEffectiveBranch({
    explicitBranch: "pinned",
    projectRoot: fixture.linkedRoot,
    autoBranchEnabled: true,
  });

  expect(resolved.source).toBe("explicit");
  expect(resolved.branch).toBe("pinned");
});

test("worktree.auto_branch=false disables the default", async () => {
  const fixture = await createFixture({ branch: "feature/opt-out" });

  const resolved = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: fixture.linkedRoot,
    autoBranchEnabled: false,
  });

  expect(resolved.source).toBe("none");
  expect(resolved.branch).toBeNull();
});

test("primary checkout resolves to the base instance", async () => {
  const fixture = await createFixture({ branch: "feature/unrelated" });

  const resolved = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: fixture.primaryRoot,
    autoBranchEnabled: true,
  });

  expect(resolved.source).toBe("none");
  expect(resolved.branch).toBeNull();
});

test("detached HEAD in a linked worktree refuses an implicit base instance", async () => {
  const fixture = await createFixture({ branch: "feature/detach-me" });
  await runGit(["checkout", "--detach"], fixture.linkedRoot);

  const resolved = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: fixture.linkedRoot,
    autoBranchEnabled: true,
  });

  expect(resolved.source).toBe("detached-worktree");
  expect(resolved.branch).toBeNull();
});

test("worktree.auto_branch=false explicitly allows the base instance from detached HEAD", async () => {
  const fixture = await createFixture({ branch: "feature/detached-opt-out" });
  await runGit(["checkout", "--detach"], fixture.linkedRoot);

  const resolved = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: fixture.linkedRoot,
    autoBranchEnabled: false,
  });

  expect(resolved.source).toBe("none");
  expect(resolved.branch).toBeNull();
});

test("non-git directories resolve to the base instance", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "hack-effective-branch-plain-"));
  tempDirs.add(sandbox);

  const resolved = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: sandbox,
    autoBranchEnabled: true,
  });

  expect(resolved.source).toBe("none");
  expect(resolved.branch).toBeNull();
});

test("colliding sanitized slugs across worktrees get deterministic distinct suffixes", async () => {
  const fixture = await createFixture({ branch: "feature/api" });
  const secondRoot = resolve(fixture.primaryRoot, "..", "linked-2");
  await runGit(
    ["worktree", "add", "-b", "feature-api", secondRoot],
    fixture.primaryRoot
  );

  const first = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: fixture.linkedRoot,
    autoBranchEnabled: true,
  });
  const second = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: secondRoot,
    autoBranchEnabled: true,
  });

  expect(first.branch).not.toBe(second.branch);
  expect(first.branch).toStartWith("feature-api-");
  expect(second.branch).toStartWith("feature-api-");

  const firstAgain = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: fixture.linkedRoot,
    autoBranchEnabled: true,
  });
  expect(firstAgain.branch).toBe(first.branch);
});

test("non-colliding worktree slugs stay unsuffixed", async () => {
  const fixture = await createFixture({ branch: "feature/solo" });

  const resolved = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: fixture.linkedRoot,
    autoBranchEnabled: true,
  });

  expect(resolved.branch).toBe("feature-solo");
});
