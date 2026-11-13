import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLifecycleCommands } from "../src/commands/project.ts";
import { runLifecycleCommandChild } from "../src/lib/lifecycle-command-child.ts";
import {
  appendLifecycleLogRecord,
  createLifecycleLogSink,
  drainLifecycleOutput,
  resolveLifecycleLogPath,
  resolveLifecycleRootDir,
} from "../src/lib/lifecycle-runtime.ts";
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  moveAsidePublicFile,
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
  test("are created private under umask 022 and older loose modes are made private", async () => {
    const dir = join(root, "a", "lifecycle");
    await ensurePrivateDirectory(dir);
    expect(await mode(dir)).toBe(0o700);
    const file = join(dir, "out.log");
    await appendPrivateFile({ path: file, data: "one\n" });
    expect(await mode(file)).toBe(0o600);
    // An older broad directory is tightened; an older broad log is moved
    // aside (kept privately) and a new private log started.
    await chmod(dir, 0o755);
    await chmod(file, 0o644);
    await ensurePrivateDirectory(dir);
    await appendPrivateFile({ path: file, data: "two\n" });
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(file)).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("two\n");
    const kept = (await readdir(dir)).filter((name) =>
      name.includes(".before-private-")
    );
    expect(await readFile(join(dir, kept[0] as string), "utf8")).toBe("one\n");
  });

  const keptFiles = async (dir: string) =>
    (await readdir(dir)).filter((name) => name.includes(".before-private-"));

  test("an older public log is moved aside privately: an open reader sees nothing new, the history is kept", async () => {
    const file = join(root, "old.log");
    await writeFile(file, "history\n", { mode: 0o644 });
    await chmod(file, 0o644);
    const reader = await open(file, "r");
    try {
      await appendPrivateFile({ path: file, data: "secret after\n" });
      // The path names a new private file with only the new output.
      expect(await mode(file)).toBe(0o600);
      expect(await readFile(file, "utf8")).toBe("secret after\n");
      // The reader's descriptor names the old inode, which got nothing new.
      expect(await reader.readFile({ encoding: "utf8" })).toBe("history\n");
    } finally {
      await reader.close();
    }
    // The history is kept beside it, private too.
    const kept = await keptFiles(root);
    expect(kept).toHaveLength(1);
    expect(await readFile(join(root, kept[0] as string), "utf8")).toBe(
      "history\n"
    );
    expect(await mode(join(root, kept[0] as string))).toBe(0o600);
  });

  test("a log another writer already made private is never moved again", async () => {
    const file = join(root, "old.log");
    await writeFile(file, "history\n", { mode: 0o644 });
    await chmod(file, 0o644);
    await appendPrivateFile({ path: file, data: "record A\n" });
    // The path now names the private file A made: nothing to move.
    expect(await moveAsidePublicFile({ path: file })).toBe(null);
    await appendPrivateFile({ path: file, data: "record B\n" });
    expect(await readFile(file, "utf8")).toBe("record A\nrecord B\n");
    expect(await keptFiles(root)).toHaveLength(1);
  });

  test("a broad file that replaced the one first seen is moved aside too; nothing is appended to a broad file", async () => {
    const file = join(root, "old.log");
    await writeFile(file, "first\n", { mode: 0o644 });
    await chmod(file, 0o644);
    // Another broad file takes the path before the migration runs.
    const other = join(root, "other.tmp");
    await writeFile(other, "second\n", { mode: 0o644 });
    await chmod(other, 0o644);
    await rename(other, file);
    await appendPrivateFile({ path: file, data: "new\n" });
    expect(await mode(file)).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("new\n");
    const kept = await keptFiles(root);
    expect(kept).toHaveLength(1);
    expect(await readFile(join(root, kept[0] as string), "utf8")).toBe(
      "second\n"
    );
  });

  test("a writer that still holds the old file writes into the kept history, not the new log", async () => {
    const file = join(root, "old.log");
    await writeFile(file, "history\n", { mode: 0o644 });
    await chmod(file, 0o644);
    const shell = await open(file, "a");
    try {
      await appendPrivateFile({ path: file, data: "new\n" });
      await shell.write("late line\n");
    } finally {
      await shell.close();
    }
    expect(await readFile(file, "utf8")).toBe("new\n");
    const kept = await keptFiles(root);
    expect(await readFile(join(root, kept[0] as string), "utf8")).toBe(
      "history\nlate line\n"
    );
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

  test.skipIf(process.platform !== "linux")(
    "a persistent command's output passes through a private FIFO that is removed afterwards",
    async () => {
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
    }
  );

  test("a log refused while a hook runs never stops its output: every line still reaches the terminal and the hook ends", async () => {
    const projectDir = join(root, "repo", ".hack");
    await mkdir(projectDir, { recursive: true });
    const warnings: string[] = [];
    const sink = createLifecycleLogSink({
      projectDir,
      composeProject: "demo",
      warn: (message) => warnings.push(message),
    });
    await sink.append({
      timestamp: "2026-11-13T00:00:00.000Z",
      service: "api",
      stream: "meta",
      message: "[start] hook",
    });
    // The log becomes unsafe after the start record.
    const logPath = resolveLifecycleLogPath({
      projectDir,
      composeProject: "demo",
    });
    await rm(logPath);
    await symlink(join(root, "elsewhere.log"), logPath);
    const lines = 20_000;
    let printed = 0;
    const started = performance.now();
    const code = await runLifecycleCommandChild({
      // Far more than a pipe holds (about 1.2 MB).
      command: `i=0; while [ $i -lt ${lines} ]; do echo "line $i of the hook output padded to sixty bytes"; i=$((i+1)); done`,
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      drain: (stream, source) =>
        drainLifecycleOutput({
          stream,
          output: source,
          service: "api",
          sink,
          write: () => {
            printed += 1;
          },
        }),
    });
    expect(code).toBe(0);
    expect(printed).toBe(lines);
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Refusing");
    expect(
      await lstat(join(root, "elsewhere.log")).catch(() => null)
    ).toBeNull();
  }, 60_000);

  test("a log the hook itself makes unsafe changes only persistence: the hook succeeds and the next one runs", async () => {
    const projectDir = join(root, "repo", ".hack");
    await mkdir(projectDir, { recursive: true });
    const logPath = resolveLifecycleLogPath({
      projectDir,
      composeProject: "demo",
    });
    const outside = join(root, "outside.log");
    const marker = join(root, "second-ran");
    const code = await runLifecycleCommands({
      title: "up.before",
      commands: [
        {
          name: "first",
          // Swaps its own log for a symlink before printing, then prints, exits 0.
          command: `ln -sfn '${outside}' '${logPath}'; echo one; echo two`,
        },
        { name: "second", command: `touch '${marker}'` },
      ],
      projectRoot: join(root, "repo"),
      env: {},
      projectDir,
      composeProject: "demo",
      routeStdoutToStderr: true,
    });
    expect(code).toBe(0);
    expect((await lstat(marker)).isFile()).toBe(true);
    expect(await lstat(outside).catch(() => null)).toBeNull();
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
    // The refusal is recorded in the log, since the pane closes unseen.
    expect(await readFile(join(root, "lifecycle.log"), "utf8")).toContain(
      "\tapi\tmeta\t[refused] could not create a private temporary directory"
    );
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

  test("the sweep leaves open-mode and unrelated entries alone (a foreign owner needs root to test)", async () => {
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
