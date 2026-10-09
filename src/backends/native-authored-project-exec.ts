import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isRecord } from "../lib/guards.ts";
import { keys, sameFile } from "../lib/native-compose-private-state.ts";
import { nativeAuthoredExecOptions } from "./native-authored-exec-options.ts";
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
    } finally {
      await file.close();
    }
  });
  active();
  return result;
}
