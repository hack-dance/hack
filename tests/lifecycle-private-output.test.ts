import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLifecycleLogRecord,
  resolveLifecycleLogPath,
  resolveLifecycleRootDir,
} from "../src/lib/lifecycle-runtime.ts";
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  PrivatePathRefusedError,
} from "../src/lib/private-file.ts";
import { wrapLifecyclePersistentCommand } from "../src/lib/project-lifecycle-controller.ts";
import {
  MUX_ENVIRONMENT_TTL_MS,
  runMuxEnvironment,
  stageMuxEnvironment,
  sweepStaleMuxEnvironments,
} from "../src/mux/private-environment.ts";
import { restoreEnv } from "./helpers/env.ts";

// ---------------------------------------------------------------------------
// HACK-2170: lifecycle output and staged mux environments hold plaintext
// values. Everything here runs under umask 022, the common default that made
// the old log 0644 and its directory 0755.
// ---------------------------------------------------------------------------

let root = "";
let savedUmask = 0;
let savedTmp: string | undefined;

beforeEach(async () => {
  savedUmask = process.umask(0o022);
  savedTmp = process.env.TMPDIR;
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-private-out-")));
});

afterEach(async () => {
  process.umask(savedUmask);
  restoreEnv("TMPDIR", savedTmp);
  await rm(root, { recursive: true, force: true });
});

const mode = async (path: string) => (await lstat(path)).mode & 0o777;

describe("private files and directories", () => {
  test("are created private under umask 022 and older loose modes are tightened", async () => {
    const dir = join(root, "a", "lifecycle");
    await ensurePrivateDirectory(dir);
    expect(await mode(dir)).toBe(0o700);
    const file = join(dir, "out.log");
    await appendPrivateFile({ path: file, data: "one\n" });
    expect(await mode(file)).toBe(0o600);
    // An older log and directory with broad modes are tightened in place.
    await chmod(dir, 0o755);
    await chmod(file, 0o644);
    await ensurePrivateDirectory(dir);
    await appendPrivateFile({ path: file, data: "two\n" });
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(file)).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("one\ntwo\n");
  });

  test("a planted symlink, hard link or FIFO is refused and its target is untouched", async () => {
    const target = join(root, "elsewhere.txt");
    await writeFile(target, "untouched\n", { mode: 0o644 });
    const viaSymlink = join(root, "via-symlink.log");
    await symlink(target, viaSymlink);
    await expect(
      appendPrivateFile({ path: viaSymlink, data: "secret\n" })
    ).rejects.toBeInstanceOf(PrivatePathRefusedError);
    const viaLink = join(root, "via-link.log");
    await link(target, viaLink);
    await expect(
      appendPrivateFile({ path: viaLink, data: "secret\n" })
    ).rejects.toBeInstanceOf(PrivatePathRefusedError);
    expect(await readFile(target, "utf8")).toBe("untouched\n");
    expect(await mode(target)).toBe(0o644);
    const fifo = join(root, "fifo.log");
    Bun.spawnSync(["mkfifo", fifo]);
    await expect(
      appendPrivateFile({ path: fifo, data: "secret\n" })
    ).rejects.toBeInstanceOf(PrivatePathRefusedError);
    // A symlinked directory is refused, not adopted.
    const realDir = join(root, "real-dir");
    await mkdir(realDir, { mode: 0o755 });
    const linkedDir = join(root, "linked-dir");
    await symlink(realDir, linkedDir);
    await expect(ensurePrivateDirectory(linkedDir)).rejects.toBeInstanceOf(
      PrivatePathRefusedError
    );
    expect(await mode(realDir)).toBe(0o755);
  });
});

describe("lifecycle log", () => {
  test("records land in a private directory and file, and a planted symlink at the log is refused", async () => {
    const projectDir = join(root, "repo", ".hack");
    await mkdir(projectDir, { recursive: true });
    const record = {
      timestamp: "2026-11-13T00:00:00.000Z",
      service: "api",
      stream: "stdout" as const,
      message: "connection string with a value",
    };
    await appendLifecycleLogRecord({
      projectDir,
      composeProject: "demo",
      record,
    });
    const logPath = resolveLifecycleLogPath({
      projectDir,
      composeProject: "demo",
    });
    expect(await mode(resolveLifecycleRootDir({ projectDir }))).toBe(0o700);
    expect(await mode(logPath)).toBe(0o600);
    // Replace the log with a symlink to a file outside: refused.
    const outside = join(root, "outside.txt");
    await writeFile(outside, "", { mode: 0o644 });
    await rm(logPath);
    await symlink(outside, logPath);
    await expect(
      appendLifecycleLogRecord({ projectDir, composeProject: "demo", record })
    ).rejects.toBeInstanceOf(PrivatePathRefusedError);
    expect(await readFile(outside, "utf8")).toBe("");
  });

  test("a persistent command's output passes through a private FIFO that is removed afterwards", async () => {
    const tmp = join(root, "tmp");
    await mkdir(tmp);
    const logPath = join(root, "lifecycle.log");
    await appendPrivateFile({ path: logPath, data: "" });
    const script = wrapLifecyclePersistentCommand({
      // The command reports the mode of its own stdout (the FIFO) and of the
      // FIFO's directory.
      command:
        'f="$(readlink /proc/$$/fd/1)"; stat -c %a "$f"; stat -c %a "$(dirname "$f")"',
      commandPidPath: null,
      logPath,
      serviceName: "api",
    });
    const run = Bun.spawnSync(["sh", "-c", script], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmp },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim().split("\n")).toEqual(["600", "700"]);
    expect(await readdir(tmp)).toEqual([]);
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("\tapi\tstdout\t600");
    expect(await mode(logPath)).toBe(0o600);
  });

  test("a persistent command is not run when its private FIFO cannot be created", async () => {
    const marker = join(root, "ran");
    const script = wrapLifecyclePersistentCommand({
      command: `touch ${marker}`,
      commandPidPath: null,
      logPath: join(root, "lifecycle.log"),
      serviceName: "api",
    });
    const run = Bun.spawnSync(["sh", "-c", script], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: join(root, "missing-temp-dir"),
      },
    });
    expect(run.exitCode).not.toBe(0);
    expect(await lstat(marker).catch(() => null)).toBeNull();
  });
});

describe("staged mux environments", () => {
  const stage = async (dir: string) => {
    process.env.TMPDIR = dir;
    return await stageMuxEnvironment({ FAKE_KEY: "fake-value" });
  };
  const age = async (path: string, ms: number) => {
    const then = new Date(Date.now() - ms);
    await utimes(path, then, then);
  };

  test("a payload no session ran is removed at the next staging once past its time", async () => {
    const tmp = join(root, "tmp");
    await mkdir(tmp);
    const stale = await stage(tmp);
    const fresh = await stage(tmp);
    // Only the stale one is old enough to be swept.
    await age(join(stale.path, ".."), MUX_ENVIRONMENT_TTL_MS + 1000);
    await stage(tmp);
    expect(await lstat(stale.path).catch(() => null)).toBeNull();
    expect((await lstat(fresh.path)).isFile()).toBe(true);
  });

  test("the sweep leaves entries it does not own alone", async () => {
    const tmp = join(root, "tmp");
    await mkdir(tmp);
    const open = join(tmp, "hack-mux-env-open");
    await mkdir(open, { mode: 0o755 });
    await chmod(open, 0o755);
    await writeFile(join(open, "env.json"), "{}");
    const other = join(tmp, "unrelated");
    await mkdir(other);
    await age(open, MUX_ENVIRONMENT_TTL_MS + 1000);
    await age(other, MUX_ENVIRONMENT_TTL_MS + 1000);
    await sweepStaleMuxEnvironments({ parent: tmp });
    expect((await lstat(join(open, "env.json"))).isFile()).toBe(true);
    expect((await lstat(other)).isDirectory()).toBe(true);
  });

  test("a payload past its time is refused and removed, never used", async () => {
    const tmp = join(root, "tmp");
    await mkdir(tmp);
    const payload = await stage(tmp);
    await age(payload.path, MUX_ENVIRONMENT_TTL_MS + 1000);
    const marker = join(root, "ran");
    const code = await runMuxEnvironment(payload.path, ["touch", marker]);
    expect(code).toBe(1);
    expect(await lstat(marker).catch(() => null)).toBeNull();
    expect(await lstat(payload.path).catch(() => null)).toBeNull();
  });
});
