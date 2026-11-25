/**
 * A run's foreground owner that outlives its pool boot (HACK-2572).
 *
 * After `runtime down` (or a crash) the run's detached owner is still alive for
 * a moment: its pool watch (`native-start-pool-watch.ts`) checks the pool record
 * every second and then ends it, at once when it was ready, after a 10 s grace
 * while it was still starting. A command that meets that owner in this window
 * (`up`, `restart`, `down --recover`) used to refuse as if a live foreground
 * owner held the run. When the pool record proves the boot ended, by the stopped
 * phase the watch itself acts on (`nativeHttpsPoolBootEnded`; written only after
 * the provider is proven gone), the command now waits, bounded and with one
 * line, for that owner to go, and then continues as it does for an exited owner.
 *
 * Nothing here signals or ends the owner, and the wait grants nothing: the
 * caller still proves the owner gone (its own selection) before it recovers the
 * run. A live owner on a running pool never satisfies the proof, so it keeps its
 * refusal at once.
 */
import { isRecord } from "../lib/guards.ts";
import {
  nativeHttpsPoolBootEnded,
  readNativePoolRecord,
} from "./native-https-pool-boot.ts";

/** About the watch's 1 s check, its 10 s grace for a start in progress, and margin. */
export const NATIVE_ENDED_BOOT_OWNER_WAIT_MS = 15_000;
const POLL_MS = 250;

export const NATIVE_ENDED_BOOT_OWNER_NOTICE =
  "The native runtime stopped under this run; waiting up to 15 s for its earlier start to end.";

/**
 * Whether the home's pool record proves every earlier boot ended: a stopped
 * phase. This is the stopped leg of the watch's rule; a pool that is starting,
 * stopping, running or unreadable proves nothing.
 */
export async function nativePoolBootProvenEnded(
  home: string,
  read: (home: string) => Promise<unknown> = readNativePoolRecord
): Promise<boolean> {
  const record = await read(home).catch(() => undefined);
  if (!(isRecord(record) && typeof record.token === "string")) {
    return false;
  }
  // Against the record's own identity only the phase can prove an ended boot.
  return nativeHttpsPoolBootEnded(record, {
    owner: record.token,
    bootId:
      typeof record.guest_boot_id === "string" ? record.guest_boot_id : "",
  });
}

/**
 * Wait while `ownerRunning` holds and the pool's boot stays proven ended, at
 * most `waitMs`. Says so once. Returns when the owner is no longer running, the
 * proof stops holding, the bound passes or `signal` aborts; the caller then
 * decides as before (a still-running owner keeps its refusal).
 */
export async function awaitNativeEndedBootOwner(opts: {
  readonly home: string;
  readonly ownerRunning: () => Promise<boolean>;
  readonly notice: (line: string) => void;
  readonly signal?: AbortSignal;
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly read?: (home: string) => Promise<unknown>;
}): Promise<void> {
  const deadline =
    performance.now() + (opts.waitMs ?? NATIVE_ENDED_BOOT_OWNER_WAIT_MS);
  let noticed = false;
  while (
    !opts.signal?.aborted &&
    (await nativePoolBootProvenEnded(opts.home, opts.read)) &&
    (await opts.ownerRunning())
  ) {
    if (!noticed) {
      opts.notice(NATIVE_ENDED_BOOT_OWNER_NOTICE);
      noticed = true;
    }
    if (performance.now() >= deadline) {
      return;
    }
    await Bun.sleep(opts.pollMs ?? POLL_MS);
  }
}
