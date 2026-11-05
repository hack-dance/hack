import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  resolveProjectEnvConfig,
  selectProjectEnvValuesForExecutionTarget,
} from "../lib/project-env-config.ts";
import {
  captureNativeProjectFinalization,
  type NativeProjectFinalizationToken,
  waitNativeProjectFinalization,
} from "./native-project-finalization.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import { recoverNativeInterruptedStartupCleanup } from "./native-project-interrupted-cleanup.ts";
import { withNativeRemovalLock } from "./native-project-removal-lock.ts";
import { confirmedNativeRetainedGraph } from "./native-project-retained.ts";
import {
  loadNativeProjectRun,
  loadNativeRestartIntent,
  type NativeProjectRun,
  type NativeProjectRunScope,
  removeNativeProjectRun,
} from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

function refused(): Error {
  return new ClosedCliError(
    "Native down cleanup is unconfirmed; retained mapping and runtime state require inspection. No cleanup was replayed."
  );
}
function finalizationRefused(): Error {
  return new ClosedCliError(
    "Native down frontend finalization is unconfirmed or its ownership changed; retained mapping and runtime state require inspection. No cleanup was replayed."
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
  readonly invoke?: typeof invokeNativeRuntime;
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
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const inspect = () =>
    inspectNativeProjectGraph({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run: run.run,
      invoke,
    });
  const initial = await inspect();
  verify(initial, run, false);
  const finalization = opts.deferFinalization
    ? undefined
    : await captureFinalization({ scope: opts.scope, run });
  const wait = async () => {
    if (finalization === undefined) {
      return;
    }
    try {
      await waitNativeProjectFinalization({
        scope: opts.scope,
        run,
        token: finalization,
        timeoutMs: opts.finalizationTimeoutMs,
      });
    } catch {
      throw finalizationRefused();
    }
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
    // Recovery already stopped compute. User hooks and guest cleanup must not replay.
    verify(initial, run, true);
    await opts.retireHostProcesses?.(run);
    await wait();
    return {
      backend: "native",
      status: "stopped",
      run: run.run,
      dataPreserved: true,
    } as const;
  }
  await opts.before?.(run);
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
  await invoke({
    runtime: opts.runtime,
    cwd: opts.scope.projectRoot,
    args: ["graph", "cleanup", "--run-id", run.run, "--json"],
    timeoutMs: 590_000,
  });
  verify(await inspect(), run, true);
  await opts.retireHostProcesses?.(run);
  await opts.after?.(run);
  await wait();
  return {
    backend: "native",
    status: "stopped",
    run: run.run,
    dataPreserved: true,
  } as const;
}

/** Resolve fresh values with the original selection; never infer legacy/default overlays. */
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
  try {
    const resolved = await resolveProjectEnvConfig({
      projectRoot: opts.scope.projectRoot,
      projectDir: opts.scope.projectDir,
      envName: opts.run.effectiveEnvName,
      serviceNames: opts.serviceNames,
    });
    if (!resolved) {
      if (opts.run.effectiveEnvName !== null) {
        throw refused();
      }
      return {};
    }
    const selected = opts.run.effectiveEnvName;
    if (
      selected !== null &&
      !resolved.files.some((path) =>
        [
          `hack.env.${selected}.yaml`,
          `hack.env.${selected}.local.yaml`,
        ].includes(basename(path))
      )
    ) {
      throw refused();
    }
    return selectProjectEnvValuesForExecutionTarget({
      resolved,
      scopeName: "global",
      target: "host",
    });
  } catch {
    throw new ClosedCliError(
      "Native down lifecycle environment is unavailable; values omitted. No cleanup was requested."
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
 * restart lock and after the original frontend's finalization, it asks the
 * graph owner for `graph cleanup --remove-data`, which deletes only
 * receipt-owned volumes behind a durable cleanup intent and releases shared
 * dependency caches without deleting them. The run mapping is retired only
 * after every owned volume is confirmed absent, so the next `up` starts a
 * fresh run with new empty volumes.
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
