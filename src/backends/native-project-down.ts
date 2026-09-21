import { isRecord } from "../lib/guards.ts";
import {
  loadNativeProjectRun,
  type NativeProjectRun,
  type NativeProjectRunScope,
  removeNativeProjectRun,
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
/** Retaining cleanup only; lifecycle hooks surround confirmed native cleanup, never Compose. */
export async function nativeProjectDown(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly before?: () => Promise<void>;
  readonly after?: () => Promise<void>;
  readonly invoke?: typeof invokeNativeRuntime;
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
    invoke({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      args: ["graph", "inspect", "--run-id", run.run, "--json"],
      timeoutMs: 30_000,
    });
  verify(await inspect(), run, false);
  await opts.before?.();
  // Recheck after hooks, which may run arbitrary user-authorized commands.
  verify(await inspect(), run, false);
  await invoke({
    runtime: opts.runtime,
    cwd: opts.scope.projectRoot,
    args: ["graph", "cleanup", "--run-id", run.run, "--json"],
    timeoutMs: 150_000,
  });
  verify(await inspect(), run, true);
  await removeNativeProjectRun({ ...opts.scope, expected: run });
  await opts.after?.();
  return {
    backend: "native",
    status: "stopped",
    run: run.run,
    dataPreserved: true,
  } as const;
}
