import { isDeepStrictEqual } from "node:util";
import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  resolveProjectEnvConfig,
  selectProjectEnvValuesForExecutionTarget,
} from "../lib/project-env-config.ts";
import { openNativeDownHookSession } from "./native-project-down-hooks.ts";
import {
  captureNativeProjectFinalization,
  type NativeProjectFinalizationToken,
  recoverNativeProjectFinalization,
  waitNativeProjectFinalization,
} from "./native-project-finalization.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import { recoverNativeInterruptedStartupCleanup } from "./native-project-interrupted-cleanup.ts";
import {
  retireNativeRecoveredPublisher,
  verifyNativeFrontendRecovery,
} from "./native-project-recovery.ts";
import {
  nativeRecoveryGuidance,
  withNativeRecoveryGuidance,
} from "./native-project-recovery-guidance.ts";
import { withNativeRemovalLock } from "./native-project-removal-lock.ts";
import { confirmedNativeRetainedGraph } from "./native-project-retained.ts";
import {
  describeNativeRunEnvironmentChange,
  loadNativeProjectRun,
  loadNativeRestartIntent,
  type NativeProjectRun,
  type NativeProjectRunScope,
  nativeRunEnvironmentChange,
  removeNativeProjectRun,
} from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

function refused(): Error {
  return new ClosedCliError(
    "Native down cleanup is unconfirmed; no cleanup was replayed. Run hack ps --json to inspect this run's retained state."
  );
}
function finalizationRefused(): Error {
  return new ClosedCliError(
    "Native down frontend finalization is unconfirmed or its ownership changed; no cleanup was replayed. Run hack ps --json to inspect this run's retained state."
  );
}
async function captureFinalization(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
}): Promise<NativeProjectFinalizationToken> {
  try {
    return await captureNativeProjectFinalization(opts);
  } catch {
    throw finalizationRefused();
  }
}
function verify(value: unknown, run: NativeProjectRun, stopped: boolean): void {
  if (
    !isRecord(value) ||
    value.journal_incomplete !== false ||
    !isRecord(value.receipt) ||
    !isRecord(value.observations)
  ) {
    throw refused();
  }
  const receipt = value.receipt;
  if (
    receipt.run !== run.run ||
    receipt.owner !== run.owner ||
    receipt.namespace !== run.namespace ||
    receipt.plan_id !== run.planId ||
    !isRecord(receipt.resources)
  ) {
    throw refused();
  }
  if (!stopped) {
    return;
  }
  if (receipt.phase !== "stopped-data-retained") {
    throw refused();
  }
  for (const resource of Object.values(receipt.resources)) {
    if (!isRecord(resource)) {
      throw refused();
    }
    if (resource.kind === "container") {
      const observation = value.observations[`container:${resource.key}`];
      if (!isRecord(observation) || observation.state !== "absent") {
        throw refused();
      }
    }
  }
}
const RECEIPT_SHA = /^[a-f0-9]{64}$/;
const RECOVERY_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Only ESRCH proves a recorded frontend exited; a live or inaccessible PID does not. */
function processExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isRecord(error) && error.code === "ESRCH";
  }
}
const FOREGROUND_STATES = new Set(["absent", "running", "exited", "uncertain"]);

/** What `graph foreground-owner` selected; it grants no recovery authority. */
type ForegroundOwnerSelection = {
  readonly phase: string;
  readonly receiptSha256: string;
  readonly foreground: "absent" | "running" | "exited" | "uncertain";
  /** Original receipt digest of an interrupted same-boot dead-owner recovery. */
  readonly liveOwnerRecovery: string | null;
  readonly deadOwnerRecovery: string | null;
  /** Guest completion commit. Retirement still finishes and verifies reservation release. */
  readonly deadOwnerRecoveryComplete: boolean;
  readonly deadOwnerRecoveryError: string | null;
};

function ownerRecoveryRefused(): Error {
  return new ClosedCliError(
    "Native down --recover cannot confirm this run's foreground owner state; retained data was not changed. Run hack ps --json to inspect this run's retained state."
  );
}

async function selectForegroundOwner(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
}): Promise<ForegroundOwnerSelection> {
  const value = await opts.invoke({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: ["graph", "foreground-owner", "--run-id", opts.run.run, "--json"],
    timeoutMs: 15_000,
  });
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.run !== opts.run.run ||
    value.owner !== opts.run.owner ||
    typeof value.phase !== "string" ||
    typeof value.receipt_sha256 !== "string" ||
    !RECEIPT_SHA.test(value.receipt_sha256) ||
    typeof value.foreground !== "string" ||
    !FOREGROUND_STATES.has(value.foreground) ||
    (value.foreground !== "running" &&
      !(
        value.live_owner_recovery === null ||
        (typeof value.live_owner_recovery === "string" &&
          RECEIPT_SHA.test(value.live_owner_recovery))
      )) ||
    (value.foreground !== "running" &&
      !(
        value.dead_owner_recovery === undefined ||
        value.dead_owner_recovery === null ||
        (typeof value.dead_owner_recovery === "string" &&
          RECEIPT_SHA.test(value.dead_owner_recovery))
      )) ||
    (value.foreground !== "running" &&
      !(
        value.dead_owner_recovery_complete === undefined ||
        typeof value.dead_owner_recovery_complete === "boolean"
      )) ||
    (value.foreground !== "running" &&
      !(
        value.dead_owner_recovery_error === undefined ||
        value.dead_owner_recovery_error === null ||
        (typeof value.dead_owner_recovery_error === "string" &&
          RECOVERY_CODE.test(value.dead_owner_recovery_error))
      ))
  ) {
    throw ownerRecoveryRefused();
  }
  return {
    phase: value.phase,
    receiptSha256: value.receipt_sha256,
    foreground: value.foreground as ForegroundOwnerSelection["foreground"],
    liveOwnerRecovery:
      value.foreground !== "running" &&
      typeof value.live_owner_recovery === "string"
        ? value.live_owner_recovery
        : null,
    deadOwnerRecovery:
      value.foreground !== "running" &&
      typeof value.dead_owner_recovery === "string"
        ? value.dead_owner_recovery
        : null,
    deadOwnerRecoveryComplete:
      value.foreground !== "running" &&
      value.dead_owner_recovery_complete === true,
    deadOwnerRecoveryError:
      value.foreground !== "running" &&
      typeof value.dead_owner_recovery_error === "string"
        ? value.dead_owner_recovery_error
        : null,
  };
}

/**
 * After selected predecessor recovery is handled, dispatch a live/absent owner
 * to ordinary authenticated cleanup, or a dead ready owner to same-boot
 * recovery. The runtime revalidates process death and exact inventories itself;
 * this observation grants no recovery authority.
 */
async function requestOwnedStop(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
  readonly selection: ForegroundOwnerSelection | undefined;
}): Promise<void> {
  const selection = opts.selection;
  if (
    selection === undefined ||
    selection.foreground === "absent" ||
    selection.foreground === "running"
  ) {
    try {
      await opts.invoke({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: ["graph", "cleanup", "--run-id", opts.run.run, "--json"],
        timeoutMs: 590_000,
      });
    } catch (error) {
      if (
        selection === undefined &&
        error instanceof NativeRuntimeRequestError &&
        error.nativeCode === "graph_owner_recovery"
      ) {
        throw new ClosedCliError(
          "Native down cannot reach this run's foreground owner. If the hack up or hack restart that owned it has exited, run hack down --recover to stop its services with data retained. Nothing was stopped."
        );
      }
      throw error;
    }
    return;
  }
  await recoverLiveOwner({ ...opts, expectReceipt: selection.receiptSha256 });
}

/** Recovery refusals must not suggest signaling an owner already proved dead. */
async function invokeOwnerRecovery(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly invoke: typeof invokeNativeRuntime;
  readonly args: readonly string[];
}): Promise<unknown> {
  try {
    return await opts.invoke({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: opts.args,
      timeoutMs: 590_000,
    });
  } catch (error) {
    if (error instanceof NativeRuntimeRequestError) {
      throw new ClosedCliError(
        `Native down --recover could not confirm cleanup (${error.nativeCode ?? "native_request_failed"}). ${nativeRecoveryGuidance(error.nativeCode)}`
      );
    }
    throw error;
  }
}

/** Same-boot dead-owner recovery of the exact selected receipt; it resumes its own intent. */
async function recoverLiveOwner(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
  readonly expectReceipt: string;
}): Promise<void> {
  const result = await invokeOwnerRecovery({
    runtime: opts.runtime,
    projectRoot: opts.projectRoot,
    invoke: opts.invoke,
    args: [
      "graph",
      "recover-live-owner",
      "--run-id",
      opts.run.run,
      "--expect-receipt",
      opts.expectReceipt,
      "--json",
    ],
  });
  if (
    !isRecord(result) ||
    result.run !== opts.run.run ||
    result.recovered !== true ||
    result.data_retained !== true ||
    result.publisher_retired !== true
  ) {
    throw ownerRecoveryRefused();
  }
}

/**
 * A retained run whose foreground owner died before the runtime admitted its
 * restore: the receipt is still the acknowledged retained stop. "uncertain"
 * also covers a retirement of that owner interrupted between its two renames,
 * which only the runtime can tell apart from a foreign publication.
 */
function unadmittedRetainedOwner(selection: ForegroundOwnerSelection): boolean {
  return (
    selection.liveOwnerRecovery === null &&
    selection.phase === "stopped-data-retained" &&
    (selection.foreground === "exited" || selection.foreground === "uncertain")
  );
}

/**
 * Retire the dead owner of an unadmitted retained restore, selected by the exact
 * receipt observed here. The runtime proves the owner is dead, the receipt is the
 * unchanged acknowledged stop and the relay and reservation it left are that same
 * process's; it stops, creates and removes nothing in the guest.
 */
async function retireUnadmittedOwner(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
  readonly expectReceipt: string;
}): Promise<void> {
  let result: unknown;
  try {
    result = await opts.invoke({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: [
        "graph",
        "retire-unadmitted-owner",
        "--run-id",
        opts.run.run,
        "--expect-receipt",
        opts.expectReceipt,
        "--json",
      ],
      timeoutMs: 60_000,
    });
  } catch (error) {
    if (
      error instanceof NativeRuntimeRequestError &&
      error.nativeCode === "graph_unadmitted_owner_recovery"
    ) {
      throw new ClosedCliError(
        "Native down --recover could not prove that this run's foreground owner exited before its restore was admitted. Run hack ps --json to inspect this run's retained state."
      );
    }
    throw error;
  }
  if (
    !isRecord(result) ||
    result.run !== opts.run.run ||
    result.recovered !== true ||
    result.data_retained !== true ||
    result.publisher_retired !== true
  ) {
    throw ownerRecoveryRefused();
  }
}

/** Refuse `--recover` states that have no supported owned stop, before any hook. */
function requireRecoverableOwner(selection: ForegroundOwnerSelection): void {
  if (selection.foreground === "running") {
    // A lost frontend can leave its authenticated graph owner alive. Use the
    // ordinary owner-mediated stop; this grants no dead-owner recovery authority.
    return;
  }
  // An interrupted recovery resumes by its own selection, whatever the receipt
  // phase or partial publication retirement it left behind. An owner that died
  // before admission is retired by the runtime's own proof.
  if (
    selection.liveOwnerRecovery !== null ||
    selection.deadOwnerRecovery !== null ||
    unadmittedRetainedOwner(selection)
  ) {
    return;
  }
  if (selection.foreground === "uncertain") {
    throw ownerRecoveryRefused();
  }
  if (
    selection.foreground === "exited" &&
    selection.phase !== "ready-observed"
  ) {
    throw new ClosedCliError(
      "Native down --recover found a foreground owner that exited before its start was confirmed. Nothing was changed. Run hack ps --json to inspect this run's retained state."
    );
  }
}

/** Retaining cleanup only. Success follows confirmed compute absence and the
 * original frontend's finalizers, including a previously recovered stop.
 */
export async function nativeProjectDown(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly before?: (run: NativeProjectRun) => Promise<void>;
  /**
   * Runs once the down is committed: after `before` and the ownership and
   * finalization rechecks that follow it, immediately before graph cleanup is
   * requested. Effects that must only happen for a down that actually stops
   * the graph (such as marking shared helpers as stopping) belong here.
   */
  readonly beforeCleanup?: (run: NativeProjectRun) => Promise<void>;
  readonly retireHostProcesses?: (run: NativeProjectRun) => Promise<void>;
  readonly after?: (run: NativeProjectRun) => Promise<void>;
  /**
   * Journaled `down.before`/`down.after` (see `native-project-down-hooks.ts`).
   * On a live graph they run around cleanup as before. On a graph that a
   * foreground stop or recovery already stopped, only phases still owed run,
   * once, after the original frontend's finalization. `run` rejects when the
   * phase's commands fail. `configured` says whether the project declares
   * down hooks; without a journal record nothing runs when it is false.
   */
  readonly hooks?: {
    readonly configured: boolean;
    readonly run: (phase: {
      readonly phase: "before" | "after";
      readonly run: NativeProjectRun;
      readonly graphStopped: boolean;
    }) => Promise<void>;
  };
  readonly invoke?: typeof invokeNativeRuntime;
  /**
   * `hack down --recover`: also stop a ready run whose foreground owner exited
   * without retiring its publication (see {@link requestOwnedStop}), or retire
   * the owner of a retained restore that died before admission.
   */
  readonly recover?: boolean;
  /** Only the restart coordinator may defer to its already captured exact wait/recovery. */
  readonly deferFinalization?: boolean;
  readonly finalizationTimeoutMs?: number;
}) {
  const run = await loadNativeProjectRun(opts.scope);
  if (!run) {
    return {
      backend: "native",
      status: "not_started",
      dataPreserved: true,
    } as const;
  }
  const invoke = withNativeRecoveryGuidance(opts.invoke ?? invokeNativeRuntime);
  const inspect = () =>
    inspectNativeProjectGraph({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run: run.run,
      invoke,
    });
  let initial = await inspect();
  verify(initial, run, false);
  const selection = opts.recover
    ? await selectForegroundOwner({
        runtime: opts.runtime,
        projectRoot: opts.scope.projectRoot,
        run,
        invoke,
      })
    : undefined;
  if (selection) {
    if (selection.deadOwnerRecoveryError) {
      throw new ClosedCliError(
        `Native predecessor recovery selection failed (${selection.deadOwnerRecoveryError}). ${nativeRecoveryGuidance(selection.deadOwnerRecoveryError)}`
      );
    }
    requireRecoverableOwner(selection);
  }
  if (selection?.deadOwnerRecovery && selection.foreground !== "running") {
    if (!selection.deadOwnerRecoveryComplete) {
      const result = await invokeOwnerRecovery({
        runtime: opts.runtime,
        projectRoot: opts.scope.projectRoot,
        invoke,
        args: [
          "graph",
          "recover-cleanup",
          "--run-id",
          run.run,
          "--expect-receipt",
          selection.deadOwnerRecovery,
          "--json",
        ],
      });
      if (
        !isRecord(result) ||
        result.run !== run.run ||
        result.recovered !== true ||
        result.data_retained !== true
      ) {
        throw ownerRecoveryRefused();
      }
    }
    await retireNativeRecoveredPublisher({
      runtime: opts.runtime,
      scope: opts.scope,
      run,
      invoke,
    });
    initial = await inspect();
    verify(initial, run, false);
  } else if (
    selection?.liveOwnerRecovery &&
    selection.foreground !== "running"
  ) {
    // Finish the interrupted recovery first; the stopped path below then retires
    // host processes and runs only journaled owed hooks, never replaying a stop.
    await recoverLiveOwner({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run,
      invoke,
      expectReceipt: selection.liveOwnerRecovery,
    });
    initial = await inspect();
    verify(initial, run, false);
  } else if (selection && unadmittedRetainedOwner(selection)) {
    // Compute is already stopped; only the dead attempt's publications remain.
    // The stopped path below then retires host processes and owed hooks.
    await retireUnadmittedOwner({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run,
      invoke,
      expectReceipt: selection.receiptSha256,
    });
    initial = await inspect();
    verify(initial, run, false);
  }
  const finalization = opts.deferFinalization
    ? undefined
    : await captureFinalization({ scope: opts.scope, run });
  // A frontend that has exited cannot finish later, so its finalization is read
  // once before explicit retaining recovery. Only ESRCH proves the exit; PID reuse can only make
  // an exited frontend look live, which keeps the ordinary wait. HACK-1968: a
  // failed `hack up` that recorded its run for down exits without finishing it.
  const frontendGone =
    finalization !== undefined &&
    finalization.version !== 1 &&
    processExited(finalization.pid);
  const wait = async () => {
    if (finalization === undefined) {
      return;
    }
    try {
      await waitNativeProjectFinalization({
        scope: opts.scope,
        run,
        token: finalization,
        timeoutMs: frontendGone ? 1 : opts.finalizationTimeoutMs,
      });
    } catch {
      if (!frontendGone) {
        throw finalizationRefused();
      }
      if (opts.recover === true) {
        // Exact captured attempt, dead frontend, stopped graph and all frontend
        // effects are rechecked under the existing finalization lock. Recovery
        // remains a separate fact from that frontend completing its own cleanup.
        await recoverNativeProjectFinalization({
          scope: opts.scope,
          run,
          token: finalization,
          expectAttempt: finalization.attempt,
          verifyEffects: () =>
            verifyNativeFrontendRecovery({
              runtime: opts.runtime,
              scope: opts.scope,
              run,
              httpsPort: finalization.httpsPort,
              httpsLease:
                finalization.version === 3
                  ? finalization.httpsLease
                  : undefined,
              legacy: false,
              invoke,
              cleanupLifecycle: async () => {
                await opts.retireHostProcesses?.(run);
              },
            }),
        });
        await waitNativeProjectFinalization({
          scope: opts.scope,
          run,
          token: finalization,
          timeoutMs: 1,
        });
        return;
      }
      throw new ClosedCliError(
        "Native down frontend finalization is unconfirmed: this run's services are stopped with data retained, but its frontend exited before confirming cleanup. Run hack down --recover to finish retaining cleanup."
      );
    }
  };
  const hooks = opts.hooks;
  const owedAfterStop = async () => {
    if (!hooks) {
      return;
    }
    // Read only after finalization: the frontend may still be finishing them.
    const session = await openNativeDownHookSession({
      scope: opts.scope,
      run,
      graphStopped: true,
      configured: hooks.configured,
    });
    await session.before(() =>
      hooks.run({ phase: "before", run, graphStopped: true })
    );
    await session.after(() =>
      hooks.run({ phase: "after", run, graphStopped: true })
    );
  };
  const recovered = await recoverNativeInterruptedStartupCleanup({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    run,
    snapshot: initial,
    invoke,
  });
  if (recovered !== null) {
    verify(recovered, run, true);
    await opts.retireHostProcesses?.(run);
    await wait();
    await owedAfterStop();
    return {
      backend: "native",
      status: "stopped",
      run: run.run,
      dataPreserved: true,
    } as const;
  }
  if (
    isRecord(initial) &&
    isRecord(initial.receipt) &&
    initial.receipt.phase === "stopped-data-retained"
  ) {
    // Recovery or a foreground stop already stopped compute. Guest cleanup and
    // completed hooks must not replay; only journaled owed phases run once.
    verify(initial, run, true);
    await opts.retireHostProcesses?.(run);
    await wait();
    await owedAfterStop();
    return {
      backend: "native",
      status: "stopped",
      run: run.run,
      dataPreserved: true,
    } as const;
  }
  const session = hooks
    ? await openNativeDownHookSession({
        scope: opts.scope,
        run,
        graphStopped: false,
        configured: hooks.configured,
      })
    : undefined;
  await opts.before?.(run);
  if (hooks && session) {
    await session.before(() =>
      hooks.run({ phase: "before", run, graphStopped: false })
    );
  }
  // Recheck after hooks, which may run arbitrary user-authorized commands.
  verify(await inspect(), run, false);
  if (
    finalization !== undefined &&
    !isDeepStrictEqual(
      finalization,
      await captureFinalization({ scope: opts.scope, run })
    )
  ) {
    throw finalizationRefused();
  }
  await opts.beforeCleanup?.(run);
  await requestOwnedStop({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    run,
    invoke,
    selection,
  });
  verify(await inspect(), run, true);
  await opts.retireHostProcesses?.(run);
  await opts.after?.(run);
  if (hooks && session) {
    await session.after(() =>
      hooks.run({ phase: "after", run, graphStopped: true })
    );
  }
  await wait();
  return {
    backend: "native",
    status: "stopped",
    run: run.run,
    dataPreserved: true,
  } as const;
}

/**
 * Resolve fresh values with the original selection; never infer legacy/default overlays.
 * A run recorded as started without managed env files delivered none, and one started
 * base-only delivered the base layers, so their hooks get exactly that even when env
 * files appeared since: `hack down` stays the way to apply them. A run started with its
 * overlay refuses before cleanup when the overlay is gone, naming it.
 */
export async function nativeDownEnvironment(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly serviceNames: readonly string[];
}): Promise<Readonly<Record<string, string>>> {
  if (!Object.hasOwn(opts.run, "effectiveEnvName")) {
    throw new ClosedCliError(
      "Native down lifecycle hooks require persisted startup environment selection; legacy mapping must not guess an overlay."
    );
  }
  const recorded = opts.run.effectiveEnvName;
  if (recorded !== null && opts.run.unmanagedEnvironment === true) {
    return {};
  }
  const baseOnly = recorded !== null && opts.run.baseOnlyEnvironment === true;
  let named: ClosedCliError | undefined;
  try {
    const resolved = await resolveProjectEnvConfig({
      projectRoot: opts.scope.projectRoot,
      projectDir: opts.scope.projectDir,
      envName: baseOnly ? null : recorded,
      serviceNames: opts.serviceNames,
    });
    const environmentFiles = resolved?.files ?? [];
    if (!baseOnly) {
      const change = nativeRunEnvironmentChange({
        run: opts.run,
        environmentFiles,
        projectRoot: opts.scope.projectRoot,
        projectDir: opts.scope.projectDir,
      });
      if (change) {
        named = new ClosedCliError(
          `Native down refused before cleanup: ${describeNativeRunEnvironmentChange(change)}, and the down hooks need the values this run started with. Restore it and run hack down again; nothing was stopped.`
        );
        throw named;
      }
    }
    if (!resolved) {
      return {};
    }
    return selectProjectEnvValuesForExecutionTarget({
      resolved,
      scopeName: "global",
      target: "host",
    });
  } catch (error) {
    if (named !== undefined && error === named) {
      throw named;
    }
    throw new ClosedCliError(
      "Native down lifecycle environment is unavailable; values omitted. No cleanup was requested. Run hack ps --json to inspect this run's retained state."
    );
  }
}

const NATIVE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Value-free: at most a closed native refusal code, never its diagnostic. */
function removalRefused(cause?: unknown): Error {
  const code =
    cause instanceof NativeRuntimeRequestError &&
    cause.nativeCode !== undefined &&
    NATIVE_CODE.test(cause.nativeCode)
      ? ` (${cause.nativeCode})`
      : "";
  return new ClosedCliError(
    `Native data removal is unconfirmed${code}; the run mapping is kept. Run \`hack down --remove-data\` again to resume from re-inspection.`
  );
}

/** Canceled before the cleanup request: nothing was requested or removed. */
function removalCanceled(): Error {
  return new ClosedCliError(
    "Native data removal was canceled before any cleanup request; nothing was removed and the run mapping is kept."
  );
}
function requireActiveRemoval(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw removalCanceled();
  }
}

/** Thrown when the graph still runs: removal never stops compute itself. */
function removalRequiresStop(): Error {
  return new ClosedCliError(
    "Native data removal requires a stopped project; run `hack down` first, then `hack down --remove-data`. Nothing was removed."
  );
}

type RemovalStart = "retained" | "resume" | "removed";

function sameRun(receipt: Record<string, unknown>, run: NativeProjectRun) {
  return (
    receipt.run === run.run &&
    receipt.owner === run.owner &&
    receipt.namespace === run.namespace &&
    receipt.plan_id === run.planId &&
    isRecord(receipt.resources)
  );
}

/**
 * Classify the exact saved run before any removal. A retained stopped graph
 * starts removal. A durable cleanup intent with all compute absent, or an
 * already removed receipt, resumes an interrupted earlier removal. Anything
 * else (running, starting, foreign or unreadable) refuses without effects.
 */
function removalStart(value: unknown, run: NativeProjectRun): RemovalStart {
  if (confirmedNativeRetainedGraph(value, run)) {
    return "retained";
  }
  if (
    !(
      isRecord(value) &&
      value.journal_incomplete === false &&
      isRecord(value.receipt) &&
      isRecord(value.observations) &&
      sameRun(value.receipt, run)
    )
  ) {
    throw removalRefused();
  }
  const { receipt, observations } = value;
  if (receipt.phase === "stopped-data-retained") {
    // Stopped, but its resources no longer match the retained receipt.
    throw removalRefused();
  }
  if (receipt.phase !== "cleanup-intent" && receipt.phase !== "removed") {
    throw removalRequiresStop();
  }
  for (const resource of Object.values(
    receipt.resources as Record<string, unknown>
  )) {
    if (!isRecord(resource) || typeof resource.key !== "string") {
      throw removalRefused();
    }
    const observed = observations[`${resource.kind}:${resource.key}`];
    if (
      resource.kind === "container" &&
      !(isRecord(observed) && observed.state === "absent")
    ) {
      throw removalRequiresStop();
    }
  }
  return receipt.phase === "removed" ? "removed" : "resume";
}

/**
 * Confirms the owner removed every graph-owned volume of the exact run:
 * receipt `removed`, compute and networks absent, each owned volume recorded
 * and observed absent, and each shared dependency cache only `released`
 * (a graph never deletes a shared cache).
 */
function confirmRemoved(value: unknown, run: NativeProjectRun): void {
  if (
    !(
      isRecord(value) &&
      value.journal_incomplete === false &&
      isRecord(value.receipt) &&
      isRecord(value.observations) &&
      sameRun(value.receipt, run) &&
      value.receipt.phase === "removed"
    )
  ) {
    throw removalRefused();
  }
  const { observations } = value;
  for (const resource of Object.values(
    value.receipt.resources as Record<string, unknown>
  )) {
    if (!isRecord(resource) || typeof resource.key !== "string") {
      throw removalRefused();
    }
    const observed = observations[`${resource.kind}:${resource.key}`];
    const absent = isRecord(observed) && observed.state === "absent";
    if (resource.kind === "volume" && resource.cache !== undefined) {
      if (resource.phase !== "released") {
        throw removalRefused();
      }
      continue;
    }
    if (
      !["container", "network", "volume"].includes(String(resource.kind)) ||
      resource.phase !== "absent" ||
      !absent
    ) {
      throw removalRefused();
    }
  }
}

/**
 * Explicit retained-data removal for a stopped native Compose-file project
 * (Compose parity: `down --volumes`). It never stops compute or runs hooks:
 * a running graph refuses, so `hack down` must stop it first. Under the
 * native operation lock and after the original frontend's finalization, it
 * asks the graph owner for `graph cleanup --remove-data --retained-only`,
 * which deletes only receipt-owned volumes behind a durable cleanup intent
 * and releases shared dependency caches without deleting them.
 * `--retained-only` makes the owner re-check the stopped state atomically, so
 * a `hack up` elsewhere that restored the run after these frontend checks
 * makes it refuse instead of stopping that run; the frontend lock alone cannot
 * exclude that restore. The run mapping is retired only after every owned
 * volume is confirmed absent, so the next `up` starts a fresh run with new
 * empty volumes.
 *
 * Failure keeps the mapping. A rerun resumes from re-inspection: a durable
 * cleanup intent or an already removed receipt continues without replaying
 * deletion decisions. Cancellation (`signal`) before the runtime request has
 * no effect; after it the owned request is killed and awaited, the outcome is
 * unknown and the mapping stays until a rerun confirms removal. Either way
 * the lock is released before this returns. A process killed outright leaves
 * the lock behind; the rerun reclaims it once the recorded owner has exited
 * (see {@link withNativeRemovalLock}).
 */
export async function nativeProjectRemoveData(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  /**
   * Asked once, after a read-only check that the exact saved run is stopped
   * and before any lock or effect. `false` keeps everything.
   */
  readonly confirm?: () => Promise<boolean>;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly finalizationTimeoutMs?: number;
  /** Ordinary cancellation (SIGINT/SIGTERM in the command). */
  readonly signal?: AbortSignal;
}) {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const { signal } = opts;
  const inspect = (run: NativeProjectRun) =>
    inspectNativeProjectGraph({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run: run.run,
      invoke,
      signal,
    });
  const notStarted = {
    backend: "native",
    status: "not_started",
    dataPreserved: true,
  } as const;
  const selected = await loadNativeProjectRun(opts.scope);
  if (!selected) {
    return notStarted;
  }
  removalStart(await inspect(selected), selected);
  if (opts.confirm && !(await opts.confirm())) {
    return {
      backend: "native",
      status: "kept",
      run: selected.run,
      dataPreserved: true,
    } as const;
  }
  requireActiveRemoval(signal);
  return await withNativeRemovalLock(opts.scope, async () => {
    if (await loadNativeRestartIntent(opts.scope)) {
      throw new ClosedCliError(
        "Native data removal refused: a native restart is pending; finish or recover it first. Nothing was removed."
      );
    }
    // The confirmed run must still be the saved one; never remove a replacement.
    const run = await loadNativeProjectRun(opts.scope);
    if (!run) {
      return notStarted;
    }
    if (!isDeepStrictEqual(run, selected)) {
      throw removalRefused();
    }
    const start = removalStart(await inspect(run), run);
    const finalization = await captureFinalization({ scope: opts.scope, run });
    try {
      await waitNativeProjectFinalization({
        scope: opts.scope,
        run,
        token: finalization,
        timeoutMs: opts.finalizationTimeoutMs,
        signal,
      });
    } catch {
      requireActiveRemoval(signal);
      throw finalizationRefused();
    }
    requireActiveRemoval(signal);
    try {
      if (start !== "removed") {
        await invoke({
          runtime: opts.runtime,
          cwd: opts.scope.projectRoot,
          args: [
            "graph",
            "cleanup",
            "--run-id",
            run.run,
            "--remove-data",
            // Atomic stopped-only gate: the owner refuses a run restored since
            // the checks above instead of stopping it and deleting its data.
            "--retained-only",
            "--json",
          ],
          timeoutMs: 590_000,
          signal,
        });
      }
      confirmRemoved(await inspect(run), run);
      await removeNativeProjectRun({ ...opts.scope, expected: run });
    } catch (error) {
      // Native diagnostics may carry private values; the mapping stays for a rerun.
      throw removalRefused(error);
    }
    return {
      backend: "native",
      status: "removed",
      run: run.run,
      dataPreserved: false,
    } as const;
  });
}
