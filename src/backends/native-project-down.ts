import { isDeepStrictEqual } from "node:util";
import { ClosedCliError, HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  resolveProjectEnvConfig,
  selectProjectEnvValuesForExecutionTarget,
} from "../lib/project-env-config.ts";
import { awaitNativeEndedBootOwner } from "./native-ended-boot-owner.ts";
import {
  nativeFrontendGone,
  nativeFrontendGoneSettled,
} from "./native-frontend-identity.ts";
import { openNativeDownHookSession } from "./native-project-down-hooks.ts";
import {
  captureNativeProjectFinalization,
  inspectNativeProjectFinalizationLifetime,
  type NativeProjectFinalizationToken,
  nativeFinalizationLeaseAdded,
  orphanNativeProjectLifetime,
  recoverNativeProjectFinalization,
  waitNativeProjectFinalization,
} from "./native-project-finalization.ts";
import {
  inspectNativeProjectGraph,
  isNativeProviderBusy,
  observeStartingNativeProjectGraph,
} from "./native-project-inspect.ts";
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
  nativeProjectStartupPending,
  nativeRunEnvironmentChange,
  removeNativeProjectRun,
} from "./native-project-run.ts";
import { nativeProjectRuntimeUpArgs } from "./native-project-runtime-up.ts";
import {
  invokeNativeRuntime,
  isNativeRuntimeNotRunning,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";
import { recoverExitedNativeRuntime } from "./native-runtime-preflight.ts";

function refused(): Error {
  return new ClosedCliError(
    "Native down cleanup is unconfirmed; no cleanup was replayed. Run hack ps --json to inspect this run's retained state."
  );
}
function finalizationRefused(): Error {
  return new ClosedCliError(
    "Native down frontend finalization is unconfirmed or its ownership changed; no cleanup was replayed, so rerunning hack down is safe. Run hack ps --json to inspect this run's retained state."
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
function verify(
  value: unknown,
  run: NativeProjectRun,
  stopped: boolean,
  recovering = false
): void {
  if (
    !(
      isRecord(value) &&
      isRecord(value.receipt) &&
      isRecord(value.observations)
    ) ||
    (value.journal_incomplete !== false &&
      !(
        recovering &&
        !stopped &&
        value.journal_incomplete === true &&
        (value.receipt.phase === "ready-observed" ||
          value.receipt.phase === "reconciled-cleanup-only")
      ))
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

const FOREGROUND_STATES = new Set(["absent", "running", "exited", "uncertain"]);
/**
 * Graph phases in which an exited foreground owner is recovered: ready, or every
 * service started with some goal still unmet (`started-observed`, written only
 * under `--report-started`). Only a run with a saved mapping gets here. A fresh
 * start saves its mapping only at ready today, so in the started phase this is a
 * restored run; PR B saves the mapping at started.
 */
const RECOVERABLE_LIVE_PHASES: ReadonlySet<string> = new Set([
  "ready-observed",
  "started-observed",
  "reconciled-cleanup-only",
]);

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
  readonly failedStartRecoverable: boolean;
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
    !optionalBoolean(value.failed_start_recoverable) ||
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
    failedStartRecoverable: value.failed_start_recoverable === true,
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

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

/**
 * After selected predecessor recovery is handled, dispatch a live/absent owner
 * to ordinary authenticated cleanup, or a provably recoverable dead owner to same-boot
 * recovery. The runtime revalidates process death and exact inventories itself;
 * this observation grants no recovery authority.
 */
async function requestOwnedStop(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly scope: NativeProjectRunScope;
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
        const observed = await selectForegroundOwner(opts);
        requireRecoverableOwner(observed);
        if (await resumeSelectedOwner({ ...opts, selection: observed })) {
          return;
        }
        if (observed.foreground !== "exited") {
          throw ownerRecoveryRefused();
        }
        await recoverLiveOwner({
          ...opts,
          expectReceipt: observed.receiptSha256,
        });
        return;
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
    !RECOVERABLE_LIVE_PHASES.has(selection.phase) &&
    !selection.failedStartRecoverable
  ) {
    throw new ClosedCliError(
      `Native down --recover found a foreground owner that exited before its start was confirmed. The runtime could not prove which resources to retire. ${nativeRecoveryGuidance("graph_live_owner_recovery")}`
    );
  }
}

/** Resume only an existing exact recovery selection. Shared by explicit
 * recovery and plain down after an authenticated dead-owner refusal. */
async function resumeSelectedOwner(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
  readonly selection: ForegroundOwnerSelection;
}): Promise<boolean> {
  const { run, invoke, selection } = opts;
  if (selection.deadOwnerRecoveryError) {
    throw new ClosedCliError(
      `Native predecessor recovery selection failed (${selection.deadOwnerRecoveryError}). ${nativeRecoveryGuidance(selection.deadOwnerRecoveryError)}`
    );
  }
  requireRecoverableOwner(selection);
  if (selection.deadOwnerRecovery && selection.foreground !== "running") {
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
    return true;
  }
  if (selection.liveOwnerRecovery && selection.foreground !== "running") {
    // Finish the interrupted recovery first; the stopped path below then retires
    // host processes and runs only journaled owed hooks, never replaying a stop.
    await recoverLiveOwner({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run,
      invoke,
      expectReceipt: selection.liveOwnerRecovery,
    });
    return true;
  }
  if (unadmittedRetainedOwner(selection)) {
    // Compute is already stopped; only the dead attempt's publications remain.
    // The stopped path below then retires host processes and owed hooks.
    await retireUnadmittedOwner({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run,
      invoke,
      expectReceipt: selection.receiptSha256,
    });
    return true;
  }
  return false;
}

/** Retaining cleanup only. Success follows confirmed compute absence and the
 * original frontend's finalizers, including a previously recovered stop.
 */
/** How often a down that waits for an unpublished start checks it again. */
const STARTUP_WAIT_POLL_MS = 500;

/** After this long, a `down` that still waits for its run's frontend says so. */
export const FINALIZATION_NOTICE_MS = 5000;

/**
 * Run `wait`, printing `line` once if it is still pending after `afterMs`
 * (#1271: a `down` that waited for its frontend printed nothing at all).
 */
export async function withSlowNotice<T>(opts: {
  readonly wait: () => Promise<T>;
  readonly line: string;
  readonly afterMs?: number;
  readonly notice?: (line: string) => void;
}): Promise<T> {
  const timer = setTimeout(
    () =>
      (opts.notice ?? ((line: string) => process.stderr.write(`${line}\n`)))(
        opts.line
      ),
    opts.afterMs ?? FINALIZATION_NOTICE_MS
  );
  try {
    return await opts.wait();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait for a live start of this instance to end (HACK-2351): a detached start
 * whose launcher gave up can still hold the native runtime while it builds or
 * unwinds. With `untilPublished`, also return as soon as it has published a
 * run. Waits at most `waitMs` (default 120 s); a start still alive then
 * refuses: the down stopped nothing and must not report success. True when
 * there was a start to wait for.
 */
async function awaitPendingStartup(opts: {
  readonly scope: NativeProjectRunScope;
  readonly waitMs?: number;
  readonly untilPublished: boolean;
  /**
   * A start that resumes a retained run keeps its owner (and its startup
   * marker) for the services' lifetime: when this reports the graph live
   * again, stop waiting and stop it (see {@link RetainedRunResumed}).
   */
  readonly resumed?: () => Promise<boolean>;
  /** Where the one-line wait notice goes; stderr by default. */
  readonly notice?: (line: string) => void;
}): Promise<boolean> {
  const waitMs = opts.waitMs ?? 120_000;
  const deadline = performance.now() + waitMs;
  let waited = false;
  while (await nativeProjectStartupPending(opts.scope)) {
    if (!waited) {
      // Say what this command waits for, once (HACK-2550).
      (opts.notice ?? ((line: string) => process.stderr.write(`${line}\n`)))(
        `Waiting up to ${Math.ceil(waitMs / 1000)} s for an earlier start of this instance to end; a start whose native runtime stopped ends on its own within about 11 s.`
      );
    }
    waited = true;
    if (opts.untilPublished && (await loadNativeProjectRun(opts.scope))) {
      return true;
    }
    if (await opts.resumed?.()) {
      throw new RetainedRunResumed();
    }
    if (performance.now() >= deadline) {
      throw new HackCliError({
        code: "E_DOWN_INCOMPLETE",
        message:
          "A native start of this instance is still running or unwinding (its owner process is alive), so nothing was stopped. Run hack down again once it ends; meanwhile hack ps --json reports status pending.",
      });
    }
    await Bun.sleep(STARTUP_WAIT_POLL_MS);
  }
  return waited;
}

/**
 * Raised inside a down when a start resumed the retained run it waited on:
 * that run has a new owner and finalization, so {@link nativeProjectDown}
 * begins once more from the mapping and stops the resumed graph.
 */
class RetainedRunResumed extends Error {}

/**
 * Raised inside a down that found the pool stopped under a run whose
 * foreground owner is dead, after it started the pool (HACK-2456):
 * {@link nativeProjectDown} begins once more, never starting it again, and
 * the ordinary dead-owner recovery then stops the run with data retained.
 */
class StoppedPoolStarted extends Error {}

/** Shown after a down started the pool to recover its run (HACK-2456). */
export const NATIVE_RECOVERY_RUNTIME_STARTED_NOTE =
  "The native runtime was started to recover this run and is still running; run `runtime down` to stop it.";

/**
 * Whether the lock-free `graph foreground-owner` selection (host files only;
 * it needs no running pool) shows an exited owner whose run the recovery after a
 * boot can still recover. Starting the pool begins a new boot, so only the
 * cross-boot dead-owner recovery applies: a ready run, or an interrupted
 * dead-owner recovery resuming by its own selection. The same-boot recoveries
 * (`recover-live-owner`, which a recoverable failed start and an interrupted
 * live-owner recovery use) need the original boot's relay identity and cannot run
 * after it, so those cases, an exited owner of a start that was never confirmed
 * (`preparing`, `restoring`), a live, absent or uncertain owner, a retained stop
 * (whose unadmitted owner is retired without the pool) and an unreadable
 * selection are all false: the caller keeps its refusal and never starts a pool
 * it could not then use.
 */
async function deadOwnerOfLiveRun(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly projectRoot: string;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
}): Promise<boolean> {
  try {
    const selection = await selectForegroundOwner(opts);
    // A pending same-boot recovery is resumed by its own selection after the
    // boot too, through recover-live-owner, which a new boot refuses.
    if (selection.liveOwnerRecovery !== null) {
      return false;
    }
    if (
      selection.foreground === "exited" &&
      (RECOVERABLE_LIVE_PHASES.has(selection.phase) ||
        selection.deadOwnerRecovery !== null)
    ) {
      return true;
    }
    // A recovery that stopped the graph and retired the owner's publication,
    // then failed in its frontend finalization (the shared HTTPS lease, HACK-2456
    // seen on a real VM), leaves a retained stop with no owner and an
    // interrupted frontend lifetime. Finishing it needs a running pool.
    return (
      selection.foreground === "absent" &&
      selection.phase === "stopped-data-retained" &&
      (
        await inspectNativeProjectFinalizationLifetime({
          scope: opts.scope,
          run: opts.run,
        })
      ).state === "interrupted"
    );
  } catch {
    return false;
  }
}

/**
 * The first inspection of a down. When it finds the pool stopped and
 * `startStoppedPool` allows it, a dead owner of a live run (see
 * {@link deadOwnerOfLiveRun}) gets the pool started with the arguments every
 * start sends, then {@link StoppedPoolStarted} makes the down begin again.
 * Anything else keeps the inspection's refusal.
 */
async function inspectOrStartStoppedPool(opts: {
  readonly inspect: () => Promise<unknown>;
  readonly startStoppedPool: boolean;
  readonly scope: NativeProjectRunScope;
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
  /** Where the one-line wait notice goes; stderr by default. */
  readonly notice?: (line: string) => void;
  readonly poolBootEnded?: (home: string) => Promise<boolean>;
  readonly endedBootOwnerWaitMs?: number;
}): Promise<unknown> {
  try {
    return await opts.inspect();
  } catch (error) {
    // HACK-2579: the pool's provider exited while its record still says running.
    // `runtime recover` records it stopped (under the lease, identity checked);
    // the down then begins again on a stopped pool.
    if (
      error instanceof NativeRuntimeRequestError &&
      error.nativeCode === "process_identity_unavailable" &&
      (await recoverExitedNativeRuntime({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        invoke: opts.invoke,
      }))
    ) {
      throw new ExitedPoolRecovered();
    }
    if (!isNativeRuntimeNotRunning(error)) {
      throw error;
    }
    // HACK-2572: the run's owner of a boot that has ended may still be exiting;
    // wait for it, bounded, before deciding as before.
    const ended = opts.poolBootEnded;
    await awaitNativeEndedBootOwner({
      home: opts.runtime.home,
      waitMs: opts.endedBootOwnerWaitMs,
      read: ended
        ? async (home) =>
            (await ended(home)) ? { token: "", phase: "stopped" } : undefined
        : undefined,
      notice:
        opts.notice ?? ((line: string) => process.stderr.write(`${line}\n`)),
      // Running, or ending (HACK-2572): an exited but unreaped process, or a
      // publication read mid-change, shows as uncertain for a moment.
      ownerRunning: async () => {
        const foreground = (
          await selectForegroundOwner(opts).catch(() => undefined)
        )?.foreground;
        return foreground === "running" || foreground === "uncertain";
      },
    });
    if (!(opts.startStoppedPool && (await deadOwnerOfLiveRun(opts)))) {
      throw error;
    }
  }
  await opts.invoke({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: [...nativeProjectRuntimeUpArgs(opts.projectRoot), "--json"],
  });
  throw new StoppedPoolStarted();
}

/** Raised inside a down that recovered a pool whose provider exited (HACK-2579). */
class ExitedPoolRecovered extends Error {
  constructor() {
    super(
      "The native runtime's provider had exited and the pool was recovered, but this down still found it unavailable; nothing else was changed. Run hack down again."
    );
  }
}

/** Whether an inspected graph is stopped with its data retained. */
function stoppedRetained(snapshot: unknown): boolean {
  return (
    isRecord(snapshot) &&
    isRecord(snapshot.receipt) &&
    snapshot.receipt.phase === "stopped-data-retained"
  );
}

/**
 * The run a down acts on: the published one, or, when there is none yet, the
 * one a still-alive start of this instance publishes while the down waits
 * for it (see {@link awaitPendingStartup}); null when that start ended without
 * one. The restart coordinator, which owns its own start, never waits here.
 */
async function downRun(opts: {
  readonly scope: NativeProjectRunScope;
  readonly deferFinalization?: boolean;
  readonly startupWaitMs?: number;
}): Promise<NativeProjectRun | null> {
  const run = await loadNativeProjectRun(opts.scope);
  if (run || opts.deferFinalization) {
    return run;
  }
  await awaitPendingStartup({
    scope: opts.scope,
    waitMs: opts.startupWaitMs,
    untilPublished: true,
  });
  // A start that crashed after registering its lifetime and before publishing
  // its mapping is still found, from the lifetime record (same run identity).
  return (
    (await loadNativeProjectRun(opts.scope)) ??
    (await orphanNativeProjectLifetime(opts.scope))
  );
}

async function nativeProjectDownOnce(opts: {
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
  /** How long to wait for an unpublished start to end (tests shorten it). */
  readonly startupWaitMs?: number;
  /**
   * Set by {@link nativeProjectDown} on the first attempt only: a stopped pool
   * under a dead owner's live run may be started once (HACK-2456).
   */
  readonly startStoppedPool?: boolean;
  /** Test seams of the HACK-2572 wait: the pool record proof and its bound. */
  readonly poolBootEnded?: (home: string) => Promise<boolean>;
  readonly endedBootOwnerWaitMs?: number;
}) {
  const run = await downRun(opts);
  if (!run) {
    return {
      backend: "native",
      status: "not_started",
      dataPreserved: true,
    } as const;
  }
  const invoke = withNativeRecoveryGuidance(opts.invoke ?? invokeNativeRuntime);
  const leased = (busyWaitMs?: number) =>
    inspectNativeProjectGraph({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run: run.run,
      invoke,
      busyWaitMs,
    });
  // A warming start or append holds the lease while its owner can answer a
  // stop. A lease-free snapshot pins the same run before we ask that owner.
  const inspect = async () => {
    try {
      return await leased(0);
    } catch (error) {
      if (!isNativeProviderBusy(error)) {
        throw error;
      }
      const observed = await observeStartingNativeProjectGraph({
        runtime: opts.runtime,
        projectRoot: opts.scope.projectRoot,
        run: run.run,
        invoke,
      }).catch(() => undefined);
      if (
        isRecord(observed) &&
        isRecord(observed.receipt) &&
        observed.receipt.phase === "started-observed"
      ) {
        return observed;
      }
      if (
        await appendingNativeGraph(observed, {
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          run,
          invoke,
        })
      ) {
        return observed;
      }
      return await leased();
    }
  };
  let initial = await inspectOrStartStoppedPool({
    inspect,
    startStoppedPool: opts.startStoppedPool === true,
    scope: opts.scope,
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    run,
    invoke,
    poolBootEnded: opts.poolBootEnded,
    endedBootOwnerWaitMs: opts.endedBootOwnerWaitMs,
  });
  verify(initial, run, false, opts.recover === true);
  // A failure after started is kept beside the receipt until `down` clears it
  // (the restart coordinator's down leaves it to the next start).
  const failureRecorded =
    isRecord(initial) && initial.failed_after_started !== undefined;
  const clearFailure = async () => {
    if (failureRecorded && !opts.deferFinalization) {
      await invoke({
        runtime: opts.runtime,
        cwd: opts.scope.projectRoot,
        args: [
          "graph",
          "clear-failure-after-started",
          "--run-id",
          run.run,
          "--json",
        ],
      });
    }
  };
  // A start that returned at started may still add its HTTPS lease to this
  // same lifetime (version 2 to 3, same attempt) before the stop; see below.
  let finalization = opts.deferFinalization
    ? undefined
    : await captureFinalization({ scope: opts.scope, run });
  const frontendGone =
    finalization !== undefined &&
    finalization.version !== 1 &&
    (await nativeFrontendGone(finalization));
  // A failed foreground start must remain stoppable by plain down. Selection
  // grants no authority: the runtime rechecks exact death, boot and receipt.
  const selection =
    opts.recover || frontendGone
      ? await selectForegroundOwner({
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          run,
          invoke,
        })
      : undefined;
  if (
    selection &&
    (await resumeSelectedOwner({
      runtime: opts.runtime,
      scope: opts.scope,
      run,
      invoke,
      selection,
    }))
  ) {
    initial = await inspect();
    verify(initial, run, false);
  }
  const wait = async () => {
    // The lifetime as last captured (it may have gained its HTTPS lease).
    const captured = finalization;
    if (captured === undefined) {
      return;
    }
    let latest = captured;
    try {
      // A started return takes its HTTPS lease at the owner's ready line,
      // beside this stop (HACK-2707): the same frontend may add the lease to
      // its lifetime (version 2 to 3, same attempt) while we wait. Follow it
      // once, then wait on the lifetime that now carries it.
      for (;;) {
        try {
          const token = latest;
          await withSlowNotice({
            line: "Waiting for this run's frontend to finish its cleanup: its HTTPS lease release or recovery. Retiring an exited HTTPS owner usually finishes within about 35 s after the services stop; the release is then verified against the stopped graph.",
            wait: () =>
              waitNativeProjectFinalization({
                scope: opts.scope,
                run,
                token,
                timeoutMs: frontendGone ? 1 : opts.finalizationTimeoutMs,
              }),
          });
          break;
        } catch (error) {
          const current = await captureFinalization({
            scope: opts.scope,
            run,
          }).catch(() => undefined);
          if (!(current && nativeFinalizationLeaseAdded(latest, current))) {
            throw error;
          }
          latest = current;
          finalization = current;
        }
      }
    } catch {
      const token = latest;
      // The wait just saw the frontend gone without completion; one unreadable
      // `ps` row under load must not turn that into "still running" (HACK-2372).
      if (token.version === 1 || !(await nativeFrontendGoneSettled(token))) {
        throw finalizationRefused();
      }
      // Exact captured attempt, dead frontend, stopped graph and all frontend
      // effects are rechecked under the existing finalization lock. Recovery
      // remains a separate fact from that frontend completing its own cleanup.
      await recoverNativeProjectFinalization({
        scope: opts.scope,
        run,
        token,
        expectAttempt: token.attempt,
        verifyEffects: () =>
          verifyNativeFrontendRecovery({
            runtime: opts.runtime,
            scope: opts.scope,
            run,
            httpsPort: token.httpsPort,
            httpsLease: token.version === 3 ? token.httpsLease : undefined,
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
        token,
        timeoutMs: 1,
      });
      return;
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
    await clearFailure();
    return {
      backend: "native",
      status: "stopped",
      run: run.run,
      dataPreserved: true,
    } as const;
  }
  if (
    stoppedRetained(initial) &&
    !opts.deferFinalization &&
    // A stopped retained run with a live start of the instance: a new `up` is
    // resuming it. Wait for that start before calling the instance stopped;
    // if it brought the graph back, stop it below (HACK-2351).
    (await awaitPendingStartup({
      scope: opts.scope,
      waitMs: opts.startupWaitMs,
      untilPublished: false,
      resumed: async () => !stoppedRetained(await inspect()),
    }))
  ) {
    initial = await inspect();
    verify(initial, run, false);
  }
  if (stoppedRetained(initial)) {
    // Recovery or a foreground stop already stopped compute. Guest cleanup and
    // completed hooks must not replay; only journaled owed phases run once.
    verify(initial, run, true);
    await opts.retireHostProcesses?.(run);
    await wait();
    await owedAfterStop();
    await clearFailure();
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
  verify(await inspect(), run, false, opts.recover === true);
  if (finalization !== undefined) {
    const current = await captureFinalization({ scope: opts.scope, run });
    if (nativeFinalizationLeaseAdded(finalization, current)) {
      finalization = current;
    } else if (!isDeepStrictEqual(finalization, current)) {
      throw finalizationRefused();
    }
  }
  await opts.beforeCleanup?.(run);
  await requestOwnedStop({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    scope: opts.scope,
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
  await clearFailure();
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

/**
 * Stop an instance's native run. See {@link nativeProjectDownOnce}. A down
 * that waited on a start resuming the retained run begins once more, with no
 * further startup wait, so it stops the resumed graph under its new owner.
 *
 * A down that found the pool stopped under a run whose foreground owner is
 * dead starts the pool and begins once more (HACK-2456); it never starts the
 * pool twice, leaves it running and reports `runtimeStarted`. The restart
 * coordinator (`deferFinalization`) never starts it.
 */
export async function nativeProjectDown(
  opts: Omit<Parameters<typeof nativeProjectDownOnce>[0], "startStoppedPool">
): Promise<
  Awaited<ReturnType<typeof nativeProjectDownOnce>> & {
    readonly runtimeStarted?: true;
  }
> {
  let started = false;
  let startupWaitMs = opts.startupWaitMs;
  let resumed = false;
  let recovered = false;
  for (;;) {
    try {
      const result = await nativeProjectDownOnce({
        ...opts,
        startStoppedPool: opts.deferFinalization !== true && !started,
        startupWaitMs,
      });
      return started ? { ...result, runtimeStarted: true } : result;
    } catch (error) {
      if (error instanceof StoppedPoolStarted && !started) {
        started = true;
        continue;
      }
      if (error instanceof ExitedPoolRecovered && !recovered) {
        recovered = true;
        continue;
      }
      if (error instanceof RetainedRunResumed && !resumed) {
        resumed = true;
        startupWaitMs = 0;
        continue;
      }
      throw error;
    }
  }
}

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
  // The owner of a run that returned at started refuses removal until ready.
  if (
    cause instanceof NativeRuntimeRequestError &&
    cause.nativeCode === "graph_starting"
  ) {
    return new ClosedCliError(
      "Native data removal waits for the project to finish starting (graph_starting); nothing was removed. Run `hack down` to stop it with data retained, then `hack down --remove-data`."
    );
  }
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

/** Steady running graphs require an explicit retaining stop. */
function removalRequiresStop(): Error {
  return new ClosedCliError(
    "Native data removal requires a stopped project; run `hack down` first, then `hack down --remove-data`. Nothing was removed."
  );
}

/**
 * The owner had no active append when the guarded stop arrived. That covers a
 * commit during the confirmation, an append that failed and rolled back, an
 * append whose own CLI was canceled, and a refused rollback, so the wording
 * names none of them. Nothing was stopped or removed.
 */
function removalAppendNotActive(): Error {
  return new ClosedCliError(
    "The service add is no longer in progress (it finished or was rolled back), so the project is still running. Nothing was removed. Run `hack down`, then `hack down --remove-data`."
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

async function appendingNativeGraph(
  observed: unknown,
  opts: {
    readonly runtime: NativeRuntimeSelection;
    readonly projectRoot: string;
    readonly run: NativeProjectRun;
    readonly invoke: typeof invokeNativeRuntime;
    readonly signal?: AbortSignal;
  }
): Promise<boolean> {
  const { run, runtime, projectRoot, invoke, signal } = opts;
  if (
    !(
      isRecord(observed) &&
      isRecord(observed.receipt) &&
      sameRun(observed.receipt, run)
    ) ||
    observed.receipt.phase !== "ready-observed"
  ) {
    return false;
  }
  const extending = observed.receipt.extending;
  if (Array.isArray(extending) && extending.length > 0) {
    return true;
  }
  // Prior to the first receipt write, the append only shows up on the owner socket.
  const owner = await invoke({
    runtime,
    cwd: projectRoot,
    args: ["graph", "owner-status", "--run-id", run.run, "--json"],
    timeoutMs: 2000,
    signal,
  }).catch(() => undefined);
  return (
    isRecord(owner) &&
    owner.ok === true &&
    owner.run === run.run &&
    owner.plan === run.planId &&
    owner.runtime_error === "graph_starting"
  );
}

async function stopAppendingNativeGraph(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { runtime, projectRoot, run, invoke, signal } = opts;
  requireActiveRemoval(signal);
  try {
    await invoke({
      runtime,
      cwd: projectRoot,
      args: [
        "graph",
        "cleanup",
        "--run-id",
        run.run,
        "--cancel-append",
        "--json",
      ],
      timeoutMs: 590_000,
      signal,
    });
  } catch (error) {
    // The owner refuses when no append is active any more: it committed,
    // rolled back or failed while the confirmation was open.
    if (
      error instanceof NativeRuntimeRequestError &&
      error.nativeCauseCode === "graph_append_not_active"
    ) {
      throw removalAppendNotActive();
    }
    throw removalRefused(error);
  }
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
 * (Compose parity: `down --volumes`). An append in progress can be canceled
 * with a retaining stop that only the appending owner may accept. A steady
 * running graph requires a separate stop. Under the
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
   * Asked once, after observing the exact saved run stopped or appending
   * and before any lock or effect. `false` keeps everything.
   */
  readonly confirm?: (appending: boolean) => Promise<boolean>;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly finalizationTimeoutMs?: number;
  /** Ordinary cancellation (SIGINT/SIGTERM in the command). */
  readonly signal?: AbortSignal;
}) {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const { signal } = opts;
  const inspect = (run: NativeProjectRun, busyWaitMs?: number) =>
    inspectNativeProjectGraph({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run: run.run,
      invoke,
      signal,
      busyWaitMs,
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
  let observed: unknown;
  let providerBusy = false;
  try {
    observed = await inspect(selected, 0);
  } catch (error) {
    if (!isNativeProviderBusy(error)) {
      throw error;
    }
    providerBusy = true;
    observed = await observeStartingNativeProjectGraph({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run: selected.run,
      invoke,
      signal,
    }).catch(() => undefined);
  }
  const appending = await appendingNativeGraph(observed, {
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    run: selected,
    invoke,
    signal,
  });
  if (!appending) {
    removalStart(providerBusy ? await inspect(selected) : observed, selected);
  }
  if (opts.confirm && !(await opts.confirm(appending))) {
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
    const finalization = await captureFinalization({ scope: opts.scope, run });
    if (appending) {
      await stopAppendingNativeGraph({
        runtime: opts.runtime,
        projectRoot: opts.scope.projectRoot,
        run,
        invoke,
        signal,
      });
    }
    const start = removalStart(await inspect(run), run);
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
