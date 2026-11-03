import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLifecycleState,
  upsertLifecycleStateEntry,
} from "../src/lib/lifecycle-runtime.ts";
import {
  createLifecycleProcessController,
  LifecycleSessionDisplacedError,
  stopLifecycleProcessController,
} from "../src/lib/project-lifecycle-controller.ts";
import { createSharedHelperSessionOwnership } from "../src/lib/project-shared-helpers.ts";
import {
  type MuxBackend,
  MuxCommandTimeoutError,
  type MuxSession,
  type MuxSessionCreateResult,
} from "../src/mux/mux-backend.ts";
import { setLoggerBackendOverride } from "../src/ui/logger.ts";

/**
 * Lifecycle-session creation for projects with shared helpers, driven
 * against the real controller with an in-memory mux backend:
 * - a failure after the session was created (including a failed session
 *   epoch record) never leaves a session without an ownership record;
 * - a start that decided to create, then lost to an overlapping start that
 *   created and finalized the session, refuses without touching the
 *   winner's entry, which stays reclaimable.
 */

const roots: string[] = [];

afterEach(async () => {
  setLoggerBackendOverride({ backend: null });
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const COMPOSE_PROJECT = "demo--branch-a";
const SESSION = "demo--lifecycle-branch-a";

type FakeMux = MuxBackend & {
  readonly sessions: Map<string, string>;
  failKill: boolean;
  /**
   * createSession times out (the backend kills the client and throws)
   * after the session was created server-side, or without creating it.
   */
  timeoutCreate: "created" | "not-created" | null;
  /** readLifecycleOwnerToken times out. */
  timeoutToken: boolean;
  /** listSessions times out. */
  timeoutList: boolean;
  /** This token read (1-based) stalls, then returns the value read at call time. */
  stallTokenRead: number;
  tokenReads: number;
  readonly killed: string[];
  /** Mux calls still running: a bounded call must settle before return. */
  inFlight: number;
};

const TIMEOUT_DELAY_MS = 50;
/** Long enough that an overlapping start could finish meanwhile. */
const STALLED_READ_MS = 1500;

function fakeMux(backendName: "zellij" | "tmux" = "zellij"): FakeMux {
  const sessions = new Map<string, string>();
  const session = (name: string): MuxSession => ({
    backend: backendName,
    name,
    attached: false,
    path: null,
    windows: 1,
    createdAt: null,
  });
  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    fake.inFlight += 1;
    try {
      return await work();
    } finally {
      fake.inFlight -= 1;
    }
  };
  const fake: FakeMux = {
    name: backendName,
    available: true,
    sessions,
    failKill: false,
    timeoutCreate: null,
    timeoutToken: false,
    timeoutList: false,
    stallTokenRead: 0,
    tokenReads: 0,
    killed: [],
    inFlight: 0,
    listSessions: () =>
      track(async () => {
        if (fake.timeoutList) {
          await Bun.sleep(TIMEOUT_DELAY_MS);
          throw new MuxCommandTimeoutError(["zellij", "list-sessions"]);
        }
        return [...sessions.keys()].map((name) => session(name));
      }),
    createSession: (opts): Promise<MuxSessionCreateResult> =>
      track(async () => {
        if (fake.timeoutCreate) {
          if (fake.timeoutCreate === "created") {
            sessions.set(opts.name, opts.lifecycleOwnerToken ?? "");
          }
          await Bun.sleep(TIMEOUT_DELAY_MS);
          throw new MuxCommandTimeoutError(["zellij", "attach"]);
        }
        if (sessions.has(opts.name)) {
          return { ok: false, error: "session exists" };
        }
        sessions.set(opts.name, opts.lifecycleOwnerToken ?? "");
        return { ok: true, session: session(opts.name) };
      }),
    killSession: (opts) =>
      track(() => {
        if (fake.failKill) {
          return Promise.resolve({ exitCode: 1, stdout: "", stderr: "busy" });
        }
        fake.killed.push(sessions.get(opts.name) ?? "");
        sessions.delete(opts.name);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }),
    readLifecycleOwnerToken: (opts) =>
      track(async () => {
        if (fake.timeoutToken) {
          await Bun.sleep(TIMEOUT_DELAY_MS);
          throw new MuxCommandTimeoutError(["zellij", "show"]);
        }
        const value = sessions.get(opts.name) ?? null;
        fake.tokenReads += 1;
        if (fake.tokenReads === fake.stallTokenRead) {
          await Bun.sleep(STALLED_READ_MS);
        }
        return value;
      }),
    readSessionPresence: (opts) =>
      Promise.resolve(sessions.has(opts.name) ? "present" : "absent"),
    listSessionWindowNames: () => Promise.resolve(new Set(["helper-client"])),
    execInSession: () =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    sendInput: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  };
  return fake;
}

async function fixture(backendName: "zellij" | "tmux" = "zellij") {
  const root = await mkdtemp(join(tmpdir(), "hack-lifecycle-ownership-"));
  roots.push(root);
  const projectDir = join(root, ".hack");
  await mkdir(projectDir, { recursive: true });
  const mux = fakeMux(backendName);
  // A stand-in zellij for process starts (`zellij --session ... run`).
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "zellij"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // A stand-in tmux whose set-environment hangs (a stuck tmux server).
  await writeFile(
    join(bin, "tmux"),
    '#!/bin/sh\ncase "$1" in set-environment) sleep 30 ;; esac\nexit 0\n',
    { mode: 0o755 }
  );
  const resolvedMux = () =>
    Promise.resolve({
      mode: backendName,
      backends: new Map([[backendName, mux as MuxBackend]]),
    });
  const ownership = createSharedHelperSessionOwnership({
    composeProject: COMPOSE_PROJECT,
    hackDir: join(root, "hack-home"),
    decisionTimeoutMs: 5000,
  });
  const controller = (opts: {
    readonly sessionOwnership: Parameters<
      typeof createLifecycleProcessController
    >[0]["sessionOwnership"];
    readonly prepareLaunch?: () => Promise<void>;
    readonly muxCommandTimeoutMs?: number;
  }) =>
    createLifecycleProcessController({
      mux: resolvedMux,
      project: { projectRoot: root, projectDir },
      projectName: "demo",
      branch: "branch-a",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
      ...(opts.muxCommandTimeoutMs
        ? { muxCommandTimeoutMs: opts.muxCommandTimeoutMs }
        : {}),
      composeProject: COMPOSE_PROJECT,
      definitionHash: "sha256:test",
      ...(opts.sessionOwnership
        ? { sessionOwnership: opts.sessionOwnership }
        : {}),
      installSignalCleanup: () => ({ dispose: () => undefined }),
      ...(opts.prepareLaunch
        ? {
            prepareLaunch: async () => {
              await opts.prepareLaunch?.();
              return { command: "true", started: () => Promise.resolve() };
            },
          }
        : {}),
    });
  const entries = async () =>
    (await readLifecycleState({ projectDir })).filter(
      (entry) => entry.composeProject === COMPOSE_PROJECT
    );
  // hack down's stop path, against the same backend.
  const stop = () =>
    stopLifecycleProcessController({
      project: { projectRoot: root, projectDir },
      definitionHash: "sha256:test",
      projectName: "demo",
      branch: "branch-a",
      composeProject: COMPOSE_PROJECT,
      mux: resolvedMux,
    });
  const newOwnership = () =>
    createSharedHelperSessionOwnership({
      composeProject: COMPOSE_PROJECT,
      hackDir: join(root, "hack-home"),
      decisionTimeoutMs: 5000,
    });
  return {
    root,
    bin,
    projectDir,
    mux,
    ownership,
    controller,
    entries,
    stop,
    newOwnership,
  };
}

const PROCESS = { name: "helper-client", command: "sleep 600" };

test("a failed session epoch record stops the created session before removing its entry", async () => {
  const { mux, ownership, controller, entries } = await fixture();
  const starter = controller({
    sessionOwnership: {
      withLock: ownership.withLock,
      record: (kind) =>
        kind === "created"
          ? Promise.reject(new Error("epoch record unwritable"))
          : ownership.record(kind),
    },
  });
  await expect(starter.startMany({ processes: [PROCESS] })).rejects.toThrow(
    "epoch record unwritable"
  );
  // Never a live session without an ownership record.
  expect(mux.sessions.has(SESSION)).toBe(false);
  expect(await entries()).toEqual([]);
  expect(starter.getOperationCleanup()).toBeNull();
});

test("when that stop is not confirmed, the entry and token stay so the session is reclaimable", async () => {
  const { mux, ownership, controller, entries } = await fixture();
  mux.failKill = true;
  const starter = controller({
    sessionOwnership: {
      withLock: ownership.withLock,
      record: (kind) =>
        kind === "created"
          ? Promise.reject(new Error("epoch record unwritable"))
          : ownership.record(kind),
    },
  });
  await expect(starter.startMany({ processes: [PROCESS] })).rejects.toThrow(
    "epoch record unwritable"
  );
  const token = mux.sessions.get(SESSION);
  expect(token).toBeDefined();
  const kept = await entries();
  expect(kept.map((entry) => entry.ownershipToken)).toEqual([token]);
  // The caller's cleanup path (startLifecycleProcesses aborts on failure)
  // must not drop the record while the stop is still unconfirmed.
  expect(starter.getOperationCleanup()).not.toBeNull();
  await starter.abort();
  expect(mux.sessions.get(SESSION)).toBe(token);
  expect((await entries()).map((entry) => entry.ownershipToken)).toEqual([
    token,
  ]);
  // Once the session can be stopped, the kept token reclaims it.
  mux.failKill = false;
  await starter.abort();
  expect(mux.sessions.has(SESSION)).toBe(false);
  expect(await entries()).toEqual([]);
});

test("a start that decided to create refuses after an overlapping start created and finalized the session", async () => {
  const { projectDir, mux, ownership, controller, entries } = await fixture();
  let resume = (): void => undefined;
  const paused = new Promise<void>((resolvePause) => {
    resume = resolvePause;
  });
  let reachedPause = (): void => undefined;
  const atPause = new Promise<void>((resolveAt) => {
    reachedPause = resolveAt;
  });
  // A: decides the session is absent, then pauses before creating it.
  const a = controller({
    sessionOwnership: ownership,
    prepareLaunch: async () => {
      reachedPause();
      await paused;
    },
  });
  const aStart = a.startMany({ processes: [PROCESS] });
  await atPause;
  // B: creates the session and finalizes its lifecycle entry meanwhile.
  const bOwnership = createSharedHelperSessionOwnership({
    composeProject: COMPOSE_PROJECT,
    hackDir: join(projectDir, "..", "hack-home"),
    decisionTimeoutMs: 5000,
  });
  await bOwnership.withLock(async () => {
    await mux.createSession({ name: SESSION, lifecycleOwnerToken: "token-b" });
    await upsertLifecycleStateEntry({
      projectDir,
      entry: {
        composeProject: COMPOSE_PROJECT,
        projectName: "demo",
        branch: "branch-a",
        sessionName: SESSION,
        backend: "zellij",
        ownershipToken: "token-b",
        definitionHash: "sha256:test",
        processes: [
          {
            name: "helper-client",
            windowName: "helper-client",
            logPath: join(projectDir, "lifecycle.log"),
          },
        ],
        updatedAt: new Date().toISOString(),
      },
    });
    await bOwnership.record("created");
  });
  resume();
  await expect(aStart).rejects.toThrow("changed lifecycle session");
  // B's session stays live and owned by B's persisted entry (reclaimable).
  expect(mux.sessions.get(SESSION)).toBe("token-b");
  expect((await entries()).map((entry) => entry.ownershipToken)).toEqual([
    "token-b",
  ]);
  // A published nothing and keeps no cleanup authority over B's session.
  expect(a.getOperationCleanup()).toBeNull();
  await a.abort();
  expect(mux.sessions.get(SESSION)).toBe("token-b");
});

test("a start displaced after creating its session, before finalizing, leaves the replacement owned and reclaimable", async () => {
  const { mux, controller, entries, stop, newOwnership } = await fixture();
  // A creates its session and starts a persistent up.before process, then
  // waits in a later foreground hook (its entry is still pending).
  const a = controller({ sessionOwnership: newOwnership() });
  await a.startFromCommand({
    command: { command: "sleep 600", persistent: true },
    serviceName: "persistent-hook",
  });
  const tokenA = mux.sessions.get(SESSION);
  expect(tokenA).toBeDefined();
  expect((await entries())[0]?.processes).toEqual([]);
  // B sees an owned stale (pending) session, replaces it, creates its own
  // and finalizes.
  const b = controller({ sessionOwnership: newOwnership() });
  await b.startMany({ processes: [PROCESS] });
  await b.finalize();
  const tokenB = mux.sessions.get(SESSION);
  expect(tokenB).toBeDefined();
  expect(tokenB).not.toBe(tokenA);
  // A resumes and finalizes: it must not publish over B's entry.
  await expect(a.finalize()).rejects.toBeInstanceOf(
    LifecycleSessionDisplacedError
  );
  expect((await entries()).map((entry) => entry.ownershipToken)).toEqual([
    tokenB,
  ]);
  // A gave up its authority: its abort leaves B's session alone.
  expect(a.getOperationCleanup()).toBeNull();
  await a.abort();
  expect(mux.sessions.get(SESSION)).toBe(tokenB);
  // hack down reclaims B through the persisted entry.
  await stop();
  expect(mux.sessions.has(SESSION)).toBe(false);
  expect(await entries()).toEqual([]);
});

test("a timed-out session creation settles before the lock is released and its outcome stays reclaimable", async () => {
  const { mux, controller, entries, stop, newOwnership } = await fixture();
  // The backend killed the timed-out client after the server created the
  // session; the follow-up token read times out too (outcome unknown).
  mux.timeoutCreate = "created";
  mux.timeoutToken = true;
  const a = controller({ sessionOwnership: newOwnership() });
  await expect(a.startMany({ processes: [PROCESS] })).rejects.toBeInstanceOf(
    MuxCommandTimeoutError
  );
  // Nothing of A's is still running: no completion can arrive after another
  // command takes the lock.
  expect(mux.inFlight).toBe(0);
  const free = newOwnership();
  await expect(
    Promise.race([
      free.withLock(() => Promise.resolve("acquired")),
      Bun.sleep(2000).then(() => "still-held"),
    ])
  ).resolves.toBe("acquired");
  // Unknown outcome: the pending entry and token are kept, matching the live
  // session, so hack down reclaims it.
  const kept = await entries();
  expect(kept).toHaveLength(1);
  expect(mux.sessions.get(SESSION)).toBe(kept[0]?.ownershipToken);
  expect(a.getOperationCleanup()).not.toBeNull();
  mux.timeoutToken = false;
  await stop();
  expect(mux.sessions.has(SESSION)).toBe(false);
  expect(await entries()).toEqual([]);
});

test("after a timed-out creation that created nothing, a later down and up see no late session", async () => {
  const { mux, controller, entries, stop, newOwnership } = await fixture();
  mux.timeoutCreate = "not-created";
  const a = controller({ sessionOwnership: newOwnership() });
  await expect(a.startMany({ processes: [PROCESS] })).rejects.toBeInstanceOf(
    MuxCommandTimeoutError
  );
  expect(mux.inFlight).toBe(0);
  // Settled and proven absent: the pending entry is retired.
  expect(await entries()).toEqual([]);
  mux.timeoutCreate = null;
  // A down, then another up, find a consistent instance; no late creation
  // of A's can appear underneath them.
  await stop();
  const b = controller({ sessionOwnership: newOwnership() });
  await b.startMany({ processes: [PROCESS] });
  await b.finalize();
  const tokenB = mux.sessions.get(SESSION);
  expect((await entries()).map((entry) => entry.ownershipToken)).toEqual([
    tokenB,
  ]);
  await a.abort();
  expect(mux.sessions.get(SESSION)).toBe(tokenB);
  await stop();
  expect(mux.sessions.has(SESSION)).toBe(false);
});

test("a stalled replacement holds the lock until it settles, so an overlapping up never loses its session to it", async () => {
  const { projectDir, mux, controller, entries, stop, newOwnership } =
    await fixture();
  // A stale pending session from a crashed start.
  mux.sessions.set(SESSION, "token-x");
  await upsertLifecycleStateEntry({
    projectDir,
    entry: {
      composeProject: COMPOSE_PROJECT,
      projectName: "demo",
      branch: "branch-a",
      sessionName: SESSION,
      backend: "zellij",
      ownershipToken: "token-x",
      definitionHash: "sha256:test",
      processes: [],
      updatedAt: new Date().toISOString(),
    },
  });
  // A's replacement stalls in its kill's ownership-token read (read 2; read
  // 1 is A's inspection): the read returns the token from when it started.
  // B starts meanwhile.
  mux.stallTokenRead = 2;
  const a = controller({ sessionOwnership: newOwnership() });
  const b = controller({ sessionOwnership: newOwnership() });
  const aRun = a.startMany({ processes: [PROCESS] }).then(() => a.finalize());
  await Bun.sleep(50);
  const bRun = b.startMany({ processes: [PROCESS] }).then(() => b.finalize());
  await Promise.allSettled([aRun, bRun]);
  expect(mux.inFlight).toBe(0);
  // Whichever start finished last owns a live session with a matching
  // entry; no stale continuation killed it or removed its entry.
  const live = mux.sessions.get(SESSION);
  expect(live).toBeDefined();
  expect((await entries()).map((entry) => entry.ownershipToken)).toEqual([
    live,
  ]);
  expect(mux.killed.filter((token) => token !== "token-x")).not.toContain(live);
  await stop();
  expect(mux.sessions.has(SESSION)).toBe(false);
  expect(await entries()).toEqual([]);
});

test("a timed-out session listing is unknown, never absence: up and down leave a healthy owned session alone", async () => {
  const { mux, controller, entries, stop, newOwnership } = await fixture();
  const owner = controller({ sessionOwnership: newOwnership() });
  await owner.startMany({ processes: [PROCESS] });
  await owner.finalize();
  const token = mux.sessions.get(SESSION);
  const before = await entries();
  mux.timeoutList = true;
  const other = controller({ sessionOwnership: newOwnership() });
  await expect(
    other.startMany({ processes: [PROCESS] })
  ).rejects.toBeInstanceOf(MuxCommandTimeoutError);
  await expect(stop()).rejects.toBeInstanceOf(MuxCommandTimeoutError);
  expect(mux.sessions.get(SESSION)).toBe(token);
  expect(await entries()).toEqual(before);
  mux.timeoutList = false;
  await stop();
  expect(mux.sessions.has(SESSION)).toBe(false);
});

test("SIGTERM during tmux environment setup settles within the mux bound", async () => {
  const { bin, mux, controller, entries } = await fixture("tmux");
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  try {
    const a = controller({
      sessionOwnership: undefined,
      muxCommandTimeoutMs: 300,
    });
    const start = a.startMany({ processes: [PROCESS] }).then(
      () => "started",
      (error: unknown) => error
    );
    // Wait until the session exists and set-environment is hanging.
    while (!mux.sessions.has(SESSION)) {
      await Bun.sleep(10);
    }
    const cleanup = a.getOperationCleanup();
    expect(cleanup).not.toBeNull();
    // The signal cleanup waits for session creation to settle; it must not
    // wait on the stuck tmux command forever.
    const settled = await Promise.race([
      (cleanup?.() ?? Promise.resolve()).then(() => "settled"),
      Bun.sleep(5000).then(() => "still waiting"),
    ]);
    expect(settled).toBe("settled");
    expect(await start).toBeInstanceOf(MuxCommandTimeoutError);
    expect(mux.sessions.has(SESSION)).toBe(false);
    expect(await entries()).toEqual([]);
  } finally {
    process.env.PATH = originalPath;
  }
});
