import { isRecord } from "../lib/guards.ts";
import { keys } from "../lib/native-compose-private-state.ts";
import { nativeAuthoredExecOptions } from "./native-authored-exec-options.ts";
import {
  type NativeAuthoredReceipt,
  nativeAuthoredReceiptBinding,
  parseNativeAuthoredReceipt,
} from "./native-authored-graph-protocol.ts";
import {
  type NativeAuthoredProjectRunScope,
  withNativeAuthoredProjectStatus,
} from "./native-authored-project-run.ts";
import {
  requireReadyServiceReceipt,
  withPinnedRuntimeBinary,
} from "./native-authored-runtime-binary.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const CONTAINER = /^[a-f0-9]{64}$/;

function refused(): never {
  throw new Error(
    "Native authored exec completion is unconfirmed or its owner/selection changed; command effects may have occurred. Values omitted. No request was replayed."
  );
}
export type NativeAuthoredExec = {
  readonly backend: "native";
  readonly run: string;
  readonly service: string;
  readonly container: string;
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly truncated: boolean;
};
function output(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length > 1_398_104) {
    return refused();
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > 1024 * 1024 || bytes.toString("base64") !== value) {
    return refused();
  }
  return bytes;
}
export function parseNativeAuthoredExec(
  value: unknown,
  receipt: NativeAuthoredReceipt,
  service: string
): NativeAuthoredExec {
  if (
    !(isRecord(value) && keys(value, "kind,result,review,run,version")) ||
    value.version !== 2 ||
    value.kind !== "native-graph-control-reply" ||
    value.run !== receipt.review.provenance.run ||
    value.review !== receipt.review.review_id ||
    !(isRecord(value.result) && keys(value.result, "exec,outcome")) ||
    value.result.outcome !== "exec"
  ) {
    return refused();
  }
  const exec = value.result.exec;
  if (
    !(
      isRecord(exec) &&
      keys(
        exec,
        "container,exit_code,receipt,service,stderr_base64,stdout_base64,truncated"
      )
    )
  ) {
    return refused();
  }
  const observed = parseNativeAuthoredReceipt(exec.receipt);
  if (
    observed.phase !== "ready-observed" ||
    nativeAuthoredReceiptBinding(observed) !==
      nativeAuthoredReceiptBinding(receipt) ||
    exec.service !== service ||
    !Object.hasOwn(observed.readiness, service) ||
    typeof exec.container !== "string" ||
    !CONTAINER.test(exec.container) ||
    exec.container !== observed.resources[`container:${service}`]?.id ||
    typeof exec.exit_code !== "number" ||
    !Number.isSafeInteger(exec.exit_code) ||
    exec.exit_code < 0 ||
    exec.exit_code > 255 ||
    typeof exec.truncated !== "boolean"
  ) {
    return refused();
  }
  return {
    backend: "native",
    run: receipt.review.provenance.run,
    service,
    container: exec.container,
    exitCode: exec.exit_code,
    stdout: output(exec.stdout_base64),
    stderr: output(exec.stderr_base64),
    truncated: exec.truncated,
  };
}
/** One finite noninteractive command through the live owner; no input acquisition or fallback. */
export async function nativeAuthoredProjectExec(input: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeAuthoredProjectRunScope;
  readonly service: string;
  readonly command: readonly string[];
  readonly workdir?: string;
  readonly signal?: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
  /** Control seam; production uses the held saved-read owner. */
  readonly withStatus?: typeof withNativeAuthoredProjectStatus;
}): Promise<NativeAuthoredExec> {
  const runtime = { ...input.runtime },
    scope = { ...input.scope },
    service = input.service,
    command = [...input.command],
    workdir = input.workdir,
    signal = input.signal,
    invoke = input.invoke ?? invokeNativeRuntime,
    withStatus = input.withStatus ?? withNativeAuthoredProjectStatus;
  const active = () => {
    if (signal?.aborted) {
      return refused();
    }
  };
  active();
  if (
    !nativeAuthoredExecOptions(service, command, workdir) ||
    runtime.home !== scope.nativeHome
  ) {
    return refused();
  }
  const result = await withStatus(scope, async (saved) => {
    active();
    const receipt =
      requireReadyServiceReceipt(saved, scope, service) ?? refused();
    return await withPinnedRuntimeBinary(
      { binary: runtime.binary, signal, refused },
      async (pin) => {
        const check = async () => {
          pin.checkSync();
          await saved.assertFresh();
          // Recheck the executable after any awaited saved-owner admission.
          pin.checkSync();
        };
        await check();
        // No await separates this final path/descriptor admission from real spawn.
        pin.checkSync();
        const value = await invoke({
          runtime,
          cwd: scope.projectRoot,
          args: [
            "graph",
            "native",
            "exec",
            "--run-id",
            receipt.review.provenance.run,
            "--service",
            service,
            ...(workdir === undefined ? [] : ["--workdir", workdir]),
            "--json",
            "--",
            ...command,
          ],
          timeoutMs: 45_000,
          signal,
          boundNativeAuthoredExecDrain: true,
        });
        await check();
        const result = parseNativeAuthoredExec(value, receipt, service);
        await check();
        return result;
      }
    );
  });
  active();
  return result;
}
