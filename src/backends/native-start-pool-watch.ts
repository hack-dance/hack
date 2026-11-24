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
}): () => void {
  const read = opts.read ?? readNativePoolRecord;
  let pool: { readonly owner: string; readonly bootId: string } | undefined;
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
      }
      return;
    }
    if (nativeHttpsPoolBootEnded(record, pool)) {
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
