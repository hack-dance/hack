/**
 * A detached native start notices that its pool is gone and ends (HACK-2550).
 *
 * Seen on a real VM: after `runtime down` (or a crash) stopped the pool under a
 * running project, the start's detached owner outlived it by two minutes and,
 * once, by thirteen. It holds the start marker the whole time, and a later
 * `hack up` or `hack down --recover` waits for that marker (up to 120 s) before
 * it recovers the run. The step it waits in has its own bound, or none that a
 * user would accept; this watch does not depend on which step it is.
 *
 * The watch records the pool identity (owner token and guest boot id) the first
 * time it reads the pool record in the running phase. From then on it checks
 * the record every `checkMs`. Once that boot has ended, by the same proof the
 * shared HTTPS owner uses (`nativeHttpsPoolBootEnded`: another owner token, a
 * new boot id, or a stopped phase, written only after the provider is proven
 * gone), it allows `graceMs` for the start to finish on its own, then calls
 * `onEnded`. `graceMs` is read when the ended boot is seen: a start that is
 * already ready has nothing left to finish (its services went with the guest),
 * so it passes 0 and ends at once. A later `up` waits for this process to be
 * proven gone before it recovers the run, so ending sooner only shortens that
 * wait (HACK-2535 real-VM run: about 9 s of `up` after a pool stop). A pool that is only slow (starting, stopping, unreadable, or any
 * transitional phase) never proves an ended boot, so it never ends the start.
 *
 * The provider can also die while the record still says `running` (a crash, a
 * kill, or a provider that does not survive a sleep; HACK-2579): only a later
 * `runtime recover` writes a stopped phase. So the watch also records the
 * provider's pid with the boot, and a pid that no longer exists (`kill 0` answers
 * ESRCH) ends the boot the same way. A reused pid only reads as alive, never the
 * reverse, so it cannot end a start early.
 *
 * Ending is the same as a crash of the start process, which the run's records
 * already tolerate: the receipt, finalization and recovery evidence stay as
 * they are, and the next `hack up` or `hack down --recover` recovers the run.
 */
import { isRecord } from "../lib/guards.ts";
import {
  nativeHttpsPoolBootEnded,
  readNativePoolRecord,
} from "./native-https-pool-boot.ts";

export const NATIVE_START_POOL_CHECK_MS = 1000;
export const NATIVE_START_POOL_GRACE_MS = 10_000;

export function watchNativeStartPool(opts: {
  readonly home: string;
  readonly onEnded: () => void | Promise<void>;
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
  let pool: { readonly owner: string; readonly bootId: string } | undefined;
  let provider: number | undefined;
  let stopped = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    const record = await read(opts.home).catch(() => undefined);
    if (stopped || grace) {
      return;
    }
    if (!pool) {
      if (
        isRecord(record) &&
        record.phase === "running" &&
        typeof record.token === "string" &&
        typeof record.guest_boot_id === "string" &&
        record.guest_boot_id !== ""
      ) {
        pool = { owner: record.token, bootId: record.guest_boot_id };
        provider = providerPid(record);
      }
      return;
    }
    const providerExited =
      provider !== undefined &&
      isRecord(record) &&
      record.phase === "running" &&
      providerPid(record) === provider &&
      gone(provider);
    if (providerExited || nativeHttpsPoolBootEnded(record, pool)) {
      const graceMs =
        typeof opts.graceMs === "function"
          ? opts.graceMs()
          : (opts.graceMs ?? NATIVE_START_POOL_GRACE_MS);
      grace = setTimeout(() => {
        if (!stopped) {
          void Promise.resolve(opts.onEnded()).catch(() => undefined);
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
