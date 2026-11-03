import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * HACK-1798: `hack session list` printed lifecycle sessions as one string of
 * name, path and timestamp, and `hack session stop` with that string found
 * nothing. This drives the real CLI against real tmux on a private socket
 * with `LC_ALL=C`, the locale in which tmux rewrites tab separators to `_`.
 * Children get an explicit environment, so the test process stays untouched.
 */
const tmuxPath = Bun.which("tmux");
const cliEntry = resolve(import.meta.dir, "../index.ts");
const workspace = "hack-1798-fixture-project--lifecycle";
// tmux falls back to a prefix match for a bare target; this sibling proves
// stop touches only the session it named.
const sibling = `${workspace}-sibling`;
let root = "";

function isolatedEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    TMUX_TMPDIR: join(root, "tmux"),
    LC_ALL: "C",
    LANG: "C",
  };
}

function tmux(args: readonly string[]) {
  return Bun.spawnSync([tmuxPath ?? "tmux", ...args], {
    env: isolatedEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function hack(args: readonly string[]) {
  const child = Bun.spawnSync(
    [process.execPath, "--no-env-file", cliEntry, ...args],
    {
      cwd: join(root, "outside"),
      env: isolatedEnv(),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

beforeAll(async () => {
  // Unix socket paths are length-limited, so keep the root short.
  root = await mkdtemp("/tmp/hack-1798-");
  await mkdir(join(root, "home"));
  await mkdir(join(root, "tmux"));
  await mkdir(join(root, "outside"));
});

afterAll(async () => {
  if (tmuxPath && root) {
    tmux(["kill-server"]);
  }
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxPath)(
  "session list prints the lifecycle ID that session stop accepts",
  async () => {
    const projectPath = join(root, "my project:dir|x\tend");
    await mkdir(projectPath);
    for (const name of [workspace, sibling]) {
      const created = tmux([
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        projectPath,
      ]);
      expect(created.exitCode, created.stderr.toString()).toBe(0);
    }

    const listed = hack(["session", "list"]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    const ids = listed.stdout
      .trimEnd()
      .split("\n")
      .slice(2)
      .map((line) => line.split(/\s+/)[0]);
    expect(ids.sort()).toEqual([workspace, sibling].sort());

    const stopped = hack(["session", "stop", workspace]);
    expect(stopped.exitCode, stopped.stderr + stopped.stdout).toBe(0);
    expect(tmux(["has-session", "-t", `=${workspace}`]).exitCode).toBe(1);
    expect(tmux(["has-session", "-t", `=${sibling}`]).exitCode).toBe(0);

    // A name that no listed session carries is refused, even though tmux's
    // prefix fallback would resolve it to the sibling.
    const unknown = hack(["session", "stop", "hack-1798-fixture"]);
    expect(unknown.exitCode).toBe(1);
    expect(tmux(["has-session", "-t", `=${sibling}`]).exitCode).toBe(0);
  },
  60_000
);
