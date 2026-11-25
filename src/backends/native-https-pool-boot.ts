/**
 * Whether the pool boot a shared HTTPS owner was bound to has ended (HACK-2456).
 *
 * The owner's routes reach containers of exactly one guest boot
 * (`binding.pool.bootId`). Once that boot has ended, nothing the owner serves can
 * come back, its lease release can never be verified (release requires the same
 * boot), and the previous-boot archive refuses while it runs. So the owner retires
 * itself, keeping its configuration and lease records as evidence for that archive.
 *
 * Ended means proven from the pool record (`run/smolvm/owner.json`) alone, without
 * calling the runtime:
 * - another pool owns this home (a different owner token), or
 * - the pool has booted again (a different, non-empty guest boot id), or
 * - the pool is in a stopped phase, which the runtime writes only after it proved the
 *   provider process gone.
 *
 * Anything else, including a missing, unreadable or malformed record and transitional
 * phases (starting, stopping), proves nothing: the owner keeps running.
 */
import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import type { NativeHttpsOwnerBinding } from "./native-https-owner-protocol.ts";
import { nativeHttpsReadFile } from "./native-https-owner-storage.ts";

/** The runtime's stopped pool phases (`STOPPED_PHASES` plus `failed-boot-stopped`). */
const STOPPED_POOL_PHASES = new Set([
  "stopped",
  "stopped-before-engine",
  "stopped-after-engine-failure",
  "recovered-unclean",
  "failed-boot-stopped",
]);

/** How often a running owner checks its pool boot. */
export const NATIVE_HTTPS_POOL_BOOT_CHECK_MS = 5000;

/** A detached watch can initially have only its admitted boot ID. A stopped
 * record can identify that boot even if the next boot failed before getting an ID. */
export function nativeHttpsPoolBootEnded(
  record: unknown,
  pool: { readonly bootId: string; readonly owner?: string }
): boolean {
  if (!isRecord(record) || typeof record.token !== "string") {
    return false;
  }
  if (pool.owner !== undefined && record.token !== pool.owner) {
    return true;
  }
  if (
    typeof record.guest_boot_id === "string" &&
    record.guest_boot_id !== "" &&
    record.guest_boot_id !== pool.bootId
  ) {
    return true;
  }
  const namesBoot =
    record.guest_boot_id === pool.bootId ||
    (record.guest_boot_id === null &&
      record.previous_guest_boot_id === pool.bootId);
  return (
    (pool.owner !== undefined || namesBoot) &&
    typeof record.phase === "string" &&
    STOPPED_POOL_PHASES.has(record.phase)
  );
}

/** The home's parsed pool record (`run/smolvm/owner.json`); a read failure rejects. */
export async function readNativePoolRecord(home: string): Promise<unknown> {
  const { bytes } = await nativeHttpsReadFile(
    join(home, ".hack-local/run/smolvm/owner.json"),
    1_048_576
  );
  return JSON.parse(bytes.toString("utf8"));
}

/** Read the home's pool record and apply the rule; any read failure proves nothing. */
export async function readNativeHttpsPoolBootEnded(
  binding: NativeHttpsOwnerBinding
): Promise<boolean> {
  try {
    return nativeHttpsPoolBootEnded(
      await readNativePoolRecord(binding.runtime.home),
      binding.pool
    );
  } catch {
    return false;
  }
}
