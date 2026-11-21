import { HackCliError } from "../lib/cli-result.ts";

/**
 * The setting the runtime reads at `runtime up`: how old, in whole seconds, a
 * recorded passing host sample may be and still replace the one-second
 * admission wait of a pool start. The runtime's default is 60; `0` turns
 * reuse off.
 */
export const NATIVE_ADMISSION_REUSE_SETTING =
  "HACK_NATIVE_ADMISSION_REUSE_SECONDS";

/** The largest bound the runtime accepts, in seconds. */
const MAX_BOUND_SECONDS = 600;

/** One to six ASCII decimal digits, as the runtime bounds its own parse. */
const DIGITS = /^[0-9]{1,6}$/;

/** The runtime's own sentence for `admission_reuse_setting`. */
const REFUSAL = `${NATIVE_ADMISSION_REUSE_SETTING} must be a whole number of seconds from 0 to ${MAX_BOUND_SECONDS}; 0 turns reuse off. A larger value is refused, not reduced to ${MAX_BOUND_SECONDS}.`;

/**
 * The environment addition for one runtime request. Runtime subprocesses get
 * a closed system environment, so the bound is handed to `runtime up`, the
 * one command that reads it, and to nothing else. The rule is the runtime's
 * (`Reuse::parse` in the runtime's admission module): digits naming 0 to 600,
 * passed on as written, `0` included. Anything else, a value above 600 too,
 * is refused here, before the subprocess starts, instead of quietly becoming
 * the default or the maximum. Unset and empty hand over nothing, so the
 * runtime's default applies.
 */
export function nativeAdmissionReuseEnvironment(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  if (!(args[0] === "runtime" && args[1] === "up")) {
    return {};
  }
  const value = env[NATIVE_ADMISSION_REUSE_SETTING];
  if (value === undefined || value === "") {
    return {};
  }
  if (!(DIGITS.test(value) && Number(value) <= MAX_BOUND_SECONDS)) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: REFUSAL,
    });
  }
  return { [NATIVE_ADMISSION_REUSE_SETTING]: value };
}
