import { nativeBetaNotice } from "../backends/native-beta.ts";
import { logger } from "../ui/logger.ts";

/**
 * Prints the beta line once for a human reader. `--json` output stays a
 * single document, so JSON callers get no extra line on either stream.
 *
 * `info` is the sink, the logger by default. Tests pass their own instead of
 * spying on the shared logger: in one process with other test files, the
 * `logger` a test imports is not always the object this module calls.
 */
export function noteNativeBackendBeta(opts: {
  readonly json: boolean;
  readonly info?: (line: { readonly message: string }) => void;
}): void {
  if (opts.json) {
    return;
  }
  (opts.info ?? ((line) => logger.info(line)))({ message: nativeBetaNotice() });
}
