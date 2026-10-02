import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
import {
  loadNativeProjectRun,
  type NativeProjectRun,
  type NativeProjectRunScope,
} from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

function refused(): Error {
  return new Error(
    "Native down cleanup is unconfirmed; retained mapping and runtime state require inspection. No cleanup was replayed."
  );
}
function finalizationRefused(): Error {
  return new Error(
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
    throw new Error(
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
    throw new Error(
      "Native down lifecycle environment is unavailable; values omitted. No cleanup was requested."
    );
  }
}
