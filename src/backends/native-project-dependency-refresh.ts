import { isRecord } from "../lib/guards.ts";
import {
  loadNativeProjectRun,
  type NativeProjectRunScope,
} from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const GENERATION = /^[a-f0-9]{64}$/;
// Only audited, value-free runtime identifiers may cross this error boundary.
// Unknown future codes retain the generic refusal until explicitly reviewed here.
const REFRESH_DIAGNOSTIC_CODES = new Set([
  "engine_protocol",
  "foreign_state",
  "graph_cancelled",
  "graph_dependency_completed_identity",
  "graph_dependency_endpoint_changed",
  "graph_dependency_rebind_cancelled",
  "graph_dependency_rebind_cleanup",
  "graph_dependency_rebind_incomplete",
  "graph_dependency_rebind_launch",
  "graph_dependency_rebind_readiness",
  "graph_dependency_rebind_stop",
  "graph_dependency_refresh_refused",
  "graph_owner_recovery",
  "graph_publisher_retirement",
  "graph_startup",
  "host_endpoint_identity",
  "invalid_receipt",
  "provider_acquisition_cancelled",
  "provider_busy",
  "provider_home_missing",
  "provider_state",
  "recovery_required",
]);

function refused(cause?: unknown): Error {
  let diagnostic = "";
  if (
    cause instanceof NativeRuntimeRequestError &&
    cause.nativeCode &&
    REFRESH_DIAGNOSTIC_CODES.has(cause.nativeCode)
  ) {
    const nested =
      cause.nativeCauseCode &&
      REFRESH_DIAGNOSTIC_CODES.has(cause.nativeCauseCode)
        ? `: ${cause.nativeCauseCode}`
        : "";
    diagnostic = ` Native diagnostic: ${cause.nativeCode}${nested}.`;
  }
  return new Error(
    `Native dependency refresh identity or outcome is unconfirmed; inspect the owned graph before retrying. No request or command was replayed.${diagnostic}`
  );
}

function validSlots(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (slot) => Number.isSafeInteger(slot) && slot >= 0 && slot < 32
    ) &&
    new Set(value).size === value.length
  );
}

/**
 * Refresh only this live owner's admitted dependency selectors before command
 * selection or private delivery. The owner supplies its pinned plan/generation;
 * the frontend never supplies new endpoint authority or replays an uncertain reply.
 */
export async function refreshNativeProjectDependencies(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly invoke?: typeof invokeNativeRuntime;
}) {
  const mapping = await loadNativeProjectRun(opts.scope);
  if (!mapping) {
    throw new Error(
      "Native project has not been started; dependency refresh requires a started project."
    );
  }
  try {
    const response = await (opts.invoke ?? invokeNativeRuntime)({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      args: [
        "graph",
        "refresh-dependencies",
        "--run-id",
        mapping.run,
        "--json",
      ],
      timeoutMs: 180_000,
    });
    if (
      !isRecord(response) ||
      response.ok !== true ||
      response.run !== mapping.run ||
      response.plan !== mapping.planId ||
      response.owner !== mapping.owner ||
      response.namespace !== mapping.namespace ||
      typeof response.generation !== "string" ||
      !GENERATION.test(response.generation) ||
      !validSlots(response.changed_slots) ||
      JSON.stringify(await loadNativeProjectRun(opts.scope)) !==
        JSON.stringify(mapping)
    ) {
      throw refused();
    }
    return {
      mapping,
      generation: response.generation,
      changedSlots: response.changed_slots,
    };
  } catch (cause) {
    throw refused(cause);
  }
}
