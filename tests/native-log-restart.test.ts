import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasLogRestart,
  isNewLogContainer,
  publishLogRestart,
  resumeNativeLogs,
} from "../src/backends/native-log-restart.ts";

const previous = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  plan: "d".repeat(64),
  native: true,
  container: "1".repeat(64),
};
const next = {
  ...previous,
  run: "e".repeat(32),
  owner: "f".repeat(32),
  container: "2".repeat(64),
};
test("adopted restore can retain run and owner after its restart intent retires", async () => {
  const restored = { ...previous, native: false, container: next.container };
  expect(
    await resumeNativeLogs({
      previous: { ...previous, native: false },
      signal: new AbortController().signal,
      select: async () => restored,
      restarting: async () => {
        throw new Error("retired intent must not be needed");
      },
    })
  ).toEqual(restored);
});
test("run or owner changes cannot replay a container, and backend changes cannot reattach", () => {
  expect(
    isNewLogContainer(previous, { ...next, container: previous.container })
  ).toBe(false);
  expect(isNewLogContainer(previous, { ...next, native: false })).toBe(false);
  expect(isNewLogContainer(previous, { ...next, container: undefined })).toBe(
    false
  );
  expect(isNewLogContainer({ ...previous, container: undefined }, next)).toBe(
    false
  );
});
test("restart uses fresh admission, tolerates missing mapping during stop, and accepts a new owner", async () => {
  let calls = 0;
  expect(
    await resumeNativeLogs({
      previous,
      signal: new AbortController().signal,
      select: async () => {
        if (++calls < 3) {
          throw new Error("not Ready");
        }
        return next;
      },
      restarting: async () => true,
      timeoutMs: 100,
      intervalMs: 1,
    })
  ).toEqual(next);
});
test("down does not enter the restart wait and an unchanged container is never replayed", async () => {
  let calls = 0;
  expect(
    await resumeNativeLogs({
      previous,
      signal: new AbortController().signal,
      select: async () => {
        calls++;
        return previous;
      },
      restarting: async () => false,
    })
  ).toBeNull();
  expect(calls).toBe(1);
  await expect(
    resumeNativeLogs({
      previous,
      signal: new AbortController().signal,
      select: async () => previous,
      restarting: async () => true,
      timeoutMs: 5,
      intervalMs: 1,
    })
  ).rejects.toMatchObject({ reason: "native_log_restart_unavailable" });
});
test("restart wait refuses a foreign namespace and responds to cancellation", async () => {
  await expect(
    resumeNativeLogs({
      previous,
      signal: new AbortController().signal,
      select: async () => ({ ...next, namespace: "wrong" }),
      restarting: async () => true,
      timeoutMs: 5,
      intervalMs: 1,
    })
  ).rejects.toMatchObject({ reason: "native_log_restart_unavailable" });
  const controller = new AbortController();
  await expect(
    resumeNativeLogs({
      previous,
      signal: controller.signal,
      select: async () => previous,
      restarting: async () => {
        controller.abort();
        return true;
      },
    })
  ).rejects.toThrow();
});
test("authored restart notice is scoped, readable during stop, and retired on completion", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "log-restart-")));
  const scope = { nativeHome: root, projectRoot: root, branch: null };
  try {
    expect(await hasLogRestart(scope)).toBe(false);
    const retire = await publishLogRestart(scope);
    expect(await hasLogRestart(scope)).toBe(true);
    expect(await hasLogRestart({ ...scope, branch: "other" })).toBe(false);
    await retire();
    expect(await hasLogRestart(scope)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read admission cannot exceed the restart deadline", async () => {
  await expect(
    resumeNativeLogs({
      previous,
      signal: new AbortController().signal,
      select: () => new Promise(() => undefined),
      restarting: async () => true,
      timeoutMs: 20,
    })
  ).rejects.toMatchObject({ reason: "native_log_restart_unavailable" });
}, 1000);

test("advisory publication and retirement failures do not fail the lifecycle, and stale notices expire", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "log-restart-")));
  const scope = { nativeHome: root, projectRoot: root, branch: null };
  const { readdir, writeFile, chmod } = await import("node:fs/promises");
  try {
    const unavailable = await publishLogRestart({
      ...scope,
      nativeHome: join(root, "absent"),
    });
    await unavailable();
    const retire = await publishLogRestart(scope);
    const directory = join(root, "log-restart-notices");
    const [name] = await readdir(directory);
    const path = join(directory, name ?? "missing");
    await writeFile(
      path,
      JSON.stringify({ version: 1, token: "stale", createdAt: 0 }),
      { mode: 0o600 }
    );
    expect(await hasLogRestart(scope)).toBe(false);
    await chmod(path, 0o644);
    expect(await hasLogRestart(scope)).toBe(false);
    await retire(); // Unsafe/malformed notice cannot replace restart's result.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a restart notice covers a slow stop plus the bounded reattach window", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "log-restart-")));
  const scope = { nativeHome: root, projectRoot: root, branch: null };
  const { readdir, readFile, writeFile } = await import("node:fs/promises");
  try {
    await publishLogRestart(scope, 90_000);
    const directory = join(root, "log-restart-notices");
    const [name] = await readdir(directory);
    const path = join(directory, name ?? "missing");
    const marker = JSON.parse(await readFile(path, "utf8"));
    expect(marker.expiresAt - marker.createdAt).toBe(90_000);
    marker.createdAt -= 40_000;
    marker.expiresAt -= 40_000;
    await writeFile(path, JSON.stringify(marker));
    expect(await hasLogRestart(scope)).toBe(true);
    marker.expiresAt = Date.now() - 1;
    await writeFile(path, JSON.stringify(marker));
    expect(await hasLogRestart(scope)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
