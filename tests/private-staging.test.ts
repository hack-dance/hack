import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { replacePrivateFileAtomic } from "../src/lib/private-file.ts";
import {
  findStagingLeftovers,
  PRIVATE_STAGING_DIRNAME,
  preparePrivateStaging,
  STAGING_LEFTOVER_MIN_AGE_MS,
} from "../src/lib/private-staging.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hack-private-staging-"));
  dirs.push(dir);
  return dir;
}

const refusal = () => new Error("synthetic staging refusal");
const UUID = "0f0e0d0c-0b0a-4908-8706-050403020100";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: fixtureGitEnv({
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out;
}

async function backdate(path: string): Promise<void> {
  const old = (Date.now() - STAGING_LEFTOVER_MIN_AGE_MS - 60_000) / 1000;
  await utimes(path, old, old);
}

test("the staging directory is private and ignores itself before any staging file exists", async () => {
  const root = await tempDir();
  const target = join(root, PROJECT_ENV_KEY_FILENAME);
  const prepared = await preparePrivateStaging({ target, refusal });
  const staging = join(root, PRIVATE_STAGING_DIRNAME);
  expect(prepared.path.startsWith(`${staging}/`)).toBe(true);
  expect((await lstat(staging)).mode & 0o777).toBe(0o700);
  expect(await readFile(join(staging, ".gitignore"), "utf8")).toBe("*\n");
  expect(await readdir(staging)).toEqual([".gitignore"]);
});

test("an interrupted key publication leaves nothing git can stage (HACK-2165 F1)", async () => {
  const root = await tempDir();
  await git(root, ["init", "-q", "-b", "main"]);
  await writeFile(join(root, ".gitignore"), `${PROJECT_ENV_KEY_FILENAME}\n`);
  const target = join(root, PROJECT_ENV_KEY_FILENAME);
  // A process killed after writing its staging copy, before the publish.
  const prepared = await preparePrivateStaging({ target, refusal });
  await writeFile(prepared.path, "synthetic-staged-key\n", { mode: 0o600 });
  await writeFile(target, "synthetic-published-key\n", { mode: 0o600 });

  await git(root, ["add", "-A"]);
  const staged = await git(root, ["diff", "--cached", "--name-only"]);
  expect(staged.split("\n").filter(Boolean)).toEqual([".gitignore"]);
  const status = await git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  expect(status).not.toContain(PRIVATE_STAGING_DIRNAME);
  expect(status).not.toContain(".tmp");
});

test("a write stages in the private directory and leaves only its .gitignore", async () => {
  const root = await tempDir();
  const target = join(root, ".env");
  await replacePrivateFileAtomic({
    path: target,
    directories: [root],
    refusal,
    text: "SYNTHETIC=1\n",
  });
  expect(await readFile(target, "utf8")).toBe("SYNTHETIC=1\n");
  expect((await readdir(root)).sort()).toEqual([
    ".env",
    PRIVATE_STAGING_DIRNAME,
  ]);
  expect(await readdir(join(root, PRIVATE_STAGING_DIRNAME))).toEqual([
    ".gitignore",
  ]);

  // A failure before the rename removes the staging copy too.
  await expect(
    replacePrivateFileAtomic({
      path: target,
      directories: [root],
      refusal,
      text: "SYNTHETIC=2\n",
      beforeRename: async () => {
        throw new Error("synthetic abort");
      },
    })
  ).rejects.toThrow("synthetic abort");
  expect(await readFile(target, "utf8")).toBe("SYNTHETIC=1\n");
  expect(await readdir(join(root, PRIVATE_STAGING_DIRNAME))).toEqual([
    ".gitignore",
  ]);
});

test("the sibling option keeps the previous staging location", async () => {
  const root = await tempDir();
  const target = join(root, "claim.json");
  await replacePrivateFileAtomic({
    path: target,
    directories: [root],
    refusal,
    text: "{}\n",
    staging: "sibling",
  });
  expect(await readdir(root)).toEqual(["claim.json"]);
});

test("doctor finds old staging copies and siblings; the next staging write removes none of them", async () => {
  const root = await tempDir();
  const target = join(root, ".env");
  const staging = join(root, PRIVATE_STAGING_DIRNAME);
  await preparePrivateStaging({ target, refusal });
  const oldStaged = join(staging, `.env.${UUID}.tmp`);
  const recentStaged = join(staging, `.env.${UUID.replace("0f", "1f")}.tmp`);
  const oldSibling = join(root, `..env.${UUID}.tmp`);
  const otherFile = join(root, `..envx.${UUID}.tmp`);
  for (const path of [oldStaged, recentStaged, oldSibling, otherFile]) {
    await writeFile(path, "SYNTHETIC_LEFTOVER=1\n", { mode: 0o600 });
  }
  for (const path of [oldStaged, oldSibling, otherFile]) {
    await backdate(path);
  }

  const found = await findStagingLeftovers({
    directory: root,
    names: [".env"],
    now: Date.now(),
  });
  expect(found.map((leftover) => leftover.path).sort()).toEqual(
    [oldSibling, oldStaged].sort()
  );

  // A writer removes nothing, in the staging directory or beside it: it
  // cannot tell a leftover from a file configured at a staging-shaped path,
  // so removal is left to `hack doctor --fix` (HACK-2165).
  const before = (await readdir(staging)).sort();
  await preparePrivateStaging({ target, refusal });
  expect((await readdir(staging)).sort()).toEqual(before);
  expect((await readdir(root)).sort()).toEqual(
    [PRIVATE_STAGING_DIRNAME, `..env.${UUID}.tmp`, `..envx.${UUID}.tmp`].sort()
  );
});

test("staging for one target never touches a live file staged under a longer name", async () => {
  const root = await tempDir();
  await preparePrivateStaging({ target: join(root, ".env"), refusal });
  // A recovered key kept where it was staged for a target `.env.key`.
  const liveKey = join(root, PRIVATE_STAGING_DIRNAME, `.env.key.${UUID}.tmp`);
  await writeFile(liveKey, "synthetic-live-key\n", { mode: 0o600 });
  await backdate(liveKey);
  await preparePrivateStaging({ target: join(root, ".env"), refusal });
  expect(await readFile(liveKey, "utf8")).toBe("synthetic-live-key\n");
});

test("a linked staging directory is refused; a loose one of the user's own is made private", async () => {
  const root = await tempDir();
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);
  const linked = join(root, "linked");
  await mkdir(linked);
  await symlink(elsewhere, join(linked, PRIVATE_STAGING_DIRNAME));
  await expect(
    preparePrivateStaging({ target: join(linked, ".env"), refusal })
  ).rejects.toThrow("synthetic staging refusal");
  expect(await readdir(elsewhere)).toEqual([]);

  // A loose staging directory of the user's own is made private, then used.
  const shared = join(root, "shared");
  await mkdir(join(shared, PRIVATE_STAGING_DIRNAME), { recursive: true });
  await chmod(join(shared, PRIVATE_STAGING_DIRNAME), 0o777);
  await preparePrivateStaging({ target: join(shared, ".env"), refusal });
  expect(
    (await lstat(join(shared, PRIVATE_STAGING_DIRNAME))).mode & 0o777
  ).toBe(0o700);
});

test("a staging directory whose .gitignore does not ignore everything is refused (a committed one included)", async () => {
  const root = await tempDir();
  const staging = join(root, PRIVATE_STAGING_DIRNAME);
  // As git would check it out under umask 077: private, owned by the user.
  await mkdir(staging, { mode: 0o700 });
  await writeFile(join(staging, ".gitignore"), "!*.tmp\n");
  await expect(
    preparePrivateStaging({ target: join(root, ".env"), refusal })
  ).rejects.toThrow("synthetic staging refusal");
  expect(await readdir(staging)).toEqual([".gitignore"]);

  const linkedRoot = await tempDir();
  const linkedStaging = join(linkedRoot, PRIVATE_STAGING_DIRNAME);
  await mkdir(linkedStaging, { mode: 0o700 });
  const elsewhere = join(linkedRoot, "elsewhere-ignore");
  await writeFile(elsewhere, "*\n");
  await symlink(elsewhere, join(linkedStaging, ".gitignore"));
  await expect(
    preparePrivateStaging({ target: join(linkedRoot, ".env"), refusal })
  ).rejects.toThrow("synthetic staging refusal");
});

// Smoke test only: in one process the open/write interleaving that left a
// concurrent first writer reading an empty .gitignore rarely occurs (it was
// seen across worker processes). The guarantee is structural: the file is
// staged complete and linked into place, so it never exists partially.
test("concurrent first writers in a fresh directory all get a complete self-ignore", async () => {
  const root = await tempDir();
  const results = await Promise.allSettled(
    Array.from({ length: 32 }, () =>
      preparePrivateStaging({ target: join(root, ".env"), refusal })
    )
  );
  expect(results.filter((result) => result.status === "rejected")).toEqual([]);
  const staging = join(root, PRIVATE_STAGING_DIRNAME);
  expect(await readdir(staging)).toEqual([".gitignore"]);
  expect(await readFile(join(staging, ".gitignore"), "utf8")).toBe("*\n");
});

test("on a filesystem without Unix permissions (ExFAT, FAT) a staging directory is still admitted", async () => {
  const root = await tempDir();
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "private-staging-noperm-worker.ts"),
      join(root, ".env"),
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toBe("admitted\n");
  expect((await lstat(join(root, PRIVATE_STAGING_DIRNAME))).mode & 0o777).toBe(
    0o777
  );
});

test("a FIFO in place of the staging .gitignore is refused, not waited on", async () => {
  const root = await tempDir();
  const staging = join(root, PRIVATE_STAGING_DIRNAME);
  await mkdir(staging, { mode: 0o700 });
  const mkfifo = Bun.spawn(["mkfifo", join(staging, ".gitignore")]);
  expect(await mkfifo.exited).toBe(0);
  const started = Date.now();
  await expect(
    preparePrivateStaging({ target: join(root, ".env"), refusal })
  ).rejects.toThrow("synthetic staging refusal");
  expect(Date.now() - started).toBeLessThan(5000);
}, 10_000);

test.skipIf(process.getuid?.() === 0)(
  "a restrictive umask still leaves a readable self-ignore and a usable staging directory",
  async () => {
    const root = await tempDir();
    const previous = process.umask(0o377);
    try {
      await preparePrivateStaging({ target: join(root, ".env"), refusal });
    } finally {
      process.umask(previous);
    }
    const ignore = join(root, PRIVATE_STAGING_DIRNAME, ".gitignore");
    expect((await lstat(ignore)).mode & 0o777).toBe(0o600);
    expect(await readFile(ignore, "utf8")).toBe("*\n");
  }
);
