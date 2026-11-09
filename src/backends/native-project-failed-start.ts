import { isRecord } from "../lib/guards.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SAFE_CODE = /^[a-z0-9_]{1,80}$/;

export type NativeFailedStartDiscard =
  | "removed"
  | "retained"
  | "not_applicable";

function stoppedWithData(value: unknown, run: string, owner: string): boolean {
  return (
    isRecord(value) &&
    value.journal_incomplete === false &&
    isRecord(value.receipt) &&
    value.receipt.run === run &&
    value.receipt.owner === owner &&
    value.receipt.phase === "stopped-data-retained"
  );
}

function removed(value: unknown, run: string, owner: string): boolean {
  return (
    isRecord(value) &&
    value.journal_incomplete === false &&
    isRecord(value.receipt) &&
    value.receipt.run === run &&
    value.receipt.owner === owner &&
    value.receipt.phase === "removed"
  );
}

/**
 * Remove the retained data of a fresh foreground start that failed before it
 * published a run mapping.
 *
 * Such a graph is unreachable: `ps`, `down`, `logs` and a later `up` select
 * runs only through the published mapping, and a later fresh start always
 * creates a new run with new volumes. Without this step every failed attempt
 * would leave another invisible graph holding its own volumes. Shared
 * dependency caches are only released by the runtime, never destroyed.
 *
 * Only a fresh start (no retained or restored run) whose mapping was never
 * written or attempted qualifies, after confirmed compute cleanup. Removal failure never replaces the startup result: the caller receives
 * "retained" and a value-free notice naming the run and the explicit removal.
 */
export async function discardUnpublishedNativeStart(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: string;
  readonly owner: string;
  readonly final: unknown;
  /** A retained or restored run keeps its data; only fresh runs qualify. */
  readonly restored: boolean;
  /** Any mapping write, even one whose reply was lost, keeps the data. */
  readonly mappingAttempted: boolean;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly warn?: (line: string) => void;
}): Promise<NativeFailedStartDiscard> {
  if (
    opts.restored ||
    opts.mappingAttempted ||
    !stoppedWithData(opts.final, opts.run, opts.owner)
  ) {
    return "not_applicable";
  }
  const invoke = opts.invoke ?? invokeNativeRuntime;
  try {
    await invoke({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: [
        "graph",
        "cleanup",
        "--run-id",
        opts.run,
        "--remove-data",
        "--json",
      ],
      timeoutMs: 590_000,
    });
    const after = await inspectNativeProjectGraph({
      runtime: opts.runtime,
      projectRoot: opts.projectRoot,
      run: opts.run,
      invoke,
    });
    if (removed(after, opts.run, opts.owner)) {
      return "removed";
    }
    throw new Error("removal unconfirmed");
  } catch (error) {
    const code =
      error instanceof NativeRuntimeRequestError &&
      error.nativeCode &&
      SAFE_CODE.test(error.nativeCode)
        ? ` (${error.nativeCode})`
        : "";
    (opts.warn ?? ((line) => process.stderr.write(`${line}\n`)))(
      `Native startup failed before publishing run ${opts.run}; its stopped graph and volumes were retained because automatic removal was not confirmed${code}. Remove them with the native runtime's \`graph cleanup --run-id ${opts.run} --remove-data --json\`.`
    );
    return "retained";
  }
}
