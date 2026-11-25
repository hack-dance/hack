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
 * transitional phase) never proves an ended boot, so it never ends the start.
 *
 * The provider can also die while the record still says `running` (a crash, a
 * kill, or a provider that does not survive a sleep; HACK-2579): only a later
 * `runtime recover` writes a stopped phase. A pid from the matching boot that
 * no longer exists (`kill 0` answers ESRCH) ends the boot the same way. A
 * reused pid reads as alive.
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

/** How long a foreground start may outlive its lost VM: one check, the grace, margin. */
export const NATIVE_FOREGROUND_POOL_END_BOUND_MS = 15_000;

/**
 * What a foreground start prints when its VM is lost (HACK-2096): which VM, that
 * this start exits non-zero with data kept, and the one command that retires the
 * run. `hack down --recover` first runs `runtime recover` for an exited provider
 * (HACK-2579), so it needs nothing else; `hack up` afterwards starts it again.
 */
export function nativeForegroundPoolEndMessage(
  end: NativeStartPoolEnd
): string {
  const lost =
    end.providerPid === undefined
      ? `The native runtime VM under this start stopped: guest boot ${end.bootId} ended (the pool was stopped or booted again).`
      : `The native runtime VM under this start exited: its provider process (pid ${end.providerPid}) is gone, and guest boot ${end.bootId} with it.`;
  return [
    lost,
    "This foreground start ends now with exit code 1; the run's data is kept.",
    "Run hack down --recover to retire this run with its data kept, then hack up to start it again.",
  ].join("\n");
}

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
    let provider: number | undefined;
    if (
      isRecord(record) &&
      record.guest_boot_id === opts.bootId &&
      typeof record.token === "string"
    ) {
      owner ??= record.token;
      if (record.phase === "running") {
        provider = providerPid(record);
      }
    }
    const providerGone = provider !== undefined && gone(provider);
    if (
      providerGone ||
      nativeHttpsPoolBootEnded(record, { bootId: opts.bootId, owner })
    ) {
      const end: NativeStartPoolEnd = providerGone
        ? { bootId: opts.bootId, providerPid: provider }
        : { bootId: opts.bootId };
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
