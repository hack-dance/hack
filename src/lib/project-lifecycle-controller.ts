import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { MuxBackend, MuxBackendName } from "../mux/mux-backend.ts";
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
export type LifecycleOperationCleanup = () => Promise<void>;
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
  await removeLifecycleStateEntry({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
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
  abort: () => Promise<void>;
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

  const resolveSessionDisposition = async (): Promise<void> => {
    if (sessionDispositionResolved) {
      return;
    }
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
      return;
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
    createdOwnershipToken = ownershipToken;
    try {
      // Persist ownership before creating the mux session. If the CLI is
      // SIGKILLed after session creation, the next up can still prove that
      // the empty session belongs to this Compose instance and replace it.
      await upsertLifecycleStateEntry({
        projectDir: opts.project.projectDir,
        entry: pendingEntry,
      });
      await opts.assertFresh?.();
      const created = await backend.createSession({
        name: sessionName,
        cwd: opts.project.projectRoot,
        lifecycleOwnerToken: ownershipToken,
      });
      if (!created.ok) {
        throw new Error(`Failed to create lifecycle session: ${sessionName}`);
      }
      if (backendName === "tmux") {
        for (const [key, value] of Object.entries(opts.env)) {
          await exec(
            ["tmux", "set-environment", "-t", sessionName, key, value],
            {
              stdin: "ignore",
            }
          );
        }
      }
    } catch (error: unknown) {
      await removeLifecycleStateEntryIfOwned({
        projectDir: opts.project.projectDir,
        composeProject: opts.composeProject,
        ownershipToken,
      });
      createdOwnershipToken = null;
      throw error;
    } finally {
      settleSessionCreation();
    }
    sessionReady = true;
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
    const started = await startLifecycleProcess({
      backend: backendName as MuxBackendName,
      sessionName,
      projectRoot: opts.project.projectRoot,
      env: opts.env,
      index: nextIndex,
      process: launch ? { ...process, command: launch.command } : process,
      projectDir: opts.project.projectDir,
      composeProject: opts.composeProject,
      assertFresh: opts.assertFresh,
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
    },
    abort: async () => {
      await starterAbort();
      operationSignalCleanup?.dispose();
    },
    hasStarted: () => startedProcesses.length > 0,
    getOperationCleanup: () =>
      createdOwnershipToken
        ? async () => {
            await starterAbort();
          }
        : null,
    getSignalCleanup: () => operationSignalCleanup,
  };

  async function starterAbort(): Promise<void> {
    await sessionCreationSettled;
    if (!(createdOwnershipToken && backendName)) {
      return;
    }
    const backend = (await opts.mux()).backends.get(backendName);
    if (backend?.available) {
      await killLifecycleSessionWithOwnership({
        backend,
        sessionName,
        ownershipToken: createdOwnershipToken,
      });
    }
    await removeLifecycleStateEntryIfOwned({
      projectDir: opts.project.projectDir,
      composeProject: opts.composeProject,
      ownershipToken: createdOwnershipToken,
    });
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
    const result = await exec(
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
      { stdin: "ignore" }
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
  const result = await exec(
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
    ? getMuxBackends().get(lifecycleEntry.backend)
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
    await exec(
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
  const result = await exec(
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
