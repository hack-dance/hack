import { dirname } from "node:path";
import { logger } from "../ui/logger.ts";
import { childEnvironment } from "./child-environment.ts";
import {
  ensurePrivateLifecycleLog,
  type LifecycleStateEntry,
  type LifecycleStateProcess,
  readLifecycleState,
  removeLifecycleStateEntryIfOwned,
  resolveLifecycleLogPath,
  upsertLifecycleStateEntry,
} from "./lifecycle-runtime.ts";
import {
  inspectLifecycleSupervisor,
  type LifecycleSupervisorReceipt,
  launchLifecycleSupervisorProcess,
  preflightLifecycleSupervisor,
  resolveLifecycleSupervisorRoot,
  stopLifecycleSupervisor,
  withLifecycleSupervisorControllerLock,
} from "./lifecycle-supervisor.ts";
import { ensurePrivateDirectory } from "./private-file.ts";
import type { ProjectLifecycleProcess } from "./project.ts";
import {
  type createLifecycleProcessController,
  installLifecycleSignalCleanup,
  LIFECYCLE_SESSION_RETAINED,
  LifecycleSessionDisplacedError,
  resolveLifecycleCwd,
  resolveLifecycleSessionName,
  resolveLifecycleSingletonDecisionForProcess,
} from "./project-lifecycle-controller.ts";
import { createLifecycleOwnershipToken } from "./project-lifecycle-sessions.ts";

type Options = Parameters<typeof createLifecycleProcessController>[0];
type Controller = ReturnType<typeof createLifecycleProcessController>;

function hasRunningCommand(
  receipt: LifecycleSupervisorReceipt,
  name: string
): boolean {
  return (
    receipt.liveProcessNames.includes(name) &&
    receipt.processes.some(
      (state) => state.name === name && state.phase === "running"
    )
  );
}

/** The native owner preserves the mux controller's adoption and rollback fences. */
export function createSupervisorLifecycleController(
  opts: Options & { readonly stopExisting: () => Promise<void> }
): Controller {
  const sessionName = resolveLifecycleSessionName(opts);
  const logPath = resolveLifecycleLogPath({
    projectDir: opts.project.projectDir,
    composeProject: opts.composeProject,
  });
  const instance = {
    projectDir: opts.project.projectDir,
    composeProject: opts.composeProject,
  };
  let token: string | null = null;
  let created = false;
  let decided = false;
  let ownerPid: number | undefined;
  let launchAttempted = false;
  let nativeRoot: string | undefined;
  let cleanupEpoch: string | undefined;
  let processes: readonly LifecycleStateProcess[] = [];
  let signals: ReturnType<typeof installLifecycleSignalCleanup> | null = null;
  let mutation: Promise<unknown> = Promise.resolve();

  async function underLock<T>(run: () => Promise<T>): Promise<T> {
    const locked = () => withControllerLock(run);
    return opts.sessionOwnership
      ? await opts.sessionOwnership.withLock(locked)
      : await locked();
  }
  async function withControllerLock<T>(run: () => Promise<T>): Promise<T> {
    return await withLifecycleSupervisorControllerLock({ ...instance, run });
  }
  async function current(): Promise<LifecycleStateEntry | undefined> {
    return (await readLifecycleState(instance)).find(
      (entry) => entry.composeProject === opts.composeProject
    );
  }
  async function assertOwned(): Promise<void> {
    await opts.assertFresh?.();
    const observed = await current();
    if (
      !token ||
      observed?.ownershipToken !== token ||
      observed.cleanupEpoch !== cleanupEpoch
    ) {
      created = false;
      throw new LifecycleSessionDisplacedError(sessionName);
    }
  }
  async function publish(): Promise<void> {
    if (!token) {
      return;
    }
    await assertOwned();
    await upsertLifecycleStateEntry({
      projectDir: instance.projectDir,
      entry: entry(),
    });
  }
  function entry(): LifecycleStateEntry {
    return {
      composeProject: opts.composeProject,
      projectName: opts.projectName,
      branch: opts.branch,
      sessionName,
      backend: "supervisor",
      ownershipToken: token ?? undefined,
      definitionHash: opts.definitionHash,
      processes,
      updatedAt: new Date().toISOString(),
      ...(ownerPid ? { supervisorPid: ownerPid } : {}),
      ...(nativeRoot ? { supervisorRoot: nativeRoot } : {}),
      supervisorLaunchAttempted: launchAttempted,
      ...(cleanupEpoch ? { cleanupEpoch } : {}),
    };
  }
  async function decide(): Promise<void> {
    if (decided) {
      return;
    }
    await underLock(async () => {
      await opts.assertFresh?.();
      const existing = await current();
      if (existing) {
        if (existing.backend === "supervisor" && (await adopt(existing))) {
          decided = true;
          return;
        }
        await opts.stopExisting();
      }
      decided = true;
    });
  }
  async function adopt(existing: LifecycleStateEntry): Promise<boolean> {
    if (!existing.ownershipToken) {
      throw new Error(
        "Lifecycle supervisor ownership is missing; nothing was started."
      );
    }
    const status = await inspectLifecycleSupervisor({
      ...instance,
      ownershipToken: existing.ownershipToken,
    });
    if (status.unknownProcessNames.length > 0) {
      throw new Error(
        "Lifecycle supervisor identity could not be verified; ownership was retained."
      );
    }
    if (canAdopt(existing, status)) {
      token = existing.ownershipToken;
      processes = existing.processes;
      ownerPid = existing.supervisorPid;
      nativeRoot =
        existing.supervisorRoot ?? resolveLifecycleSupervisorRoot(instance);
      launchAttempted = true;
      cleanupEpoch = createLifecycleOwnershipToken();
      await upsertLifecycleStateEntry({
        projectDir: instance.projectDir,
        entry: entry(),
      });
      await opts.sessionOwnership?.record("adopted");
      return true;
    }
    return false;
  }
  function canAdopt(
    existing: LifecycleStateEntry,
    status: LifecycleSupervisorReceipt
  ): boolean {
    return (
      existing.definitionHash === opts.definitionHash &&
      existing.processes.length > 0 &&
      existing.processes.every((process) =>
        hasRunningCommand(status, process.name)
      )
    );
  }
  async function begin(): Promise<void> {
    if (token) {
      return;
    }
    // decide() may have released the lock while a singleton probe ran. Never
    // publish a new token over a start that won that interval.
    if (await current()) {
      throw new LifecycleSessionDisplacedError(sessionName);
    }
    await ensurePrivateLifecycleLog({ root: dirname(logPath), logPath });
    await preflightLifecycleSupervisor();
    nativeRoot = resolveLifecycleSupervisorRoot(instance);
    await ensurePrivateDirectory(nativeRoot);
    token = createLifecycleOwnershipToken();
    cleanupEpoch = createLifecycleOwnershipToken();
    created = true;
    signals = (opts.installSignalCleanup ?? installLifecycleSignalCleanup)({
      cleanup: abort,
    });
    // Publication precedes even the native owner's startup. Every error after
    // this point leaves an owner token that down can use to inspect/retire it.
    await upsertLifecycleStateEntry({
      projectDir: instance.projectDir,
      entry: entry(),
    });
    await opts.sessionOwnership?.record("created");
  }
  function accept(receipt: LifecycleSupervisorReceipt): void {
    if (receipt.supervisorPid > 1) {
      ownerPid = receipt.supervisorPid;
    }
    processes = receipt.processes.map((process) => ({
      name: process.name,
      windowName: process.name,
      logPath,
      processGroupId: process.processGroupId,
      guardPid: process.guardPid,
      guardStartTime: process.guardStartTime,
      bootId: process.bootId,
      ...(process.commandPid ? { commandPid: process.commandPid } : {}),
    }));
  }
  async function start(process: ProjectLifecycleProcess): Promise<void> {
    await preflightLifecycleSupervisor();
    await decide();
    if (processes.some((started) => started.name === process.name)) {
      await underLock(assertOwned);
      return;
    }
    const singleton = await resolveLifecycleSingletonDecisionForProcess({
      process,
      projectDir: instance.projectDir,
      composeProject: opts.composeProject,
    });
    if (singleton.kind === "adopt") {
      logger.info({ message: singleton.message });
      return;
    }
    if (singleton.kind === "fail") {
      throw new Error(singleton.message);
    }
    if (opts.prepareLaunch) {
      throw new Error(
        "Lifecycle supervisor does not support this launch adapter."
      );
    }
    await underLock(async () => {
      await begin();
      await assertOwned();
      if (!token) {
        throw new Error("Lifecycle supervisor ownership was not established.");
      }
      const observed = await inspectLifecycleSupervisor({
        ...instance,
        ownershipToken: token,
      });
      if (observed.liveProcessNames.includes(process.name)) {
        if (!hasRunningCommand(observed, process.name)) {
          throw new Error(
            "Lifecycle command is retiring; retry after shutdown completes."
          );
        }
        accept(observed);
        await publish();
        return;
      }
      if (observed.unknownProcessNames.includes(process.name)) {
        throw new Error(
          "Lifecycle command identity is unknown; ownership was retained."
        );
      }
      const launch = {
        ...instance,
        ownershipToken: token,
        process: {
          name: process.name,
          argv: ["/bin/sh", "-c", process.command],
          cwd: resolveLifecycleCwd({
            projectRoot: opts.project.projectRoot,
            cwd: process.cwd,
          }),
          env: childEnvironment(undefined, opts.env),
        },
      };
      launchAttempted = true;
      await publish();
      // An owner can naturally retire between hooks. Retry serve only after
      // inspecting native receipts; never infer absence from a socket error.
      let receipt: LifecycleSupervisorReceipt;
      if (processes.length === 0) {
        receipt = await serveAfterAbsence(launch);
      } else {
        try {
          receipt = await launchLifecycleSupervisorProcess({
            ...launch,
            action: "add",
          });
        } catch {
          receipt = await reconcileAdd(launch);
        }
      }
      accept(receipt);
      await publish();
    });
  }
  async function reconcileAdd(
    launch: Omit<
      Parameters<typeof launchLifecycleSupervisorProcess>[0],
      "action"
    >
  ): Promise<LifecycleSupervisorReceipt> {
    await assertOwned();
    const status = await inspectLifecycleSupervisor({
      ...instance,
      ownershipToken: launch.ownershipToken,
    });
    if (status.liveProcessNames.includes(launch.process.name)) {
      accept(status);
      await publish();
      throw new Error(
        "Lifecycle supervisor launch completed after its reply was lost; ownership was retained."
      );
    }
    if (
      status.liveProcessNames.length > 0 ||
      status.unknownProcessNames.length > 0
    ) {
      throw new Error(
        "Lifecycle supervisor launch could not be confirmed; ownership was retained."
      );
    }
    return await serveAfterAbsence(launch);
  }
  async function serveAfterAbsence(
    launch: Omit<
      Parameters<typeof launchLifecycleSupervisorProcess>[0],
      "action"
    >
  ): Promise<LifecycleSupervisorReceipt> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assertOwned();
      try {
        return await launchLifecycleSupervisorProcess({
          ...launch,
          action: "serve",
        });
      } catch {
        const status = await inspectLifecycleSupervisor({
          ...instance,
          ownershipToken: launch.ownershipToken,
        });
        if (
          status.liveProcessNames.length ||
          status.unknownProcessNames.length ||
          attempt === 2
        ) {
          throw new Error(
            "Lifecycle supervisor launch could not be confirmed; ownership was retained."
          );
        }
        await Bun.sleep(50);
      }
    }
    throw new Error("Lifecycle supervisor launch could not be confirmed.");
  }
  async function stopOwned(): Promise<
    undefined | typeof LIFECYCLE_SESSION_RETAINED
  > {
    if (!(created && token)) {
      return undefined;
    }
    if ((await current())?.cleanupEpoch !== cleanupEpoch) {
      created = false;
      return undefined;
    }
    await assertOwned();
    try {
      await stopLifecycleSupervisor({ ...instance, ownershipToken: token });
      await assertOwned();
      await removeLifecycleStateEntryIfOwned({
        ...instance,
        ownershipToken: token,
      });
      created = false;
      return undefined;
    } catch {
      logger.warn({
        message:
          "Could not confirm lifecycle supervisor shutdown; ownership and dependencies were retained. Run hack down to retry.",
      });
      return LIFECYCLE_SESSION_RETAINED;
    }
  }
  async function abort(): Promise<
    undefined | typeof LIFECYCLE_SESSION_RETAINED
  > {
    await mutation.catch(() => undefined);
    if (!created) {
      return undefined;
    }
    if (!opts.sessionOwnership) {
      return await withControllerLock(stopOwned);
    }
    let stopped: undefined | typeof LIFECYCLE_SESSION_RETAINED;
    let result: Awaited<
      ReturnType<NonNullable<Options["sessionOwnership"]>["runIfOwned"]>
    >;
    try {
      result = await opts.sessionOwnership.runIfOwned(async () => {
        stopped = await withControllerLock(stopOwned);
      });
    } catch {
      result = "undecidable";
    }
    if (result === "adopted") {
      created = false;
      return undefined;
    }
    return result === "undecidable" ? LIFECYCLE_SESSION_RETAINED : stopped;
  }
  async function startTracked(process: ProjectLifecycleProcess): Promise<void> {
    const pending = start(process);
    mutation = pending;
    await pending;
  }
  return {
    sessionName,
    startFromCommand: ({ command, serviceName }) =>
      startTracked({
        name: serviceName,
        command: command.command,
        ...(command.cwd ? { cwd: command.cwd } : {}),
        ...(command.singleton ? { singleton: command.singleton } : {}),
      }),
    startMany: async ({ processes }) => {
      await decide();
      for (const process of processes) {
        await startTracked(process);
      }
    },
    finalize: async () => {
      await underLock(publish);
    },
    abort: async () => {
      const result = await abort();
      signals?.dispose();
      return result;
    },
    hasStarted: () => processes.length > 0,
    getOperationCleanup: () =>
      created ? () => withControllerLock(stopOwned) : null,
    getSignalCleanup: () => signals,
  };
}
