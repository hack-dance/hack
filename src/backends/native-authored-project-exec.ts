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
  NativeAuthoredProjectNotStartedError,
  requireReadyServiceReceipt,
  unstartedNativeAuthoredProject,
  withPinnedRuntimeBinary,
} from "./native-authored-runtime-binary.ts";
import {
  NATIVE_AUTHORED_COMMAND_REQUEST_TIMEOUT_MS,
  nativeAuthoredCommandNotRun,
  nativeCommandLeaseWaitReporter,
} from "./native-command-lease.ts";
import {
  nativeInteractiveExec,
  nativeInteractiveRequested,
} from "./native-interactive-exec.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const CONTAINER = /^[a-f0-9]{64}$/;

/**
 * The `graph native exec` request's bound: the requesting process's lease wait
 * (35 s, HACK-2739), 5 s to send, the fixed 40 s read of the owner's answer,
 * and a 5 s margin. It was 45 s before that wait.
 */
export const NATIVE_AUTHORED_EXEC_REQUEST_TIMEOUT_MS =
  NATIVE_AUTHORED_COMMAND_REQUEST_TIMEOUT_MS;

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
  /** Absent means nothing was reported dropped (HACK-2759). */
  readonly dropped?: NativeOutputDrops;
};
/**
 * Bytes of each stream past the owner's 1 MiB cap, read to the end and dropped
 * (HACK-2759). The kept bytes are the beginning. An owner that predates the
 * counts, or dropped nothing, sends none.
 */
export type NativeOutputDrops = {
  readonly stdout: number;
  readonly stderr: number;
};
const DROPPED_KEYS: readonly string[] = ["stderr_dropped", "stdout_dropped"];
/** The record's keys, other than the optional dropped counts, are exactly `expected`. */
export function nativeCommandReplyKeys(
  value: Record<string, unknown>,
  expected: string
): boolean {
  return (
    Object.keys(value)
      .filter((key) => !DROPPED_KEYS.includes(key))
      .sort()
      .join(",") === expected
  );
}
/** The optional dropped counts of a command reply; counts imply truncation. */
export function nativeOutputDrops(
  value: Record<string, unknown>,
  truncated: boolean
): NativeOutputDrops {
  const count = (entry: unknown): number => {
    if (entry === undefined) {
      return 0;
    }
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry < 1
    ) {
      return refused();
    }
    return entry;
  };
  const dropped = {
    stdout: count(value.stdout_dropped),
    stderr: count(value.stderr_dropped),
  };
  if (!truncated && dropped.stdout + dropped.stderr > 0) {
    return refused();
  }
  return dropped;
}
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
      nativeCommandReplyKeys(
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
    dropped: nativeOutputDrops(exec, exec.truncated),
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
  /** The lease-wait progress line; the CLI prints it once (HACK-2739). */
  readonly onLeaseWait?: (holder: string) => void;
}): Promise<NativeAuthoredExec> {
  const runtime = { ...input.runtime },
    scope = { ...input.scope },
    service = input.service,
    command = [...input.command],
    workdir = input.workdir,
    signal = input.signal,
    invoke = input.invoke ?? invokeNativeRuntime,
    onLeaseWait = nativeCommandLeaseWaitReporter({ given: input.onLeaseWait }),
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
  if (nativeInteractiveRequested()) {
    // Finish the held saved-status observation before attaching. A normal down
    // may advance these records while the terminal session is still open.
    const selected = await withStatus(scope, async (saved) => {
      await saved.assertFresh();
      const unstarted = unstartedNativeAuthoredProject(saved);
      if (unstarted) {
        return unstarted;
      }
      return requireReadyServiceReceipt(saved, scope, service) ?? refused();
    });
    if (selected instanceof NativeAuthoredProjectNotStartedError) {
      throw selected;
    }
    const container = selected.resources[`container:${service}`]?.id;
    if (!container) {
      return refused();
    }
    const exitCode = await nativeInteractiveExec({
      runtime,
      projectRoot: scope.projectRoot,
      branch: scope.branch,
      run: selected.review.provenance.run,
      owner: selected.owner,
      plan: selected.review.review_id,
      namespace: selected.review.provenance.namespace,
      service,
      command,
      workdir,
      native: true,
      signal,
    });
    return {
      backend: "native",
      run: selected.review.provenance.run,
      service,
      container,
      exitCode,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      truncated: false,
      dropped: { stdout: 0, stderr: 0 },
    };
  }
  const result = await withStatus(scope, async (saved) => {
    active();
    // A never-started selection is a closed refusal, not an unknown outcome.
    const unstarted = unstartedNativeAuthoredProject(saved);
    if (unstarted) {
      return unstarted;
    }
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
        let value: unknown;
        try {
          value = await invoke({
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
            // The requesting process first waits up to 35 s for a free provider
            // lease, which another project's stop holds for its whole stop
            // (HACK-2739), then sends and reads the owner's answer for 40 s.
            timeoutMs: NATIVE_AUTHORED_EXEC_REQUEST_TIMEOUT_MS,
            signal,
            onLeaseWait,
            boundNativeAuthoredExecDrain: true,
          });
        } catch (error) {
          // Returned, not thrown: the held saved-status owner reports any
          // failure thrown inside it as an unconfirmed artifact failure.
          const notRun = await nativeAuthoredCommandNotRun(error, "hack exec");
          if (notRun) {
            return notRun;
          }
          throw error;
        }
        await check();
        const result = parseNativeAuthoredExec(value, receipt, service);
        await check();
        return result;
      }
    );
  });
  active();
  if (
    result instanceof NativeAuthoredProjectNotStartedError ||
    // Only a refusal that nothing ran is returned as this type (HACK-2739).
    result instanceof NativeRuntimeRequestError
  ) {
    throw result;
  }
  return result;
}
