import { expect, test } from "bun:test";
import { reportManualAutostartSkip } from "../src/commands/daemon.ts";
import {
  createLoginAutostart,
  isLoginServiceAutostart,
} from "../src/daemon/login-autostart.ts";
import type { RegisteredProject } from "../src/lib/projects-registry.ts";

async function flushWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("only an explicit login-service origin permits automatic project replay", async () => {
  expect(isLoginServiceAutostart({ env: {} })).toBe(false);
  expect(
    isLoginServiceAutostart({ env: { HACK_DAEMON_LOGIN_SERVICE: "1" } })
  ).toBe(true);
  expect(
    isLoginServiceAutostart({ env: { HACK_DAEMON_LOGIN_SERVICE: "true" } })
  ).toBe(false);
  expect(
    isLoginServiceAutostart({
      env: {
        HACK_DAEMON_LOGIN_SERVICE: "1",
        HACK_DAEMON_AUTOSTART_DISABLE: "1",
      },
    })
  ).toBe(false);
  let runs = 0;
  const replay = createLoginAutostart({
    enabled: false,
    run: async () => {
      runs += 1;
      return { waitingForEngine: false };
    },
    onError: () => {
      throw new Error("unexpected");
    },
  });
  replay.start();
  replay.observeEngine(true);
  await replay.stop();
  expect(runs).toBe(0);
});

test("a service retries an unclaimed engine wait once availability is observed, without overlapping", async () => {
  const first = Promise.withResolvers<{ waitingForEngine: boolean }>();
  const second = Promise.withResolvers<{ waitingForEngine: boolean }>();
  let runs = 0;
  const replay = createLoginAutostart({
    enabled: true,
    run: () => {
      runs += 1;
      return runs === 1 ? first.promise : second.promise;
    },
    onError: () => {
      throw new Error("unexpected");
    },
  });
  replay.observeEngine(true);
  expect(runs).toBe(0);
  replay.start();
  replay.start();
  replay.observeEngine(true);
  expect(runs).toBe(1);
  first.resolve({ waitingForEngine: true });
  await flushWork();
  replay.observeEngine(false);
  expect(runs).toBe(1);
  replay.observeEngine(true);
  replay.observeEngine(true);
  expect(runs).toBe(2);
  second.resolve({ waitingForEngine: false });
  await flushWork();
  replay.observeEngine(true);
  expect(runs).toBe(2);
  await replay.stop();
  replay.observeEngine(true);
  expect(runs).toBe(2);
});

test("shutdown aborts and awaits the owned login pass", async () => {
  const settled = Promise.withResolvers<{ waitingForEngine: boolean }>();
  let signal: AbortSignal | undefined;
  const replay = createLoginAutostart({
    enabled: true,
    run: (value) => {
      signal = value;
      return settled.promise;
    },
    onError: () => {
      throw new Error("unexpected");
    },
  });
  replay.start();
  let stopped = false;
  const stop = replay.stop().then(() => {
    stopped = true;
  });
  await flushWork();
  expect(signal?.aborted).toBe(true);
  expect(stopped).toBe(false);
  settled.resolve({ waitingForEngine: true });
  await stop;
  expect(stopped).toBe(true);
});

test("manual start reports skipped login replay only for marked projects", async () => {
  const project: RegisteredProject = {
    id: "example-id",
    name: "example",
    repoRoot: "/example/project",
    projectDir: "/example/project/.hack",
    projectDirName: ".hack",
    createdAt: "2026-01-01T00:00:00Z",
    autostart: {
      branch: null,
      paused: false,
      lastResult: null,
      lastAttemptBootId: null,
    },
  };
  const notes: string[] = [];
  await reportManualAutostartSkip({
    env: {},
    readRegistry: async () => ({ version: 1, projects: [project] }),
    note: (message) => notes.push(message),
  });
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("did not run the login autostart pass");
  expect(notes[0]).toContain("hack autostart run --no-interactive");
  await reportManualAutostartSkip({
    env: {},
    readRegistry: async () => ({ version: 1, projects: [] }),
    note: (message) => notes.push(message),
  });
  await reportManualAutostartSkip({
    env: { HACK_DAEMON_LOGIN_SERVICE: "1" },
    readRegistry: async () => {
      throw new Error("service must not inspect markers for this notice");
    },
    note: (message) => notes.push(message),
  });
  expect(notes).toHaveLength(1);
});
