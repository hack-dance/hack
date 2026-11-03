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
  MuxCommandDeadlineError,
  stopLifecycleProcessController,
} from "../src/lib/project-lifecycle-controller.ts";
import { createSharedHelperSessionOwnership } from "../src/lib/project-shared-helpers.ts";
import type {
  MuxBackend,
  MuxSession,
  MuxSessionCreateResult,
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
  /** createSession never settles until completeHungCreate() is called. */
  hangCreate: boolean;
  /** readLifecycleOwnerToken never settles (outcome unknown). */
  hangToken: boolean;
  completeHungCreate: () => void;
};

function fakeMux(): FakeMux {
  const sessions = new Map<string, string>();
  const session = (name: string): MuxSession => ({
    backend: "zellij",
    name,
    attached: false,
    path: null,
    windows: 1,
    createdAt: null,
  });
  let pendingCreate: (() => void) | null = null;
  const hungCalls: Promise<unknown>[] = [];
  const fake: FakeMux = {
    name: "zellij",
    available: true,
    sessions,
    failKill: false,
    hangCreate: false,
    hangToken: false,
    completeHungCreate: () => pendingCreate?.(),
    listSessions: () =>
      Promise.resolve([...sessions.keys()].map((name) => session(name))),
    createSession: (opts): Promise<MuxSessionCreateResult> => {
      if (fake.hangCreate) {
        // A hung tmux/zellij: the session appears only if the command
        // eventually completes, after the caller stopped waiting.
        const hung = new Promise<MuxSessionCreateResult>(() => {
          pendingCreate = () => {
            sessions.set(opts.name, opts.lifecycleOwnerToken ?? "");
          };
        });
        // Keep the hung call reachable, like a real stuck subprocess.
        hungCalls.push(hung);
        return hung;
      }
      if (sessions.has(opts.name)) {
        return Promise.resolve({ ok: false, error: "session exists" });
      }
      sessions.set(opts.name, opts.lifecycleOwnerToken ?? "");
      return Promise.resolve({ ok: true, session: session(opts.name) });
    },
    killSession: (opts) => {
      if (fake.failKill) {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "busy" });
      }
      sessions.delete(opts.name);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    },
    readLifecycleOwnerToken: (opts) =>
      fake.hangToken
        ? (() => {
            const hung = new Promise<string | null>(() => undefined);
            hungCalls.push(hung);
            return hung;
          })()
        : Promise.resolve(sessions.get(opts.name) ?? null),
    readSessionPresence: (opts) =>
      Promise.resolve(sessions.has(opts.name) ? "present" : "absent"),
    listSessionWindowNames: () => Promise.resolve(new Set(["helper-client"])),
    execInSession: () =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    sendInput: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  };
  return fake;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-lifecycle-ownership-"));
  roots.push(root);
  const projectDir = join(root, ".hack");
  await mkdir(projectDir, { recursive: true });
  const mux = fakeMux();
  // A stand-in zellij for process starts (`zellij --session ... run`).
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "zellij"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const resolvedMux = () =>
    Promise.resolve({
      mode: "zellij" as const,
      backends: new Map([["zellij" as const, mux as MuxBackend]]),
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

test("a hung session creation releases the instance lock within its bound and stays reclaimable", async () => {
  const { mux, controller, entries, stop, newOwnership } = await fixture();
  mux.hangCreate = true;
  mux.hangToken = true;
  const a = controller({
    sessionOwnership: newOwnership(),
    muxCommandTimeoutMs: 200,
  });
  // Self-bounded: without the deadline the creation would never settle.
  const outcome = await Promise.race([
    a.startMany({ processes: [PROCESS] }).then(
      () => "started",
      (error: unknown) => error
    ),
    Bun.sleep(5000).then(() => "creation did not settle"),
  ]);
  expect(outcome).toBeInstanceOf(MuxCommandDeadlineError);
  // The lock is free again: another start can take it at once.
  const free = newOwnership();
  await expect(
    Promise.race([
      free.withLock(() => Promise.resolve("acquired")),
      Bun.sleep(2000).then(() => "still-held"),
    ])
  ).resolves.toBe("acquired");
  // The outcome is unknown, so the pending entry and token are kept.
  const kept = await entries();
  expect(kept).toHaveLength(1);
  expect(a.getOperationCleanup()).not.toBeNull();
  // The hung command completes later: the session carries the kept token,
  // so hack down can still reclaim it.
  mux.completeHungCreate();
  mux.hangToken = false;
  expect(mux.sessions.get(SESSION)).toBe(kept[0]?.ownershipToken);
  await stop();
  expect(mux.sessions.has(SESSION)).toBe(false);
  expect(await entries()).toEqual([]);
});
