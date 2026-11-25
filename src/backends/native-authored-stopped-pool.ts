/**
 * A native-authored run whose pool stopped under it (HACK-2715).
 *
 * After `runtime down --force`, a crash or a host reboot, the run's receipt
 * still belongs to the pool boot that ended. Its detached foreground owner is a
 * host process and may well still run (seen on a real VM): plain `hack down`
 * then asks that owner to stop, and its cleanup clears the run in the new boot.
 * Once the owner is gone, `hack down` (or `hack down --recover`) runs the
 * explicit dead-owner recovery instead. Both need a running pool: the runtime
 * removes the run's stopped containers in the new boot.
 *
 * So `hack down` first checks the run with the read-only, lock-free
 * `graph native boot` (it needs no running pool, as Compose's
 * `graph foreground-owner` check does, HACK-2456). Only a run whose receipt
 * belongs to an ended boot and that the cleanup from an ended boot admits gets
 * a stopped pool started, with the arguments every project start sends, and the
 * command says so once. A run that cleanup refuses (persistent data, a live
 * source, a custom network or a managed environment) is refused by name before
 * any pool is started. A running pool, an unreadable status or check, and a run
 * of the current boot are left as they are; the stop or recovery then reports
 * its own result.
 *
 * Starting the pool grants nothing: the owner's cleanup and the recovery still
 * prove the binding, the owner and the boot before any cleanup effect.
 */

import { isRecord } from "../lib/guards.ts";
import {
  nativeProjectRuntimeUpArgs,
  nativeRuntimePoolStopped,
} from "./native-project-runtime-up.ts";
import type { NativeRuntimeSelection } from "./native-runtime-client.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
} from "./native-runtime-client.ts";

/** The one line `hack down` prints when it starts a stopped pool. */
export const NATIVE_AUTHORED_STOPPED_POOL_NOTICE =
  "The native runtime is stopped; starting it to recover this project's run, with its data kept.";

/** The refusal code of a run of an ended boot that recovery does not support. */
export const NATIVE_GRAPH_ENDED_BOOT_UNSUPPORTED =
  "native_graph_ended_boot_unsupported";

const RUN = /^[a-f0-9]{32}$/;

/** What `graph native boot` reports; it grants no authority. */
type BootCheck = {
  readonly phase: string;
  readonly endedBoot: boolean;
  readonly endedBootRecoverable: boolean;
};

function parseBootCheck(value: unknown, run: string): BootCheck | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.kind !== "native-graph-boot" ||
    value.run !== run ||
    typeof value.phase !== "string" ||
    typeof value.ended_boot !== "boolean" ||
    typeof value.ended_boot_recoverable !== "boolean"
  ) {
    return;
  }
  return {
    phase: value.phase,
    endedBoot: value.ended_boot,
    endedBootRecoverable: value.ended_boot_recoverable,
  };
}

/**
 * Start the pool when `runtime status` proves it stopped and `graph native
 * boot` proves the run's receipt belongs to an ended boot that its cleanup
 * admits. Returns whether it started it. Throws the named refusal for a run of
 * an ended boot that cleanup does not support, without starting anything. A
 * failed `runtime up` throws its own error.
 */
export async function startStoppedPoolForAuthoredRecovery(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  /** The project's selected run id, or null when it has none. */
  readonly run: () => Promise<string | null>;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly notice?: (line: string) => void;
}): Promise<boolean> {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  if (
    !(await nativeRuntimePoolStopped({
      runtime: opts.runtime,
      projectRoot: opts.projectRoot,
      invoke,
    }))
  ) {
    return false;
  }
  const run = await opts.run().catch(() => null);
  if (run === null || !RUN.test(run)) {
    return false;
  }
  const check = parseBootCheck(
    await invoke({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: ["graph", "native", "boot", "--run-id", run, "--json"],
      timeoutMs: 15_000,
    }).catch(() => undefined),
    run
  );
  if (!check?.endedBoot || check.phase === "removed") {
    return false;
  }
  if (!check.endedBootRecoverable) {
    throw new NativeRuntimeRequestError({
      message: "Native project recovery from an ended pool boot is refused.",
      nativeCode: NATIVE_GRAPH_ENDED_BOOT_UNSUPPORTED,
    });
  }
  (opts.notice ?? ((line: string) => process.stderr.write(`${line}\n`)))(
    NATIVE_AUTHORED_STOPPED_POOL_NOTICE
  );
  await invoke({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: [...nativeProjectRuntimeUpArgs(opts.projectRoot), "--json"],
  });
  return true;
}
