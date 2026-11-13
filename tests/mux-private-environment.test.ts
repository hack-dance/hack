import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  findStaleMuxEnvironments,
  MUX_ENVIRONMENT_TTL_MS,
  removeStaleMuxEnvironment,
  runMuxEnvironment,
  stageMuxEnvironment,
} from "../src/mux/private-environment.ts";
import { restoreEnv } from "./helpers/env.ts";

// Staging sweeps the temp directory for stale payloads: give this file its
// own, so a run never touches the developer's real temp directory.
let savedTmp: string | undefined;
let testTmp = "";
beforeAll(async () => {
  savedTmp = process.env.TMPDIR;
  testTmp = await mkdtemp(join(tmpdir(), "mux-env-tmp-"));
  process.env.TMPDIR = testTmp;
});
afterAll(async () => {
  restoreEnv("TMPDIR", savedTmp);
  await rm(testTmp, { recursive: true, force: true });
});

/**
 * Payloads are staged in a private directory of this file, never the host's
 * temporary directory, so the stale-payload sweep cannot reach real state.
 */
const STAGE_DIR = await mkdtemp(join(tmpdir(), "mux-env-stage-"));
afterAll(async () => {
  await rm(STAGE_DIR, { recursive: true, force: true });
});
const stage = (env: Readonly<Record<string, string>>) =>
  stageMuxEnvironment(env, { tmpDir: STAGE_DIR });

test("private mux payload is owner-only, consumed before spawn, and preserves assignments", async () => {
  const root = await mkdtemp(join(tmpdir(), "mux-env-test-"));
  const payload = await stage({
    UID: "fake-uid",
    NODE_ENV: "selected",
    FAKE_KEY: "fake-key",
  });
  try {
    expect((await lstat(dirname(payload.path))).mode & 0o777).toBe(0o700);
    expect((await lstat(payload.path)).mode & 0o777).toBe(0o600);
    const output = join(root, "result.json");
    const code = await runMuxEnvironment(payload.path, [
      "NODE_ENV=command-local",
      process.execPath,
      "--eval",
      'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ uid: process.env.UID, node: process.env.NODE_ENV, absent: !fs.existsSync(process.argv[2]), leaked: process.argv.some(arg => arg.includes(process.env.FAKE_KEY)) }));',
      output,
      payload.path,
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      uid: "fake-uid",
      node: "command-local",
      absent: true,
      leaked: false,
    });
    expect(await Bun.file(payload.path).exists()).toBe(false);
  } finally {
    await payload.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("private mux input refuses public, malformed, oversized, and symlinked payloads", async () => {
  for (const kind of ["public", "malformed", "oversized", "symlink"] as const) {
    const payload = await stage({ UID: "fake-uid" });
    const foreign = join(dirname(payload.path), "foreign");
    try {
      if (kind === "public") {
        await chmod(payload.path, 0o644);
      }
      if (kind === "malformed") {
        await writeFile(payload.path, "not json");
      }
      if (kind === "oversized") {
        await writeFile(payload.path, "x".repeat(1024 * 1024 + 1));
      }
      if (kind === "symlink") {
        await writeFile(foreign, "preserve");
        await unlink(payload.path);
        await symlink(foreign, payload.path);
      }
      const result = await runMuxEnvironment(payload.path, [
        "/usr/bin/false",
      ]).catch(() => 1);
      expect(result).toBe(1);
      expect((await lstat(payload.path)).isSymbolicLink()).toBe(
        kind === "symlink"
      );
      if (kind === "symlink") {
        expect(await readFile(foreign, "utf8")).toBe("preserve");
      }
    } finally {
      await rm(foreign, { force: true });
      if (kind === "symlink") {
        await unlink(payload.path);
      }
      await payload.cleanup();
    }
  }
});

/**
 * A terminal interrupt reaches the whole foreground process group. The launcher
 * stands in for `exec`, so it must outlive a command that handles SIGINT and then
 * report the command's own status, or the pane shell returns its prompt while the
 * command still runs outside the foreground group.
 */
test("the launcher waits through a group SIGINT that the command handles", async () => {
  const root = await mkdtemp(join(tmpdir(), "mux-env-signal-"));
  const payload = await stage({ FAKE_KEY: "fake-key" });
  try {
    const ready = join(root, "ready");
    const done = join(root, "done");
    const launcher = join(root, "launcher.ts");
    await writeFile(
      launcher,
      `import { runMuxEnvironment } from ${JSON.stringify(
        join(import.meta.dir, "../src/mux/private-environment.ts")
      )};\nprocess.exit(await runMuxEnvironment(process.argv[2], process.argv.slice(3)));\n`
    );
    const body = `const fs = require("node:fs"); process.on("SIGINT", () => {}); fs.writeFileSync(${JSON.stringify(
      ready
    )}, ""); setTimeout(() => { fs.writeFileSync(${JSON.stringify(
      done
    )}, ""); process.exit(7); }, 1500);`;
    const group = spawn(
      process.execPath,
      [launcher, payload.path, process.execPath, "--eval", body],
      { detached: true, stdio: "ignore" }
    );
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) =>
        group.once("exit", (code, signal) => resolve({ code, signal }))
    );
    const deadline = Date.now() + 20_000;
    while (!(await Bun.file(ready).exists())) {
      if (Date.now() > deadline) {
        throw new Error("command never started");
      }
      await Bun.sleep(25);
    }
    process.kill(-(group.pid ?? 0), "SIGINT");
    const result = await exited;
    expect(await Bun.file(done).exists()).toBe(true);
    expect(result).toEqual({ code: 7, signal: null });
  } finally {
    await payload.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

async function expire(path: string): Promise<void> {
  const old = (Date.now() - MUX_ENVIRONMENT_TTL_MS - 60_000) / 1000;
  await utimes(path, old, old);
}

test("an expired payload is refused and removed, never delivered (HACK-2165)", async () => {
  const payload = await stage({ FAKE_KEY: "synthetic-expired" });
  await expire(payload.path);
  expect(await runMuxEnvironment(payload.path, ["true"])).toBe(1);
  expect(await lstat(dirname(payload.path)).catch(() => null)).toBeNull();
});

test("the next staging sweeps payloads of sessions that never ran; recent ones stay (HACK-2165)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mux-env-sweep-"));
  try {
    const stale = await stageMuxEnvironment(
      { FAKE_KEY: "synthetic-stale" },
      { tmpDir: dir }
    );
    const recent = await stageMuxEnvironment(
      { FAKE_KEY: "synthetic-recent" },
      { tmpDir: dir }
    );
    await expire(dirname(stale.path));
    const found = await findStaleMuxEnvironments({ tmpDir: dir });
    expect(found.map((entry) => entry.root)).toEqual([dirname(stale.path)]);

    const next = await stageMuxEnvironment(
      { FAKE_KEY: "synthetic-next" },
      { tmpDir: dir }
    );
    const left = (await readdir(dir)).sort();
    expect(left).toEqual(
      [dirname(recent.path), dirname(next.path)]
        .map((path) => path.slice(path.lastIndexOf("/") + 1))
        .sort()
    );
    // A directory that changed identity is never removed.
    expect(await removeStaleMuxEnvironment(found[0]!)).toBe(false);
    await recent.cleanup();
    await next.cleanup();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
