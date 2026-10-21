import { isAbsolute } from "node:path";
import { HackCliError } from "../lib/cli-result.ts";

/**
 * Opt-in prepared base for a fresh native pool (`runtime up --prepared-base`).
 *
 * The runtime uses an independently verified base only when it creates a new pool; an
 * existing pool is unaffected. `prefer` keeps the stock disk templates and records why when
 * no usable base exists, while `require` refuses before creating anything.
 */
export interface NativePreparedBase {
  readonly mode: "prefer" | "require";
  /**
   * Absolute private store on the same APFS volume as the candidate home. When omitted, the
   * installed candidate uses `<HACK_NATIVE_HOME>/prepared-bases`.
   */
  readonly store?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

/** An invalid selection is user configuration: a closed `E_CONFIG_INVALID` refusal. */
function invalid(message: string): HackCliError {
  return new HackCliError({ code: "E_CONFIG_INVALID", message });
}

/**
 * Parse `HACK_NATIVE_PREPARED_BASE` (`prefer`, `require`, or unset/`off` to disable) and the
 * optional absolute `HACK_NATIVE_PREPARED_BASE_STORE`. Invalid combinations throw a closed
 * `E_CONFIG_INVALID` refusal before any runtime effect.
 */
export function parseNativePreparedBase(
  env: Environment
): NativePreparedBase | undefined {
  const mode = env.HACK_NATIVE_PREPARED_BASE;
  const store = env.HACK_NATIVE_PREPARED_BASE_STORE;
  const hasStore = store !== undefined && store !== "";
  if (mode === undefined || mode === "" || mode === "off") {
    if (hasStore) {
      throw invalid(
        "HACK_NATIVE_PREPARED_BASE_STORE requires HACK_NATIVE_PREPARED_BASE=prefer or require."
      );
    }
    return undefined;
  }
  if (mode !== "prefer" && mode !== "require") {
    throw invalid("HACK_NATIVE_PREPARED_BASE must be prefer, require or off.");
  }
  if (!hasStore) {
    return { mode };
  }
  if (!isAbsolute(store)) {
    throw invalid("HACK_NATIVE_PREPARED_BASE_STORE must be an absolute path.");
  }
  return { mode, store };
}

/** The `runtime up` arguments for a prepared-base selection; none when disabled. */
export function preparedBaseArguments(
  selection: NativePreparedBase | undefined
): string[] {
  if (!selection) {
    return [];
  }
  return [
    "--prepared-base",
    selection.mode,
    ...(selection.store ? ["--prepared-base-store", selection.store] : []),
  ];
}
