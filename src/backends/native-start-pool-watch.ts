/**
 * A native start notices that its pool is gone and ends (HACK-2550, HACK-2096).
 *
 * Seen on a real VM: after `runtime down` (or a crash) stopped the pool under a
 * running project, the start's detached owner outlived it by two minutes and,
 * once, by thirteen. It holds the start marker the whole time, and a later
 * `hack up` or `hack down --recover` waits for that marker (up to 120 s) before
 * it recovers the run. The step it waits in has its own bound, or none that a
 * user would accept; this watch does not depend on which step it is.
 *
 * Start watching only after this attempt's runtime up confirms its guest boot.
 * A preflight read can still name the dead boot the attempt will recover.
 * Poll the owner record every `checkMs`. A matching boot can also identify the
 * pool's owner token. A different boot or owner, or a stopped record for this
 * boot, proves it ended. Allow `graceMs` for the start to finish on its own,
 * then call `onEnded`. A start that is
 * already ready has nothing left to finish (its services went with the guest),
 * so it passes 0 and ends at once. A later `up` waits for this process to be
 * proven gone before it recovers the run, so ending sooner only shortens that
 * wait (HACK-2535 real-VM run: about 9 s of `up` after a pool stop). A pool that is only slow (starting, stopping, unreadable, or any
 * transitional phase) never proves an ended boot while its provider lives, so
 * it never ends the start.
 *
 * The provider can also die while the record still says `running` (a crash, a
 * kill, or a provider that does not survive a sleep; HACK-2579), or while it
 * says `quiescing` or `stopping` (a stop that died part way): only a later
 * `runtime recover` writes a stopped phase. A pid named by a record of the
 * matching boot that no longer exists (`kill 0` answers ESRCH) ends the boot
 * the same way, in any phase. A reused pid reads as alive.
 *
 * Ending is the same as a crash of the start process, which the run's records
 * already tolerate: the receipt, finalization and recovery evidence stay as
 * they are, and the next `hack up` or `hack down --recover` recovers the run.
 * A foreground start ends the same way (HACK-2096): without the watch it waited
 * on a graph owner whose VM was gone and never exited. `onEnded` receives the
 * evidence, so a foreground start can name the lost VM before it exits.
 */
import { isRecord } from "../lib/guards.ts";
import {
  nativeHttpsPoolBootEnded,
  readNativePoolRecord,
} from "./native-https-pool-boot.ts";

export const NATIVE_START_POOL_CHECK_MS = 1000;
export const NATIVE_START_POOL_GRACE_MS = 10_000;

/**
 * What proved the watched boot ended: the provider pid the running record named
 * is gone, or the record shows the boot stopped or replaced (no pid).
 */
export type NativeStartPoolEnd = {
  readonly bootId: string;
  readonly providerPid?: number;
};

/**
 * How far a foreground start got when its VM was lost (HACK-2096). The pool
 * watch starts right after this attempt's `runtime up`, so a loss can come in
 * any of three stages:
 *
 * - `preparing`: no service of this run was requested yet (resolve, review,
 *   image builds and pulls, restore selection). `recorded` says whether a run
 *   record exists for `hack down --recover` to find: a stopped retained run
 *   this `up` resumes, or the old run of a `hack restart`. A fresh `up` has
 *   none, so that down would only say `not_started`.
 * - `requested`: services were requested, and the graph is not yet both
 *   reported ready by the runtime and mapped. `recorded` as for `preparing`:
 *   a resumed retained run or a restart's replacement has a run record.
 * - `ready`: the runtime reported the graph ready (receipt `ready-observed`)
 *   and the run mapping is saved.
 */
export type NativeForegroundLossStage =
  | { readonly stage: "preparing"; readonly recorded: boolean }
  | { readonly stage: "requested"; readonly recorded: boolean }
  | { readonly stage: "ready" };

/**
 * What a foreground start prints when its VM is lost (HACK-2096): which VM, that
 * this start exits non-zero, and what to run next. Each stage names only
 * commands that are accepted, in order:
 *
 * - `ready`, and `preparing` with a run record: `hack down --recover`, then
 *   `hack up`. The down first runs `runtime recover` for an exited provider
 *   (HACK-2579) and starts the pool. A ready run is retired with its data kept;
 *   a run lost while preparing is still the stopped retained run (for a
 *   restart, its old run), and the down retires the interrupted start's
 *   leftovers with it. Either way it also retires a pending `hack restart`
 *   whose old run was already stopped, so `hack up` then starts the project
 *   whether or not this start was a restart's replacement.
 * - `preparing` without a run record (a fresh `up`): nothing was requested
 *   and nothing is recorded, so `hack up` alone starts it again.
 * - `requested` with a run record: `hack down --recover`, then `hack up`
 *   (HACK-2714). The down starts the pool, and the runtime's cross-boot
 *   dead-owner recovery retires the start its owner left `failed-retained` (or
 *   `preparing`), data kept.
 * - `requested` without one (a fresh `up`, or a restart retry whose old run's
 *   stop was never confirmed): the down finds no run it can retire, so the
 *   message names no command and says to keep the native home for inspection.
 */
export function nativeForegroundPoolEndMessage(
  end: NativeStartPoolEnd,
  loss: NativeForegroundLossStage
): string {
  const lost =
    end.providerPid === undefined
      ? `The native runtime VM under this start stopped: guest boot ${end.bootId} ended (the pool was stopped or booted again).`
      : `The native runtime VM under this start exited: its provider process (pid ${end.providerPid}) is gone, and guest boot ${end.bootId} with it.`;
  if (loss.stage === "preparing" && !loss.recorded) {
    return [
      lost,
      "This foreground start ends now with exit code 1; none of its services had been requested yet.",
      "Run hack up to start it again.",
    ].join("\n");
  }
  return [
    lost,
    "This foreground start ends now with exit code 1; the run's data is kept.",
    loss.stage === "requested" && !loss.recorded
      ? UNRECORDED_REQUESTED_ADVICE
      : LOSS_ADVICE[loss.stage],
  ].join("\n");
}

const UNRECORDED_REQUESTED_ADVICE =
  "It was lost before its services were ready, and no hack command can retire a run lost at that point yet. Keep this native home unchanged for inspection; hack ps --json shows what the run left.";

const LOSS_ADVICE: Readonly<
  Record<NativeForegroundLossStage["stage"], string>
> = {
  preparing:
    "It was lost before any of its services were requested. Run hack down --recover to retire the interrupted start with the run's data kept, then hack up to start it again.",
  requested:
    "It was lost before its services were ready. Run hack down --recover to retire the interrupted start with the run's data kept, then hack up to start it again.",
  ready:
    "Run hack down --recover to retire this run with its data kept, then hack up to start it again.",
};

export function watchNativeStartPool(opts: {
  readonly home: string;
  readonly bootId: string;
  readonly onEnded: (end: NativeStartPoolEnd) => void | Promise<void>;
  readonly checkMs?: number;
  /** Read when the ended boot is seen; a ready start passes 0. */
  readonly graceMs?: number | (() => number);
  /** Test seam: the pool record read; production reads `owner.json`. */
  readonly read?: (home: string) => Promise<unknown>;
  /** Test seam: whether a pid is gone; production asks `kill 0` for ESRCH. */
  readonly gone?: (pid: number) => boolean;
}): () => void {
  const read = opts.read ?? readNativePoolRecord;
  const gone = opts.gone ?? processGone;
  let owner: string | undefined;
  let stopped = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    const record = await read(opts.home).catch(() => undefined);
    if (stopped || grace) {
      return;
    }
    const reading = nativePoolBootEnd(record, {
      bootId: opts.bootId,
      owner,
      gone,
    });
    owner = reading.owner;
    const end = reading.end;
    if (end) {
      const graceMs =
        typeof opts.graceMs === "function"
          ? opts.graceMs()
          : (opts.graceMs ?? NATIVE_START_POOL_GRACE_MS);
      grace = setTimeout(() => {
        if (!stopped) {
          void Promise.resolve(opts.onEnded(end)).catch(() => undefined);
        }
      }, graceMs);
      grace.unref?.();
    }
  };
  const timer = setInterval(() => {
    void check();
  }, opts.checkMs ?? NATIVE_START_POOL_CHECK_MS);
  // The watch never keeps a finished start alive.
  timer.unref?.();
  void check();
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(grace);
  };
}

/**
 * One reading of the pool record against a watched boot: the boot's owner
 * token once a record names it, the end it proves, if any (the provider pid a
 * record of the boot names is gone, or the boot was stopped or replaced), and
 * whether it proves the boot live (`running` with a live provider pid). The
 * pool watch and {@link classifyNativeLostProvider} share it, so a lost VM is
 * recognized the same way whichever notices first.
 *
 * The pid is checked in any phase that still names the watched boot, not only
 * `running` (HACK-2096 round-5 review): the runtime keeps the boot id through
 * `quiescing` and `stopping`, and a provider that dies mid-stop (another
 * terminal's `runtime down`, or another project's idle stop) leaves the record
 * there. A gone pid (ESRCH) proves the boot ended in any phase; a live pid in
 * a transitional phase proves nothing either way.
 */
export function nativePoolBootEnd(
  record: unknown,
  opts: {
    readonly bootId: string;
    readonly owner?: string;
    readonly gone: (pid: number) => boolean;
  }
): {
  readonly owner?: string;
  readonly end?: NativeStartPoolEnd;
  readonly live: boolean;
} {
  let owner = opts.owner;
  let provider: number | undefined;
  if (
    isRecord(record) &&
    record.guest_boot_id === opts.bootId &&
    typeof record.token === "string"
  ) {
    owner ??= record.token;
    provider = providerPid(record);
  }
  // A stopped or replaced boot first: a stopped record keeps `process` and
  // `guest_boot_id` until the next boot, so an ordinary `runtime down` must
  // read as a stopped boot, not as a provider process that vanished.
  if (nativeHttpsPoolBootEnded(record, { bootId: opts.bootId, owner })) {
    return { owner, end: { bootId: opts.bootId }, live: false };
  }
  if (provider !== undefined && opts.gone(provider)) {
    return {
      owner,
      end: { bootId: opts.bootId, providerPid: provider },
      live: false,
    };
  }
  return {
    owner,
    live:
      provider !== undefined && isRecord(record) && record.phase === "running",
  };
}

/**
 * Native codes a request reports when the provider under it is gone: the
 * recorded provider process cannot be identified (`process_identity_unavailable`)
 * or the pool's process exited (`pool_process_exited`).
 */
const LOST_PROVIDER_CODES = new Set([
  "process_identity_unavailable",
  "pool_process_exited",
]);
const LOST_PROVIDER_TEXT =
  /\((process_identity_unavailable|pool_process_exited)\)/;

/**
 * Whether a start error carries a lost-provider code anywhere a native client
 * puts one: a request error's code, an image batch failure's code, the cause
 * chain, or the closed diagnostic text a cleanup error quotes. Bounded depth.
 */
export function nativeLostProviderCode(error: unknown, depth = 0): boolean {
  if (!isRecord(error) || depth > 4) {
    return false;
  }
  if (
    typeof error.nativeCode === "string" &&
    LOST_PROVIDER_CODES.has(error.nativeCode)
  ) {
    return true;
  }
  if (
    Array.isArray(error.failures) &&
    error.failures.some(
      (failure) =>
        isRecord(failure) &&
        typeof failure.code === "string" &&
        LOST_PROVIDER_CODES.has(failure.code)
    )
  ) {
    return true;
  }
  if (
    typeof error.message === "string" &&
    LOST_PROVIDER_TEXT.test(error.message)
  ) {
    return true;
  }
  return nativeLostProviderCode(error.cause, depth + 1);
}

/**
 * HACK-2096 (real-VM review): when a foreground start fails, did it fail
 * because the VM under it was lost? On a real VM the start's own error path
 * (a request, image preparation, or its foreground unwind) often reports
 * within a second of the provider's death, before the pool watch's check and
 * grace. This is the one classification every such path goes through, so the
 * user gets the same stage message whichever notices first. The pool record is
 * the evidence (the same reading as the watch: the watched boot's provider pid
 * is gone in any phase, or the boot ended). Only a record that proves the boot
 * live, `running` with a live provider pid, vetoes everything else: the runtime
 * also reports `process_identity_unavailable` for failures on a healthy VM (an
 * image build's context snapshot, an incarnation read, a helper process scan,
 * engine verification), and those must keep their own message. In any other
 * case (an unreadable record, one that names nothing for the watched boot, or
 * a transitional phase such as `starting`, `quiescing` or `stopping` with a
 * live pid, which proves nothing) a lost-provider code in the error decides.
 * Undefined when nothing proves a loss.
 */
export async function classifyNativeLostProvider(opts: {
  readonly error: unknown;
  readonly home: string;
  readonly bootId: string;
  readonly read?: (home: string) => Promise<unknown>;
  readonly gone?: (pid: number) => boolean;
}): Promise<NativeStartPoolEnd | undefined> {
  const record = await (opts.read ?? readNativePoolRecord)(opts.home).catch(
    () => undefined
  );
  const { end, live } = nativePoolBootEnd(record, {
    bootId: opts.bootId,
    gone: opts.gone ?? processGone,
  });
  if (end) {
    return end;
  }
  if (live) {
    // The watched boot is running with a live provider: not lost.
    return undefined;
  }
  return nativeLostProviderCode(opts.error)
    ? { bootId: opts.bootId }
    : undefined;
}

/** A sentence of a native error that advises running `hack down --recover`. */
const RECOVER_ADVICE = /\s*Run hack down --recover\b[^.]*\./g;

/**
 * The failed start's own message as one bounded line, appended to a lost-VM
 * error so a misclassification can still be diagnosed (HACK-2096 review). The
 * text is the closed message the CLI would have printed anyway. For a stage
 * where no command retires the run (`requested`, HACK-2714), the cause's own
 * "Run hack down --recover …" sentence is dropped: that step refuses there.
 */
export function nativeLostVmCauseLine(
  cause: unknown,
  opts: { readonly dropRecoverAdvice?: boolean } = {}
): string | undefined {
  let message = "";
  if (cause instanceof Error) {
    message = cause.message;
  } else if (typeof cause === "string") {
    message = cause;
  }
  if (opts.dropRecoverAdvice) {
    message = message.replace(RECOVER_ADVICE, " ");
  }
  const line = message.replace(/\s+/g, " ").trim();
  if (line === "") {
    return undefined;
  }
  return `(cause: ${line.length > 400 ? `${line.slice(0, 399)}…` : line})`;
}

/** The provider pid a running pool record names, when it is a plausible pid. */
function providerPid(record: Record<string, unknown>): number | undefined {
  const process = record.process;
  return isRecord(process) &&
    typeof process.pid === "number" &&
    Number.isSafeInteger(process.pid) &&
    process.pid > 1
    ? process.pid
    : undefined;
}

/** Only ESRCH proves a pid gone; EPERM or success reads as alive. */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isRecord(error) && error.code === "ESRCH";
  }
}
