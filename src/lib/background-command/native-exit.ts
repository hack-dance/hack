import { isAbsolute } from "node:path";
import { createPrivateFileExclusive } from "../private-file.ts";

/**
 * Set by the supervisor on a native background command's `hack` child: the
 * private journal file to create once the native engine returned the guest
 * command's exit code. Without it a native end that is not `succeeded` is
 * not confirmed (the engine can return "uncertain" after its 30 s
 * observation budget while the guest command still runs), so the end holds
 * its admission slot.
 */
export const NATIVE_EXIT_CONFIRMED_ENV = "HACK_BACKGROUND_EXIT_CONFIRMED_FILE";

/**
 * Record that the guest command's exit code is known. Best effort and a
 * no-op outside a native background command; a failure here only makes the
 * end hold its slot (fail closed).
 */
export async function noteNativeExitConfirmed(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  const path = env[NATIVE_EXIT_CONFIRMED_ENV];
  if (!(path && isAbsolute(path))) {
    return;
  }
  await createPrivateFileExclusive({ path, text: "" }).catch(() => undefined);
}
