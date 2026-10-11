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
const ONE_OFF_NAME = /^hkn-[a-f0-9]{32}-oneoff-[a-f0-9]{32}$/;

function refused(): never {
  throw new Error(
    "Native authored run completion is unconfirmed or its owner/selection changed; the one-off container may remain until down. Values omitted. No request was replayed."
  );
}
/** Known completion of one reaped one-off container derived from the admitted service member. */
export type NativeAuthoredOneOff = {
  readonly backend: "native";
  readonly run: string;
  readonly service: string;
  /** The canonical service container the one-off was derived from; never the one-off itself. */
  readonly member: string;
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
export function parseNativeAuthoredOneOff(
  value: unknown,
  receipt: NativeAuthoredReceipt,
  service: string
): NativeAuthoredOneOff {
  if (
    !(isRecord(value) && keys(value, "kind,result,review,run,version")) ||
    value.version !== 2 ||
    value.kind !== "native-graph-control-reply" ||
    value.run !== receipt.review.provenance.run ||
    value.review !== receipt.review.review_id ||
    !(isRecord(value.result) && keys(value.result, "one_off,outcome")) ||
    value.result.outcome !== "one-off"
  ) {
    return refused();
  }
  const oneOff = value.result.one_off;
  if (
    !(
      isRecord(oneOff) &&
      keys(
        oneOff,
        "container,exit_code,member,name,receipt,service,stderr_base64,stdout_base64,truncated"
      )
    )
  ) {
    return refused();
  }
  const observed = parseNativeAuthoredReceipt(oneOff.receipt);
  const member = observed.resources[`container:${service}`]?.id;
  if (
    observed.phase !== "ready-observed" ||
    nativeAuthoredReceiptBinding(observed) !==
      nativeAuthoredReceiptBinding(receipt) ||
    oneOff.service !== service ||
    !Object.hasOwn(observed.readiness, service) ||
    typeof oneOff.member !== "string" ||
    !CONTAINER.test(oneOff.member) ||
    oneOff.member !== member ||
    typeof oneOff.container !== "string" ||
    !CONTAINER.test(oneOff.container) ||
    oneOff.container === member ||
    typeof oneOff.name !== "string" ||
    !ONE_OFF_NAME.test(oneOff.name) ||
    !oneOff.name.startsWith(`hkn-${receipt.review.provenance.run}-oneoff-`) ||
    typeof oneOff.exit_code !== "number" ||
    !Number.isSafeInteger(oneOff.exit_code) ||
    oneOff.exit_code < 0 ||
    oneOff.exit_code > 255 ||
    typeof oneOff.truncated !== "boolean"
  ) {
    return refused();
  }
  return {
    backend: "native",
    run: receipt.review.provenance.run,
    service,
    member: oneOff.member,
    container: oneOff.container,
    exitCode: oneOff.exit_code,
    stdout: output(oneOff.stdout_base64),
    stderr: output(oneOff.stderr_base64),
    truncated: oneOff.truncated,
  };
}
/**
 * One finite noninteractive command in a fresh one-off container through the live
 * owner; no input acquisition or fallback. The owner derives the container from the
 * exact admitted member and reaps it after exit; an interrupted one-off is retained
 * with a pending record that `down` or `down --recover` removes.
 */
export async function nativeAuthoredProjectRun(input: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeAuthoredProjectRunScope;
  readonly service: string;
  readonly command: readonly string[];
  readonly workdir?: string;
  readonly signal?: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
  /** Control seam; production uses the held saved-read owner. */
  readonly withStatus?: typeof withNativeAuthoredProjectStatus;
}): Promise<NativeAuthoredOneOff> {
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
            "one-off",
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
          boundNativeAuthoredOneOffDrain: true,
        });
        await check();
        const result = parseNativeAuthoredOneOff(value, receipt, service);
        await check();
        return result;
      }
    );
  });
  active();
  return result;
}
