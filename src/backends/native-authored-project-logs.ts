import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isRecord } from "../lib/guards.ts";
import { keys, sameFile } from "../lib/native-compose-private-state.ts";
import {
  type NativeAuthoredReceipt,
  nativeAuthoredReceiptBinding,
  parseNativeAuthoredReceipt,
} from "./native-authored-graph-protocol.ts";
import {
  type NativeAuthoredProjectRunScope,
  nativeAuthoredProjectNamespace,
  withNativeAuthoredProjectStatus,
} from "./native-authored-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
const CONTAINER = /^[a-f0-9]{64}$/;
function refused(): never {
  throw new Error(
    "Native authored logs are unavailable or their owner/selection changed; values omitted."
  );
}
export type NativeAuthoredLogs = {
  readonly backend: "native";
  readonly run: string;
  readonly service: string;
  readonly container: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
};
export function nativeAuthoredLogsOptions(
  service: unknown,
  tail: unknown
): service is string {
  return (
    typeof service === "string" &&
    SERVICE.test(service) &&
    typeof tail === "number" &&
    Number.isSafeInteger(tail) &&
    tail >= 1 &&
    tail <= 1000
  );
}
/** The authenticated native reply must retain the exact admitted member and receipt. */
export function parseNativeAuthoredLogs(
  value: unknown,
  receipt: NativeAuthoredReceipt,
  service: string
): NativeAuthoredLogs {
  if (
    !(isRecord(value) && keys(value, "kind,result,review,run,version")) ||
    value.version !== 2 ||
    value.kind !== "native-graph-control-reply" ||
    value.run !== receipt.review.provenance.run ||
    value.review !== receipt.review.review_id ||
    !(isRecord(value.result) && keys(value.result, "logs,outcome")) ||
    value.result.outcome !== "logs"
  ) {
    return refused();
  }
  const logs = value.result.logs;
  if (
    !(
      isRecord(logs) &&
      keys(logs, "container,receipt,service,stderr,stdout,truncated")
    )
  ) {
    return refused();
  }
  const observed = parseNativeAuthoredReceipt(logs.receipt);
  if (
    observed.phase !== "ready-observed" ||
    nativeAuthoredReceiptBinding(observed) !==
      nativeAuthoredReceiptBinding(receipt) ||
    logs.service !== service ||
    !Object.hasOwn(observed.readiness, service) ||
    typeof logs.container !== "string" ||
    !CONTAINER.test(logs.container) ||
    logs.container !== observed.resources[`container:${service}`]?.id ||
    typeof logs.stdout !== "string" ||
    typeof logs.stderr !== "string" ||
    typeof logs.truncated !== "boolean" ||
    [logs.stdout, logs.stderr].some(
      (text) =>
        new TextEncoder().encode(JSON.stringify(text)).byteLength > 16_386
    )
  ) {
    return refused();
  }
  return {
    backend: "native",
    run: receipt.review.provenance.run,
    service,
    container: logs.container,
    stdout: logs.stdout,
    stderr: logs.stderr,
    truncated: logs.truncated,
  };
}
/** One finite live-owner read. No input acquisition, new runtime or Compose fallback. */
export async function nativeAuthoredProjectLogs(input: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeAuthoredProjectRunScope;
  readonly service: string;
  readonly tail?: number;
  readonly signal?: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
  /** Control seam; production uses the held saved-read owner. */
  readonly withStatus?: typeof withNativeAuthoredProjectStatus;
}): Promise<NativeAuthoredLogs> {
  const runtime = { ...input.runtime },
    scope = { ...input.scope },
    service = input.service,
    tail = input.tail ?? 200,
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
    !nativeAuthoredLogsOptions(service, tail) ||
    runtime.home !== scope.nativeHome
  ) {
    return refused();
  }
  const result = await withStatus(scope, async (saved) => {
    active();
    if (!saved.ready) {
      return refused();
    }
    const receipt = saved.ready.record.receipt;
    if (
      receipt.review.provenance.namespace !==
        nativeAuthoredProjectNamespace(scope) ||
      !Object.hasOwn(receipt.readiness, service) ||
      !receipt.resources[`container:${service}`]?.id
    ) {
      return refused();
    }
    if ((await realpath(runtime.binary)) !== runtime.binary) {
      return refused();
    }
    const file = await open(
      runtime.binary,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const original = await file.stat();
      const check = async () => {
        active();
        const named = await lstat(runtime.binary),
          held = await file.stat();
        if (
          !original.isFile() ||
          original.nlink !== 1 ||
          (original.mode & 0o022) !== 0 ||
          (original.mode & 0o111) === 0 ||
          !named.isFile() ||
          !sameFile(original, named) ||
          !sameFile(original, held) ||
          [named, held].some(
            (info) =>
              info.size !== original.size ||
              info.mtimeMs !== original.mtimeMs ||
              info.ctimeMs !== original.ctimeMs ||
              info.mode !== original.mode ||
              info.uid !== original.uid ||
              info.nlink !== 1
          ) ||
          (await realpath(runtime.binary)) !== runtime.binary
        ) {
          return refused();
        }
        await saved.assertFresh();
        active();
      };
      await check();
      const value = await invoke({
        runtime,
        cwd: scope.projectRoot,
        args: [
          "graph",
          "native",
          "logs",
          "--run-id",
          receipt.review.provenance.run,
          "--service",
          service,
          "--tail",
          String(tail),
          "--json",
        ],
        timeoutMs: 15_000,
        signal,
        boundNativeAuthoredLogsDrain: true,
      });
      await check();
      const logs = parseNativeAuthoredLogs(value, receipt, service);
      await check();
      return logs;
    } finally {
      await file.close();
    }
  });
  active();
  return result;
}
