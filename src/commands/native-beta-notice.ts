import { nativeBetaNotice } from "../backends/native-beta.ts";
import { logger } from "../ui/logger.ts";

/**
 * Prints the beta line once for a human reader. `--json` output stays a
 * single document, so JSON callers get no extra line on either stream.
 */
export function noteNativeBackendBeta(opts: { readonly json: boolean }): void {
  if (opts.json) {
    return;
  }
  logger.info({ message: nativeBetaNotice() });
}
