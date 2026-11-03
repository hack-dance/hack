import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type MuxBackend,
  type MuxBackendName,
  muxCommandTimeoutMs,
  runMuxCommand,
} from "../mux/mux-backend.ts";
import {
  getMuxBackends,
  type ResolvedMux,
  resolveDefaultBackendName,
} from "../mux/mux-resolver.ts";
import { buildLifecycleSessionName } from "../mux/session-names.ts";
import { logger } from "../ui/logger.ts";
import { ensureDir, readTextFile } from "./fs.ts";
import {
  appendLifecycleLogRecord,
  type LifecycleStateEntry,
  readLifecycleState,
  removeLifecycleStateEntry,
  removeLifecycleStateEntryIfOwned,
  resolveLifecycleLogPath,
  upsertLifecycleStateEntry,
} from "./lifecycle-runtime.ts";
import {
  type ProjectLifecycleCommand,
  type ProjectLifecycleProcess,
  sanitizeBranchSlug,
} from "./project.ts";
import {
  readProcessSnapshot,
  resolveLifecycleProcessGroupIdsForTmuxState,
  resolveLifecycleStopProcessGroupIds,
  terminateLifecycleProcessGroups,
} from "./project-lifecycle-processes.ts";
import {
  createLifecycleOwnershipToken,
  inspectLifecycleSession,
  killInspectedLifecycleSession,
  killLifecycleSessionWithOwnership,
  resolveLifecycleDefinitionHash,
  resolveLifecycleEnvironmentFingerprint,
} from "./project-lifecycle-sessions.ts";
import {
  inspectListeningTcpPorts,
  resolveLifecycleSingletonDecision,
} from "./project-lifecycle-singleton.ts";
import type { SharedHelperSessionOwnership } from "./project-shared-helpers.ts";
import { exec } from "./shell.ts";
export type LifecycleControllerProject = {
  readonly projectRoot: string;
  readonly projectDir: string;
};
type StartedLifecycleProcess = {
  readonly name: string;
  readonly windowName: string;
  readonly logPath: string;
  readonly panePid?: number;
  readonly processGroupId?: number;
};
/**
 * Cleanup for what an operation started. Resolves
 * {@link LIFECYCLE_SESSION_RETAINED} when a
 * session it created could not be confirmed stopped and was kept, with its
 * ownership record, for hack down; callers must then keep anything that
 * session depends on (such as shared helper holders).
 */
export type LifecycleOperationCleanup = () => Promise<unknown>;

/** The value an operation cleanup resolves to when it kept the session. */
export const LIFECYCLE_SESSION_RETAINED = "session-retained";
const LIFECYCLE_COMMAND_PID_WAIT_ATTEMPTS = 50;
const LIFECYCLE_COMMAND_PID_WAIT_INTERVAL_MS = 20;
export function resolveLifecycleSessionName(opts: {
  readonly projectName: string;
  readonly branch: string | null;
}): string {
  return buildLifecycleSessionName(opts);
}

export function resolveLifecycleCwd(opts: {
  readonly projectRoot: string;
  readonly cwd: string | undefined;
}): string {
  const raw = (opts.cwd ?? "").trim();
  if (raw.length === 0) {
    return opts.projectRoot;
  }
  if (raw.startsWith("/")) {
    return raw;
  }
  return resolve(opts.projectRoot, raw);
}

export function installLifecycleSignalCleanup(opts: {
  readonly cleanup: LifecycleOperationCleanup | null;
}): { readonly dispose: () => void } {
  if (!opts.cleanup) {
    return { dispose: () => undefined };
  }

  let handlingSignal = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const dispose = (): void => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
    handlers.clear();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      if (handlingSignal) {
        return;
      }
      handlingSignal = true;
      void opts.cleanup?.().finally(() => {
        dispose();
        process.kill(process.pid, signal);
      });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return { dispose };
}

async function reconcileChangedLifecycleBackend(opts: {
  readonly mux: ResolvedMux;
  readonly entry: LifecycleStateEntry | null;
  readonly resolvedBackend: MuxBackendName;
  readonly sessionName: string;
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly composeProject: string;
  readonly definitionHash: string;
}): Promise<LifecycleStateEntry | null> {
  if (!opts.entry || opts.entry.backend === opts.resolvedBackend) {
    return opts.entry;
  }
  const previousBackend = opts.mux.backends.get(opts.entry.backend);
  if (!previousBackend?.available) {
    throw new Error(
      `Lifecycle backend changed to ${opts.resolvedBackend}, but the owned ${opts.entry.backend} session cannot be inspected safely because ${opts.entry.backend} is unavailable.`
    );
  }
  const inspection = await inspectLifecycleSession({
    backend: previousBackend,
    entry: opts.entry,
    expectedSessionName: opts.sessionName,
    expectedProjectRoot: opts.projectRoot,
    expectedDefinitionHash: opts.definitionHash,
  });
  if (inspection.decision.kind === "block") {
    throw new Error(inspection.decision.reason);
  }
  if (
    inspection.classification !== "absent" &&
    !(await killInspectedLifecycleSession({
      backend: previousBackend,
      inspection,
    }))
  ) {
    throw new Error(
      `Failed to stop the owned ${opts.entry.backend} lifecycle session before switching to ${opts.resolvedBackend}.`
    );
  }
  await removeLifecycleStateEntry({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
  return null;
}

async function replaceInspectedLifecycleSession(opts: {
  readonly backend: MuxBackend;
  readonly inspection: Awaited<ReturnType<typeof inspectLifecycleSession>>;
  readonly sessionName: string;
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<void> {
  if (
    !(await killInspectedLifecycleSession({
      backend: opts.backend,
      inspection: opts.inspection,
    }))
  ) {
    throw new Error(
      `Failed to replace stale lifecycle session: ${opts.sessionName}`
    );
  }
  // Retire only the entry that was inspected (by its ownership token), never
  // whatever entry is current: another start may have published since.
  const inspected =
    opts.inspection.decision.kind === "replace"
      ? opts.inspection.decision.entry
      : null;
  if (inspected?.ownershipToken) {
    await removeLifecycleStateEntryIfOwned({
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
      ownershipToken: inspected.ownershipToken,
    });
    return;
  }
  await removeLifecycleStateEntry({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
}

/** Keep the mux diagnostic (for example tmux "duplicate session") visible. */
function describeSessionCreateFailure(opts: {
  readonly sessionName: string;
  readonly stderr?: string;
}): string {
  const detail = opts.stderr ? ` (${opts.stderr})` : "";
  return `Failed to create lifecycle session: ${opts.sessionName}${detail}`;
}

/** The shared Hack mux owner. Callers supply selection; this owner retains session/token checks. */
export function createLifecycleProcessController(opts: {
  readonly mux: () => Promise<ResolvedMux>;
  readonly project: LifecycleControllerProject;
  readonly projectName: string;
  readonly branch: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly composeProject: string;
  readonly definitionHash: string;
  /** Optional in-memory delivery, issued by the owning frontend. Legacy callers
   * keep their existing launch/environment path and signal cleanup unchanged. */
  readonly prepareLaunch?: (process: ProjectLifecycleProcess) => Promise<{
    readonly command: string;
    readonly started: (process: StartedLifecycleProcess) => Promise<void>;
  }>;
  readonly installSignalCleanup?: (opts: {
    readonly cleanup: LifecycleOperationCleanup;
  }) => { readonly dispose: () => void };
  readonly assertFresh?: () => Promise<void>;
  /**
   * Shared helper session ownership (projects with `sharedHelpers`). The
   * session decision (inspect, adopt or replace) and session creation run
   * under its lock and are recorded, so a creator's cleanup can tell whether
   * another start adopted the session; see SharedHelperSessionOwnership.
   */
  readonly sessionOwnership?: Pick<
    SharedHelperSessionOwnership,
    "withLock" | "record"
  >;
  /**
   * Bound for this controller's own tmux/zellij commands (environment setup,
   * window creation, process start). Backend calls use muxCommandTimeoutMs().
   * A timed-out command is killed, so the call settles; nothing keeps
   * mutating after the caller moves on.
   */
  readonly muxCommandTimeoutMs?: number;
}): {
  readonly sessionName: string;
  startFromCommand: (opts: {
    readonly command: ProjectLifecycleCommand;
    readonly serviceName: string;
  }) => Promise<void>;
  startMany: (opts: {
    readonly processes: readonly ProjectLifecycleProcess[];
  }) => Promise<void>;
  finalize: () => Promise<void>;
  /** Resolves LIFECYCLE_SESSION_RETAINED when the session was kept. */
  abort: () => Promise<undefined | typeof LIFECYCLE_SESSION_RETAINED>;
  hasStarted: () => boolean;
  getOperationCleanup: () => LifecycleOperationCleanup | null;
  getSignalCleanup: () => { readonly dispose: () => void } | null;
} {
  const sessionName = resolveLifecycleSessionName({
    projectName: opts.projectName,
    branch: opts.branch,
  });
  const startedProcesses: StartedLifecycleProcess[] = [];
  let backendName: MuxBackendName | null = null;
  let sessionReady = false;
  let sessionDispositionResolved = false;
  let createdOwnershipToken: string | null = null;
  let adoptedEntry: LifecycleStateEntry | null = null;
  let operationSignalCleanup: { readonly dispose: () => void } | null = null;
  let sessionCreationSettled: Promise<void> = Promise.resolve();
  let nextIndex = 0;
  const muxTimeoutMs = opts.muxCommandTimeoutMs ?? muxCommandTimeoutMs();

  const resolveSessionDisposition = async (): Promise<void> => {
    if (sessionDispositionResolved) {
      return;
    }
    const ownership = opts.sessionOwnership;
    if (!ownership) {
      await decideSessionDisposition();
      return;
    }
    await ownership.withLock(async () => {
      if ((await decideSessionDisposition()) === "adopted") {
        await ownership.record("adopted");
      }
    });
  };

  const decideSessionDisposition = async (): Promise<"adopted" | "create"> => {
    const mux = await opts.mux();
    const resolvedBackend = resolveDefaultBackendName({
      mode: mux.mode,
      backends: mux.backends,
    });
    if (!resolvedBackend) {
      throw new Error(
        [
          "No session mux backend available for lifecycle processes.",
          "Install tmux or zellij, or set sessions.mux to auto|tmux|zellij.",
        ].join("\n")
      );
    }
    const backend = mux.backends.get(resolvedBackend);
    if (!backend?.available) {
      throw new Error(`${resolvedBackend} is not available`);
    }
    const entries = await readLifecycleState({
      projectDir: opts.project.projectDir,
    });
    const persistedEntry =
      entries.find(
        (candidate) => candidate.composeProject === opts.composeProject
      ) ?? null;
    const entry = await reconcileChangedLifecycleBackend({
      mux,
      entry: persistedEntry,
      resolvedBackend,
      sessionName,
      projectRoot: opts.project.projectRoot,
      projectDir: opts.project.projectDir,
      composeProject: opts.composeProject,
      definitionHash: opts.definitionHash,
    });
    backendName = resolvedBackend;
    const inspection = await inspectLifecycleSession({
      backend,
      entry,
      expectedSessionName: sessionName,
      expectedProjectRoot: opts.project.projectRoot,
      expectedDefinitionHash: opts.definitionHash,
    });
    if (inspection.decision.kind === "block") {
      throw new Error(inspection.decision.reason);
    }
    if (inspection.decision.kind === "adopt") {
      adoptedEntry = inspection.decision.entry;
      startedProcesses.push(...inspection.decision.entry.processes);
      sessionReady = true;
      sessionDispositionResolved = true;
      return "adopted";
    }
    if (inspection.decision.kind === "replace") {
      await opts.assertFresh?.();
      await replaceInspectedLifecycleSession({
        backend,
        inspection,
        sessionName,
        projectDir: opts.project.projectDir,
        composeProject: opts.composeProject,
      });
    }
    sessionDispositionResolved = true;
    return "create";
  };

  const ensureSession = async (): Promise<void> => {
    await resolveSessionDisposition();
    if (sessionReady) {
      return;
    }
    const backend = backendName
      ? (await opts.mux()).backends.get(backendName)
      : null;
    if (!(backendName && backend?.available)) {
      throw new Error("Lifecycle mux backend became unavailable");
    }
    const ownershipToken = createLifecycleOwnershipToken();
    let settleSessionCreation = (): void => undefined;
    sessionCreationSettled = new Promise<void>((resolvePromise) => {
      settleSessionCreation = resolvePromise;
    });
    operationSignalCleanup = (
      opts.installSignalCleanup ?? installLifecycleSignalCleanup
    )({
      cleanup: starterAbort,
    });
    const pendingEntry: LifecycleStateEntry = {
      composeProject: opts.composeProject,
      projectName: opts.projectName,
      branch: opts.branch,
      sessionName,
      backend: backendName,
      ownershipToken,
      definitionHash: opts.definitionHash,
      processes: [],
      updatedAt: new Date().toISOString(),
    };
    // true: created; false: definitely not created; "unknown": the create
    // call did not settle within its deadline or failed without a result.
    let sessionCreated: boolean | "unknown" = false;
    // Revalidate, publish pending ownership, create and record as one
    // transition. With shared helper ownership it runs under the instance
    // lock, so an overlapping start cannot create the session (and finalize
    // its entry) between this start's decision and its publication.
    const createOwnedSession = async (): Promise<void> => {
      if (opts.sessionOwnership) {
        await assertSessionStillAbsent(backend);
      }
      createdOwnershipToken = ownershipToken;
      // Persist ownership before creating the mux session. If the CLI is
      // SIGKILLed after session creation, the next up can still prove that
      // the empty session belongs to this Compose instance and replace it.
      await upsertLifecycleStateEntry({
        projectDir: opts.project.projectDir,
        entry: pendingEntry,
      });
      await opts.assertFresh?.();
      sessionCreated = "unknown";
      // Bounded by the backend: the call settles (a timed-out client is
      // killed) before this transaction releases the lock, so no creation
      // can complete after another command takes the lock.
      const created = await backend.createSession({
        name: sessionName,
        cwd: opts.project.projectRoot,
        lifecycleOwnerToken: ownershipToken,
      });
      if (!created.ok) {
        // A failed (possibly killed) create may still have created the
        // session: the ownership-token check decides, not this result.
        throw new Error(
          describeSessionCreateFailure({ sessionName, stderr: created.stderr })
        );
      }
      sessionCreated = true;
      await opts.sessionOwnership?.record("created");
    };
    // Environment setup and failed-creation cleanup belong to the same
    // locked transition: a replacement (also under the lock) can neither
    // receive this start's environment nor have its session killed by this
    // start's name-based cleanup between the token read and the kill.
    const createAndPrepareSession = async (): Promise<void> => {
      try {
        await createOwnedSession();
        if (backendName === "tmux") {
          await applyTmuxSessionEnvironment({
            sessionName,
            env: opts.env,
            timeoutMs: muxTimeoutMs,
          });
        }
      } catch (error: unknown) {
        if (createdOwnershipToken === ownershipToken) {
          await releaseFailedSessionCreation({
            backend,
            ownershipToken,
            sessionCreated,
          });
        }
        throw error;
      }
    };
    try {
      await underInstanceLock(createAndPrepareSession);
    } finally {
      settleSessionCreation();
    }
    sessionReady = true;
  };

  /** Run under the shared helper instance lock when this start has one. */
  const underInstanceLock = async <T>(run: () => Promise<T>): Promise<T> =>
    opts.sessionOwnership
      ? await opts.sessionOwnership.withLock(run)
      : await run();

  /**
   * Whether the persisted entry and the live session still carry this
   * start's token (created or adopted). Call under the instance lock. False
   * when another start replaced the session or the live token is unreadable.
   */
  const sessionStillOwned = async (): Promise<boolean> => {
    const entries = await readLifecycleState({
      projectDir: opts.project.projectDir,
    });
    const entry =
      entries.find(
        (candidate) => candidate.composeProject === opts.composeProject
      ) ?? null;
    const backend = backendName
      ? (await opts.mux()).backends.get(backendName)
      : undefined;
    const expected =
      createdOwnershipToken ?? adoptedEntry?.ownershipToken ?? null;
    const persistedOurs =
      entry !== null && (entry.ownershipToken ?? null) === expected;
    const liveOurs =
      expected === null || !backend?.readLifecycleOwnerToken
        ? true
        : (await backend
            .readLifecycleOwnerToken({ name: sessionName })
            .catch(() => undefined)) === expected;
    return persistedOurs && liveOurs;
  };

  /** Give up cleanup and finalize authority over a replaced session. */
  const relinquishDisplacedSession = (): never => {
    createdOwnershipToken = null;
    adoptedEntry = null;
    throw new LifecycleSessionDisplacedError(sessionName);
  };

  /**
   * Refuse to create when the session is no longer absent: an overlapping
   * start created it (and may have finalized its entry) after this start
   * decided to create. Nothing is published or changed on refusal.
   */
  const assertSessionStillAbsent = async (
    backend: MuxBackend
  ): Promise<void> => {
    const entries = await readLifecycleState({
      projectDir: opts.project.projectDir,
    });
    const entry =
      entries.find(
        (candidate) => candidate.composeProject === opts.composeProject
      ) ?? null;
    const inspection = await inspectLifecycleSession({
      backend,
      entry,
      expectedSessionName: sessionName,
      expectedProjectRoot: opts.project.projectRoot,
      expectedDefinitionHash: opts.definitionHash,
    });
    if (inspection.decision.kind !== "create") {
      throw new Error(
        `Another hack up of this instance changed lifecycle session ${sessionName} while this one prepared it; nothing was changed. Run the command again.`
      );
    }
  };

  /**
   * After a failed creation transition. A session that was (or may have
   * been) created with this start's token is stopped with that token before
   * its entry is removed. Whenever the outcome stays unknown (a mux call hung,
   * the stop is unconfirmed), the entry and token are kept so abort(), a
   * later up or hack down can still prove ownership and reclaim the session.
   * Nothing is left running without an ownership record.
   */
  const releaseFailedSessionCreation = async (release: {
    readonly backend: MuxBackend;
    readonly ownershipToken: string;
    readonly sessionCreated: boolean | "unknown";
  }): Promise<void> => {
    if (release.sessionCreated !== false) {
      const observed = await Promise.resolve(
        release.backend.readLifecycleOwnerToken?.({ name: sessionName }) ?? null
      ).catch(() => undefined);
      if (observed === undefined) {
        return;
      }
      const foreign = observed !== null && observed !== release.ownershipToken;
      if (!foreign) {
        const stopped = await killLifecycleSessionWithOwnership({
          backend: release.backend,
          sessionName,
          ownershipToken: release.ownershipToken,
        }).catch(() => false);
        if (!stopped) {
          return;
        }
      }
    }
    await removeLifecycleStateEntryIfOwned({
      projectDir: opts.project.projectDir,
      composeProject: opts.composeProject,
      ownershipToken: release.ownershipToken,
    });
    createdOwnershipToken = null;
  };

  const publishFinalEntry = async (): Promise<void> => {
    if (startedProcesses.length === 0 || !backendName) {
      await removeLifecycleStateEntry({
        projectDir: opts.project.projectDir,
        composeProject: opts.composeProject,
      });
      return;
    }
    const ownershipToken =
      createdOwnershipToken ?? adoptedEntry?.ownershipToken;
    await upsertLifecycleStateEntry({
      projectDir: opts.project.projectDir,
      entry: {
        composeProject: opts.composeProject,
        projectName: opts.projectName,
        branch: opts.branch,
        sessionName,
        backend: backendName,
        ...(ownershipToken ? { ownershipToken } : {}),
        definitionHash: opts.definitionHash,
        processes: startedProcesses,
        updatedAt: new Date().toISOString(),
      },
    });
  };

  /**
   * Publish the final entry only while the persisted entry and the live
   * session still carry this start's token (created or adopted). Otherwise
   * another start replaced the session: this start gives up its cleanup and
   * finalize authority and fails, leaving the replacement's entry intact.
   * With no processes of its own, it removes only an entry it owns or one
   * whose session is gone, never another start's live one.
   */
  const publishFinalEntryIfStillOwned = async (): Promise<void> => {
    const entries = await readLifecycleState({
      projectDir: opts.project.projectDir,
    });
    const entry =
      entries.find(
        (candidate) => candidate.composeProject === opts.composeProject
      ) ?? null;
    const backend = backendName
      ? (await opts.mux()).backends.get(backendName)
      : undefined;
    if (startedProcesses.length === 0 || !backendName) {
      if (entry && (await entryRemovable({ entry, backend }))) {
        await removeLifecycleStateEntryIfOwned({
          projectDir: opts.project.projectDir,
          composeProject: opts.composeProject,
          ownershipToken: entry.ownershipToken ?? "",
        });
      }
      return;
    }
    if (!(await sessionStillOwned())) {
      relinquishDisplacedSession();
    }
    await publishFinalEntry();
  };

  const entryRemovable = async (check: {
    readonly entry: LifecycleStateEntry;
    readonly backend: MuxBackend | undefined;
  }): Promise<boolean> => {
    if (
      createdOwnershipToken !== null &&
      check.entry.ownershipToken === createdOwnershipToken
    ) {
      return true;
    }
    if (!check.backend?.available) {
      return false;
    }
    const inspection = await inspectLifecycleSession({
      backend: check.backend,
      entry: check.entry,
      expectedSessionName: sessionName,
      expectedProjectRoot: opts.project.projectRoot,
      expectedDefinitionHash: opts.definitionHash,
    }).catch(() => null);
    return inspection?.classification === "absent";
  };

  const startProcess = async (
    process: ProjectLifecycleProcess
  ): Promise<void> => {
    await resolveSessionDisposition();
    if (adoptedEntry?.processes.some((entry) => entry.name === process.name)) {
      return;
    }
    const singletonDecision = await resolveLifecycleSingletonDecisionForProcess(
      {
        process,
        projectDir: opts.project.projectDir,
        composeProject: opts.composeProject,
      }
    );
    if (singletonDecision.kind === "adopt") {
      logger.info({ message: singletonDecision.message });
      return;
    }
    if (singletonDecision.kind === "fail") {
      throw new Error(singletonDecision.message);
    }

    const launch = await opts.prepareLaunch?.(process);
    await ensureSession();
    await opts.assertFresh?.();
    // The launch is fenced at the mutation itself: under the instance lock,
    // and only while the session still carries this start's token, so a
    // displaced start never adds windows or panes to its replacement.
    const started = await underInstanceLock(async () => {
      if (opts.sessionOwnership && !(await sessionStillOwned())) {
        relinquishDisplacedSession();
      }
      return await startLifecycleProcess({
        backend: backendName as MuxBackendName,
        sessionName,
        projectRoot: opts.project.projectRoot,
        env: opts.env,
        index: nextIndex,
        process: launch ? { ...process, command: launch.command } : process,
        projectDir: opts.project.projectDir,
        composeProject: opts.composeProject,
        assertFresh: opts.assertFresh,
        timeoutMs: muxTimeoutMs,
      });
    });
    nextIndex += 1;
    startedProcesses.push(started);
    await launch?.started(started);
  };

  return {
    sessionName,
    startFromCommand: async ({ command, serviceName }) => {
      await startProcess({
        name: serviceName,
        command: command.command,
        ...(command.cwd ? { cwd: command.cwd } : {}),
        ...(command.singleton ? { singleton: command.singleton } : {}),
      });
    },
    startMany: async ({ processes }) => {
      await resolveSessionDisposition();
      for (const process of processes) {
        await startProcess(process);
      }
    },
    finalize: async () => {
      const ownership = opts.sessionOwnership;
      if (!ownership) {
        await publishFinalEntry();
        return;
      }
      // Conditional publication under the instance lock: another start may
      // have replaced this start's pending session since it was created.
      await ownership.withLock(publishFinalEntryIfStillOwned);
    },
    abort: async () => {
      const outcome = await starterAbort();
      operationSignalCleanup?.dispose();
      return outcome;
    },
    hasStarted: () => startedProcesses.length > 0,
    // Runs inside SharedHelperSessionOwnership.runIfOwned, which already
    // holds the instance lock: never acquire it again here.
    getOperationCleanup: () =>
      createdOwnershipToken
        ? async () => {
            await sessionCreationSettled;
            return await abortOwnedSession();
          }
        : null,
    getSignalCleanup: () => operationSignalCleanup,
  };

  /**
   * Abort and signal cleanup. The token read and name-based kill run under
   * the instance lock, as replacement does, so this start never kills a
   * session that replaced its own in between. Creation settles first: it
   * holds the lock until its own failure cleanup is done.
   */
  async function starterAbort(): Promise<
    undefined | typeof LIFECYCLE_SESSION_RETAINED
  > {
    await sessionCreationSettled;
    if (!(createdOwnershipToken && backendName)) {
      return undefined;
    }
    try {
      return await underInstanceLock(abortOwnedSession);
    } catch {
      logger.warn({
        message: `Could not confirm that lifecycle session ${sessionName} stopped; kept its ownership record. Run hack down to stop it.`,
      });
      return LIFECYCLE_SESSION_RETAINED;
    }
  }

  /** Stop this start's created session; the caller holds the instance lock. */
  async function abortOwnedSession(): Promise<
    undefined | typeof LIFECYCLE_SESSION_RETAINED
  > {
    if (!(createdOwnershipToken && backendName)) {
      return undefined;
    }
    const backend = (await opts.mux()).backends.get(backendName);
    const stopped = backend?.available
      ? await killLifecycleSessionWithOwnership({
          backend,
          sessionName,
          ownershipToken: createdOwnershipToken,
        }).catch(() => false)
      : false;
    if (!stopped) {
      // The session may still run: keep its ownership entry (and this
      // operation's token) so a later abort, up or hack down can still prove
      // ownership and reclaim it. Removing it would orphan the session.
      logger.warn({
        message: `Could not confirm that lifecycle session ${sessionName} stopped; kept its ownership record. Run hack down to stop it.`,
      });
      return LIFECYCLE_SESSION_RETAINED;
    }
    await removeLifecycleStateEntryIfOwned({
      projectDir: opts.project.projectDir,
      composeProject: opts.composeProject,
      ownershipToken: createdOwnershipToken,
    });
    createdOwnershipToken = null;
    return undefined;
  }
}

/**
 * A lifecycle start failed and its session could not be confirmed stopped:
 * the session (and its ownership record) was kept. Callers must keep what
 * the session depends on, such as shared helper holders. The message is the
 * original failure's.
 */
export class LifecycleSessionRetainedError extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super(
      original instanceof Error
        ? original.message
        : "Failed to start lifecycle processes"
    );
    this.name = "LifecycleSessionRetainedError";
    this.original = original;
  }
}

/** Raised by finalize when another start replaced this start's session. */
export class LifecycleSessionDisplacedError extends Error {
  constructor(sessionName: string) {
    super(
      `Another hack up replaced lifecycle session ${sessionName} while this one was starting; this up stopped without taking it over. Run the command again.`
    );
    this.name = "LifecycleSessionDisplacedError";
  }
}

async function applyTmuxSessionEnvironment(opts: {
  readonly sessionName: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}): Promise<void> {
  for (const [key, value] of Object.entries(opts.env)) {
    await runMuxCommand(
      ["tmux", "set-environment", "-t", opts.sessionName, key, value],
      {
        stdin: "ignore",
        timeoutMs: opts.timeoutMs,
      }
    );
  }
}

async function resolveLifecycleSingletonDecisionForProcess(opts: {
  readonly process: ProjectLifecycleProcess;
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<
  | ReturnType<typeof resolveLifecycleSingletonDecision>
  | Promise<ReturnType<typeof resolveLifecycleSingletonDecision>>
> {
  if (!opts.process.singleton) {
    return { kind: "start" };
  }

  const occupiedPorts = await inspectListeningTcpPorts({
    ports: opts.process.singleton.ports,
  });
  const decision = resolveLifecycleSingletonDecision({
    singleton: opts.process.singleton,
    occupiedPorts,
    serviceName: opts.process.name,
  });

  if (decision.kind === "adopt") {
    await appendLifecycleLogRecord({
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
      record: {
        timestamp: new Date().toISOString(),
        service: opts.process.name,
        stream: "meta",
        message: `[adopt] ${decision.message}`,
      },
    });
  }

  return decision;
}

async function startLifecycleProcess(opts: {
  readonly backend: MuxBackendName;
  readonly sessionName: string;
  readonly projectRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly index: number;
  readonly process: ProjectLifecycleProcess;
  readonly projectDir: string;
  readonly composeProject: string;
  readonly assertFresh?: () => Promise<void>;
  readonly timeoutMs: number;
}): Promise<{
  readonly name: string;
  readonly windowName: string;
  readonly logPath: string;
  readonly panePid?: number;
  readonly processGroupId?: number;
}> {
  const windowNameRaw = sanitizeBranchSlug(opts.process.name);
  const windowName =
    windowNameRaw.length > 0 ? windowNameRaw : `proc-${opts.index + 1}`;
  const cwd = resolveLifecycleCwd({
    projectRoot: opts.projectRoot,
    cwd: opts.process.cwd,
  });
  const logPath = resolveLifecycleLogPath({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
  if (opts.backend === "tmux") {
    const commandPidPath = `${logPath}.${windowName}.pid`;
    await ensureDir(dirname(commandPidPath));
    await rm(commandPidPath, { force: true });
    const wrappedCommand = wrapLifecyclePersistentCommand({
      command: opts.process.command,
      commandPidPath,
      logPath,
      serviceName: opts.process.name,
    });
    await opts.assertFresh?.();
    const result = await runMuxCommand(
      [
        "tmux",
        "new-window",
        "-t",
        opts.sessionName,
        "-n",
        windowName,
        "-c",
        cwd,
        "sh",
        "-c",
        wrappedCommand,
      ],
      { stdin: "ignore", timeoutMs: opts.timeoutMs }
    );
    if (result.exitCode !== 0) {
      await rm(commandPidPath, { force: true });
      throw new Error(
        `Failed to start lifecycle process "${opts.process.name}": ${result.stderr.trim()}`
      );
    }
    const panePids = await readTmuxPanePids({
      sessionName: opts.sessionName,
      windowName,
    });
    const panePid = panePids[0];
    let processGroupId: number | null = null;
    try {
      processGroupId = await waitForLifecycleCommandProcessGroupId({
        commandPidPath,
      });
    } finally {
      await rm(commandPidPath, { force: true });
    }
    if (!processGroupId && panePid !== undefined) {
      processGroupId = await readProcessGroupIdForPid({ pid: panePid });
    }
    await appendLifecycleLogRecord({
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
      record: {
        timestamp: new Date().toISOString(),
        service: opts.process.name,
        stream: "meta",
        message: `[start] process launched in tmux:${opts.sessionName}:${windowName}`,
      },
    });
    return {
      name: opts.process.name,
      windowName,
      logPath,
      ...(panePid !== undefined ? { panePid } : {}),
      ...(processGroupId ? { processGroupId } : {}),
    };
  }

  const wrappedCommand = wrapLifecyclePersistentCommand({
    command: opts.process.command,
    commandPidPath: null,
    logPath,
    serviceName: opts.process.name,
  });
  await opts.assertFresh?.();
  const result = await runMuxCommand(
    [
      "zellij",
      "--session",
      opts.sessionName,
      "run",
      "--close-on-exit",
      "--name",
      windowName,
      "--",
      "sh",
      "-c",
      wrappedCommand,
    ],
    {
      stdin: "ignore",
      cwd,
      env: { ...opts.env },
      timeoutMs: opts.timeoutMs,
    }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to start lifecycle process "${opts.process.name}": ${result.stderr.trim()}`
    );
  }
  await appendLifecycleLogRecord({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
    record: {
      timestamp: new Date().toISOString(),
      service: opts.process.name,
      stream: "meta",
      message: `[start] process launched in zellij:${opts.sessionName}:${windowName}`,
    },
  });
  return {
    name: opts.process.name,
    windowName,
    logPath,
  };
}

export async function stopLifecycleProcessController(opts: {
  readonly project: LifecycleControllerProject;
  readonly definitionHash: string;
  readonly projectName: string;
  readonly branch: string | null;
  readonly composeProject: string;
  /** Internal frontend fence. Legacy callers retain their original owner path. */
  readonly assertFresh?: () => Promise<void>;
  /** Mux backends; defaults to the installed tmux/zellij backends. */
  readonly mux?: () => Promise<ResolvedMux>;
}): Promise<void> {
  await opts.assertFresh?.();
  const sessionName = resolveLifecycleSessionName({
    projectName: opts.projectName,
    branch: opts.branch,
  });
  const lifecycleEntries = await readLifecycleState({
    projectDir: opts.project.projectDir,
  });
  const lifecycleEntry =
    lifecycleEntries.find(
      (entry) => entry.composeProject === opts.composeProject
    ) ?? null;

  const backend = lifecycleEntry
    ? (opts.mux ? (await opts.mux()).backends : getMuxBackends()).get(
        lifecycleEntry.backend
      )
    : null;
  if (!lifecycleEntry) {
    return;
  }
  if (!backend?.available) {
    throw new Error(
      `Lifecycle backend ${lifecycleEntry.backend} is unavailable; refusing unverified session cleanup`
    );
  }

  const definitionHash = lifecycleEntry.definitionHash ?? opts.definitionHash;
  const inspection = await inspectLifecycleSession({
    backend,
    entry: lifecycleEntry,
    expectedSessionName: sessionName,
    expectedProjectRoot: opts.project.projectRoot,
    expectedDefinitionHash: definitionHash,
  });
  if (inspection.decision.kind === "block") {
    throw new Error(inspection.decision.reason);
  }

  const matchedLiveSession = inspection.classification !== "absent";
  await opts.assertFresh?.();
  if (matchedLiveSession && backend.name === "tmux") {
    await interruptLifecycleTmuxProcesses({
      sessionName,
      lifecycleEntry,
      assertFresh: opts.assertFresh,
    });
  }
  if (matchedLiveSession) {
    await opts.assertFresh?.();
    const killed = lifecycleEntry.ownershipToken
      ? await killLifecycleSessionWithOwnership({
          backend,
          sessionName,
          ownershipToken: lifecycleEntry.ownershipToken,
        })
      : (await backend.killSession({ name: sessionName })).exitCode === 0;
    if (!killed) {
      throw new Error(`Failed to stop owned lifecycle session: ${sessionName}`);
    }
  }

  const processGroupIds = await resolveLifecycleStopProcessGroupIdsForEntry({
    matchedLiveSession,
    lifecycleEntry,
  });
  await opts.assertFresh?.();
  await terminateLifecycleProcessGroups({
    processGroupIds,
    assertFresh: opts.assertFresh,
  });

  await opts.assertFresh?.();
  if (lifecycleEntry.ownershipToken) {
    await removeLifecycleStateEntryIfOwned({
      projectDir: opts.project.projectDir,
      composeProject: opts.composeProject,
      ownershipToken: lifecycleEntry.ownershipToken,
    });
  } else {
    await removeLifecycleStateEntry({
      projectDir: opts.project.projectDir,
      composeProject: opts.composeProject,
    });
  }
}

async function interruptLifecycleTmuxProcesses(opts: {
  readonly sessionName: string;
  readonly lifecycleEntry: LifecycleStateEntry | null;
  readonly assertFresh?: () => Promise<void>;
}): Promise<void> {
  const processWindows = opts.lifecycleEntry?.processes ?? [];
  if (processWindows.length === 0) {
    return;
  }

  for (const processInfo of processWindows) {
    await opts.assertFresh?.();
    await runMuxCommand(
      [
        "tmux",
        "send-keys",
        "-t",
        `${opts.sessionName}:${processInfo.windowName}`,
        "C-c",
      ],
      { stdin: "ignore" }
    );
  }

  await Bun.sleep(750);
  const processGroupIds = await resolveLifecycleProcessGroupIds({
    sessionName: opts.sessionName,
    lifecycleEntry: opts.lifecycleEntry,
  });
  await opts.assertFresh?.();
  await terminateLifecycleProcessGroups({
    processGroupIds,
    assertFresh: opts.assertFresh,
  });
}

async function readTmuxPanePids(opts: {
  readonly sessionName: string;
  readonly windowName: string;
}): Promise<number[]> {
  const result = await runMuxCommand(
    [
      "tmux",
      "list-panes",
      "-t",
      `${opts.sessionName}:${opts.windowName}`,
      "-F",
      "#{pane_pid}",
    ],
    { stdin: "ignore" }
  );
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function readProcessGroupIdForPid(opts: {
  readonly pid: number;
}): Promise<number | null> {
  const result = await exec(["ps", "-o", "pgid=", "-p", String(opts.pid)], {
    stdin: "ignore",
  });
  if (result.exitCode !== 0) {
    return null;
  }
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function waitForLifecycleCommandProcessGroupId(opts: {
  readonly commandPidPath: string;
}): Promise<number | null> {
  for (
    let attempt = 0;
    attempt < LIFECYCLE_COMMAND_PID_WAIT_ATTEMPTS;
    attempt += 1
  ) {
    const commandPidRaw = await readTextFile(opts.commandPidPath);
    const commandPid = Number.parseInt(commandPidRaw?.trim() ?? "", 10);
    if (Number.isInteger(commandPid) && commandPid > 1) {
      const processGroupId = await readProcessGroupIdForPid({
        pid: commandPid,
      });
      if (processGroupId) {
        return processGroupId;
      }
    }
    await Bun.sleep(LIFECYCLE_COMMAND_PID_WAIT_INTERVAL_MS);
  }
  return null;
}

async function resolveLifecycleProcessGroupIds(opts: {
  readonly sessionName: string;
  readonly lifecycleEntry: LifecycleStateEntry | null;
}): Promise<number[]> {
  const panePidsByWindow = new Map<string, readonly number[]>();
  for (const processInfo of opts.lifecycleEntry?.processes ?? []) {
    const panePids = await readTmuxPanePids({
      sessionName: opts.sessionName,
      windowName: processInfo.windowName,
    });
    panePidsByWindow.set(processInfo.windowName, panePids);
  }

  return resolveLifecycleProcessGroupIdsForTmuxState({
    lifecycleEntry: opts.lifecycleEntry,
    panePidsByWindow,
    snapshot: await readProcessSnapshot(),
  });
}

async function resolveLifecycleStopProcessGroupIdsForEntry(opts: {
  readonly matchedLiveSession: boolean;
  readonly lifecycleEntry: LifecycleStateEntry | null;
}): Promise<number[]> {
  return resolveLifecycleStopProcessGroupIds({
    matchedLiveSession: opts.matchedLiveSession,
    lifecycleEntry: opts.lifecycleEntry,
    snapshot: await readProcessSnapshot(),
  });
}

export function resolveLifecycleCommandServiceName(opts: {
  readonly command: ProjectLifecycleCommand;
  readonly index: number;
}): string {
  const fromName = (opts.command.name ?? "").trim();
  if (fromName.length > 0) {
    return fromName;
  }
  return `hook-${opts.index + 1}`;
}

export function wrapLifecyclePersistentCommand(opts: {
  readonly command: string;
  readonly commandPidPath: string | null;
  readonly logPath: string;
  readonly serviceName: string;
}): string {
  const logPath = shellSingleQuote(opts.logPath);
  const service = shellSingleQuote(opts.serviceName);
  const command = shellSingleQuote(opts.command);
  const commandPidPath =
    opts.commandPidPath === null ? null : shellSingleQuote(opts.commandPidPath);
  return [
    `HACK_LIFECYCLE_LOG=${logPath}`,
    `HACK_LIFECYCLE_SERVICE=${service}`,
    `HACK_LIFECYCLE_COMMAND=${command}`,
    ...(commandPidPath
      ? [`HACK_LIFECYCLE_COMMAND_PID_FILE=${commandPidPath}`]
      : []),
    `fifo="$(mktemp -u "\${TMPDIR:-/tmp}/hack-lifecycle.XXXXXX")"`,
    'mkfifo "$fifo"',
    "cleanup_lifecycle() {",
    "  trap - EXIT INT TERM HUP",
    `  if [ -n "\${cmd_pid:-}" ]; then`,
    "    if [ -x /bin/kill ]; then",
    '      /bin/kill -TERM -- "-$cmd_pid" 2>/dev/null || /bin/kill "$cmd_pid" 2>/dev/null || true',
    "    elif [ -x /usr/bin/kill ]; then",
    '      /usr/bin/kill -TERM -- "-$cmd_pid" 2>/dev/null || /usr/bin/kill "$cmd_pid" 2>/dev/null || true',
    "    else",
    '      kill "$cmd_pid" 2>/dev/null || true',
    "    fi",
    '    wait "$cmd_pid" 2>/dev/null || true',
    "  fi",
    `  if [ -n "\${reader_pid:-}" ]; then`,
    '    wait "$reader_pid" 2>/dev/null || true',
    "  fi",
    ...(commandPidPath ? ['  rm -f "$HACK_LIFECYCLE_COMMAND_PID_FILE"'] : []),
    '  rm -f "$fifo"',
    "}",
    'trap "cleanup_lifecycle; exit 130" INT TERM HUP',
    'trap "cleanup_lifecycle" EXIT',
    "( while IFS= read -r line; do",
    '    printf "%s\\n" "$line"',
    '    printf \'%s\\t%s\\tstdout\\t%s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HACK_LIFECYCLE_SERVICE" "$line" >> "$HACK_LIFECYCLE_LOG"',
    '  done < "$fifo" ) &',
    "reader_pid=$!",
    "if command -v python3 >/dev/null 2>&1; then",
    ...(commandPidPath
      ? [
          '  python3 -c \'import os, sys; os.setsid(); pid_file = open(sys.argv[2], "w"); pid_file.write(str(os.getpid())); pid_file.close(); os.execvp("sh", ["sh", "-c", sys.argv[1]])\' "$HACK_LIFECYCLE_COMMAND" "$HACK_LIFECYCLE_COMMAND_PID_FILE" >"$fifo" 2>&1 &',
        ]
      : [
          '  python3 -c \'import os, sys; os.setsid(); os.execvp("sh", ["sh", "-c", sys.argv[1]])\' "$HACK_LIFECYCLE_COMMAND" >"$fifo" 2>&1 &',
        ]),
    "  cmd_pid=$!",
    "else",
    '  sh -c "$HACK_LIFECYCLE_COMMAND" >"$fifo" 2>&1 &',
    "  cmd_pid=$!",
    ...(commandPidPath
      ? ['  printf "%s\\n" "$cmd_pid" > "$HACK_LIFECYCLE_COMMAND_PID_FILE"']
      : []),
    "fi",
    'wait "$cmd_pid"',
    "cmd_status=$?",
    'cmd_pid=""',
    'wait "$reader_pid" 2>/dev/null || true',
    'reader_pid=""',
    'rm -f "$fifo"',
    'exit "$cmd_status"',
  ].join("\n");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function resolveProjectLifecycleDefinitionHash(opts: {
  readonly beforeCommands: readonly ProjectLifecycleCommand[] | undefined;
  readonly processes: readonly ProjectLifecycleProcess[] | undefined;
  readonly env?: Readonly<Record<string, string>>;
  readonly effectiveEnvName?: string | null;
}): string {
  const persistentBefore = (opts.beforeCommands ?? [])
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => command.persistent === true)
    .map(({ command, index }) => ({
      kind: "up-before",
      name: resolveLifecycleCommandServiceName({ command, index }),
      command: command.command,
      cwd: command.cwd ?? null,
      singleton: command.singleton ?? null,
    }));
  const processes = (opts.processes ?? []).map((process) => ({
    kind: "process",
    name: process.name,
    command: process.command,
    cwd: process.cwd ?? null,
    singleton: process.singleton ?? null,
  }));
  const environmentFingerprint = resolveLifecycleEnvironmentFingerprint({
    effectiveEnvName: opts.effectiveEnvName ?? null,
    env: opts.env ?? {},
  });
  return resolveLifecycleDefinitionHash({
    definitions: [
      ...persistentBefore,
      ...processes,
      { kind: "environment", fingerprint: environmentFingerprint },
    ],
  });
}
