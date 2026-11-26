/**
 * A native-authored run whose pool stopped under it (HACK-2715).
 *
 * After `runtime down --force`, a crash or a host reboot, the run's receipt
 * still belongs to the pool boot that ended. Its detached foreground owner is a
 * host process and may still run (seen on a real VM) until it notices its boot
 * ended. On a stopped pool, plain `hack down` first asks that owner to stop:
 * the stop needs no pool, the owner's cleanup refuses without an effect and the
 * owner exits (HACK-2715 review round 2, seen on a real VM: an owner's stop sent
 * right after this command started the pool did not confirm). Once the owner is
 * gone, `hack down` (or `hack down --recover`) runs the explicit dead-owner
 * recovery, which needs a running pool: the runtime removes the run's stopped
 * containers in the new boot.
 *
 * So `hack down` first checks the run with the read-only, lock-free
 * `graph native boot` (it needs no running pool, as Compose's
 * `graph foreground-owner` check does, HACK-2456). Only a run whose receipt
 * belongs to an ended boot and that the cleanup from an ended boot admits gets
 * a stopped pool started, with the arguments every project start sends, and the
 * command says so once. A run that cleanup refuses (persistent data, a live
 * source, a custom network or a managed environment) gets the named refusal and
 * no pool start, after its owner's stop. A project with no selected run makes no
 * runtime call here. A running pool, an unreadable status or check, and a run
 * of the current boot are left as they are; the stop or recovery then reports
 * its own result.
 *
 * Starting the pool grants nothing: the owner's cleanup and the recovery still
 * prove the binding, the owner and the boot before any cleanup effect.
 */

import { isRecord } from "../lib/guards.ts";
import { nativeRuntimeStatusStopped } from "./native-project-runtime-up.ts";
import type { NativeRuntimeSelection } from "./native-runtime-client.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
} from "./native-runtime-client.ts";
import { recoverExitedNativeRuntime } from "./native-runtime-preflight.ts";

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

type CheckOptions = {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  /** The project's selected run id, or null when it has none. */
  readonly run: () => Promise<string | null>;
  readonly invoke?: typeof invokeNativeRuntime;
  /** Where the one-line notices go; stderr by default. */
  readonly notice?: (line: string) => void;
};

async function selectedRun(opts: CheckOptions): Promise<string | null> {
  const run = await opts.run().catch(() => null);
  return run !== null && RUN.test(run) ? run : null;
}

async function bootCheck(
  opts: CheckOptions,
  run: string
): Promise<BootCheck | undefined> {
  return parseBootCheck(
    await (opts.invoke ?? invokeNativeRuntime)({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: ["graph", "native", "boot", "--run-id", run, "--json"],
      timeoutMs: 15_000,
    }).catch(() => undefined),
    run
  );
}

/** A run of an ended boot that no cleanup from an ended boot admits. */
function boundToEndedBoot(check: BootCheck | undefined): boolean {
  return (
    check?.endedBoot === true &&
    check.phase !== "removed" &&
    !check.endedBootRecoverable
  );
}

/** The named refusal of a boot-bound run of an ended boot. */
export function nativeAuthoredEndedBootRefusalError(): NativeRuntimeRequestError {
  return new NativeRuntimeRequestError({
    message: "Native project recovery from an ended pool boot is refused.",
    nativeCode: NATIVE_GRAPH_ENDED_BOOT_UNSUPPORTED,
  });
}
const endedBootRefusal = nativeAuthoredEndedBootRefusalError;

/**
 * The selected run on a pool `runtime status` proves stopped: `recoverable`
 * when its receipt belongs to an ended boot that a cleanup from an ended boot
 * admits, `bound` when it belongs to one that none admits, and `none` for a
 * running or unreadable pool, no run, a run of the current boot, a removed run
 * or an unreadable check. Read-only; it grants nothing.
 */
export type NativeAuthoredStoppedPoolRun = "none" | "recoverable" | "bound";

export async function nativeAuthoredStoppedPoolRun(
  opts: CheckOptions
): Promise<NativeAuthoredStoppedPoolRun> {
  const run = await selectedRun(opts);
  if (run === null) {
    return "none";
  }
  const invoke = opts.invoke ?? invokeNativeRuntime;
  // HACK-2715 review round 2 (Codex P2): a provider that died under the pool (a
  // crash, a kill) leaves its record `running`; `runtime status` reports
  // `process-exited`. The existing boundary (HACK-2579) records it stopped first,
  // under the provider lease and with the provider proven dead, so the receipt's
  // boot then reads as ended and the run is recovered like one after a forced stop.
  const status = await invoke({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: ["runtime", "status", "--json"],
    timeoutMs: 30_000,
  }).catch(() => undefined);
  if (isRecord(status) && status.phase === "process-exited") {
    if (
      !(await recoverExitedNativeRuntime({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        invoke,
        notice: opts.notice,
      }))
    ) {
      return "none";
    }
  } else if (!nativeRuntimeStatusStopped(status)) {
    return "none";
  }
  const check = await bootCheck(opts, run);
  if (boundToEndedBoot(check)) {
    return "bound";
  }
  return check?.endedBoot === true && check.phase !== "removed"
    ? "recoverable"
    : "none";
}

/**
 * Start the stopped pool for a run that {@link nativeAuthoredStoppedPoolRun}
 * found `recoverable`, saying so once. A failed `runtime up` throws its own
 * error. It boots the pool exactly as recorded (`runtime up --json`: its profile
 * and the project shares it already has). A native-authored project needs no
 * project share, and the pool may already share another project's root: asking
 * for this project's root refused `project_share_extension_required` on a real
 * VM at c1dfac73 (row 2), so nothing was started and the stop was reported
 * unconfirmed.
 */
export async function startNativeRuntimeForAuthoredRecovery(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly notice?: (line: string) => void;
}): Promise<void> {
  (opts.notice ?? ((line: string) => process.stderr.write(`${line}\n`)))(
    NATIVE_AUTHORED_STOPPED_POOL_NOTICE
  );
  await (opts.invoke ?? invokeNativeRuntime)({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: ["runtime", "up", "--json"],
  });
}

/** Whether `error` is the named refusal of a boot-bound run of an ended boot. */
export function isNativeAuthoredEndedBootRefusal(
  error: unknown
): error is NativeRuntimeRequestError {
  return (
    error instanceof NativeRuntimeRequestError &&
    error.nativeCode === NATIVE_GRAPH_ENDED_BOOT_UNSUPPORTED
  );
}

/**
 * Start the pool when `runtime status` proves it stopped and `graph native
 * boot` proves the run's receipt belongs to an ended boot that its cleanup
 * admits. Returns whether it started it. Throws the named refusal for a run of
 * an ended boot that cleanup does not support, without starting anything. A
 * failed `runtime up` throws its own error. The selected run is read first, so a
 * project with no run makes no runtime call (HACK-2715 review round 2, L4).
 */
export async function startStoppedPoolForAuthoredRecovery(
  opts: CheckOptions
): Promise<boolean> {
  const found = await nativeAuthoredStoppedPoolRun(opts);
  if (found === "bound") {
    throw endedBootRefusal();
  }
  if (found === "none") {
    return false;
  }
  await startNativeRuntimeForAuthoredRecovery(opts);
  return true;
}

/**
 * After the owner's stop failed on a pool this command did not start (HACK-2715
 * review round 2): the named refusal when `graph native boot` shows that the
 * run's receipt belongs to an ended boot and no cleanup from an ended boot
 * admits it. `hack down` then names the refusal whatever the pool's state was.
 * Read-only; `undefined` for any other run, no run or an unreadable check.
 */
export async function nativeAuthoredEndedBootRefusal(
  opts: CheckOptions
): Promise<NativeRuntimeRequestError | undefined> {
  const run = await selectedRun(opts);
  if (run !== null && boundToEndedBoot(await bootCheck(opts, run))) {
    return endedBootRefusal();
  }
  return;
}
