import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  restoreUnsettledOwnedProcessListeners,
  withOwnedProcessListeners,
} from "./helpers/owned-process-listeners.ts";
import { isProcessOnceListener } from "./helpers/process-once-listeners.ts";

const PRELOAD = resolve(
  import.meta.dir,
  "helpers/global-state-guard-preload.ts"
);
const HELPER = resolve(import.meta.dir, "helpers/owned-process-listeners.ts");
const REGISTRY = resolve(import.meta.dir, "helpers/process-once-listeners.ts");
const owned: string[] = [];
afterEach(async () => {
  await Promise.all(
    owned.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function sameItems(left: readonly unknown[], right: readonly unknown[]) {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

test("saved listeners come back with their kind: a once listener as once, a persistent one as persistent", async () => {
  // The outer helper owns every SIGUSR2 listener of the shared process, so the
  // emits below reach only this test's listeners.
  await withOwnedProcessListeners("SIGUSR2", async () => {
    let onceCalls = 0;
    let persistentCalls = 0;
    const once = () => {
      onceCalls += 1;
    };
    const persistent = () => {
      persistentCalls += 1;
    };
    process.once("SIGUSR2", once);
    process.on("SIGUSR2", persistent);
    try {
      await withOwnedProcessListeners("SIGUSR2", () => {
        expect(process.listenerCount("SIGUSR2")).toBe(0);
      });
      expect(sameItems(process.listeners("SIGUSR2"), [once, persistent])).toBe(
        true
      );
      process.emit("SIGUSR2");
      process.emit("SIGUSR2");
      expect(onceCalls).toBe(1);
      expect(persistentCalls).toBe(2);
      expect(sameItems(process.listeners("SIGUSR2"), [persistent])).toBe(true);
    } finally {
      process.removeListener("SIGUSR2", once);
      process.removeListener("SIGUSR2", persistent);
    }
  });
});

test("an unsettled callback's saved listeners come back before it settles, and its late settlement adds none twice", async () => {
  const before = process.listeners("SIGUSR2");
  const saved = () => undefined;
  process.once("SIGUSR2", saved);
  const gate = Promise.withResolvers<void>();
  const pending = withOwnedProcessListeners("SIGUSR2", () => gate.promise);
  try {
    expect(process.listenerCount("SIGUSR2")).toBe(0);
    // What the guard preload does after a test timed out in the helper.
    expect(restoreUnsettledOwnedProcessListeners()).toBe(1);
    expect(sameItems(process.listeners("SIGUSR2"), [...before, saved])).toBe(
      true
    );
    expect(isProcessOnceListener("SIGUSR2", saved)).toBe(true);
    expect(restoreUnsettledOwnedProcessListeners()).toBe(0);
    gate.resolve();
    await pending;
    expect(sameItems(process.listeners("SIGUSR2"), [...before, saved])).toBe(
      true
    );
  } finally {
    gate.resolve();
    process.removeListener("SIGUSR2", saved);
  }
});

// A file whose first test times out inside the helper while a `once` listener
// it does not own (registered by the file's hooks) is saved. The second test
// needs that listener back, still a `once` listener.
const TIMED_OUT = `import { afterAll, beforeAll, expect, test } from "bun:test";
import { withOwnedProcessListeners } from ${JSON.stringify(HELPER)};
import { isProcessOnceListener } from ${JSON.stringify(REGISTRY)};
const foreign = () => undefined;
beforeAll(() => {
  process.once("SIGUSR2", foreign);
});
afterAll(() => {
  process.removeListener("SIGUSR2", foreign);
});
test("times out while it owns SIGUSR2", async () => {
  await withOwnedProcessListeners("SIGUSR2", () => new Promise(() => {}));
}, 200);
test("finds the saved once listener back", () => {
  expect(process.listeners("SIGUSR2")).toEqual([foreign]);
  expect(isProcessOnceListener("SIGUSR2", foreign)).toBe(true);
  console.log("SAVED-LISTENER-BACK");
});
`;

async function runTimedOutSuite(preload: boolean) {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "hack-owned-listeners-"))
  );
  owned.push(dir);
  const suite = join(dir, "suite");
  const home = join(dir, "home");
  await mkdir(suite);
  await mkdir(home);
  await writeFile(
    join(suite, "bunfig.toml"),
    preload ? `[test]\npreload = [${JSON.stringify(PRELOAD)}]\n` : ""
  );
  await writeFile(join(suite, "timed-out.test.ts"), TIMED_OUT);
  const child = Bun.spawn([process.execPath, "test", "./timed-out.test.ts"], {
    cwd: suite,
    env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: dir, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

test.each([
  ["with the guard preload", true],
  ["without it", false],
] as const)(
  "a test that times out inside the helper hands the saved listeners back %s",
  async (_, preload) => {
    const run = await runTimedOutSuite(preload);
    expect(run.code).not.toBe(0);
    expect(run.output).toContain("(fail) times out while it owns SIGUSR2");
    expect(run.output).toContain("SAVED-LISTENER-BACK");
    expect(run.output).toContain("(pass) finds the saved once listener back");
    // The guard compares after the restore, so the timed-out test is charged
    // only with its timeout, not with removing another file's listener.
    expect(run.output).not.toContain("a test in timed-out.test.ts left");
  },
  60_000
);
