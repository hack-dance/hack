import { isAbsolute } from "node:path";

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

/**
 * Parse `HACK_NATIVE_PREPARED_BASE` (`prefer`, `require`, or unset/`off` to disable) and the
 * optional absolute `HACK_NATIVE_PREPARED_BASE_STORE`. Invalid combinations throw before any
 * runtime effect.
 */
export function parseNativePreparedBase(
  env: Environment
): NativePreparedBase | undefined {
  const mode = env.HACK_NATIVE_PREPARED_BASE;
  const store = env.HACK_NATIVE_PREPARED_BASE_STORE;
  const hasStore = store !== undefined && store !== "";
  if (mode === undefined || mode === "" || mode === "off") {
    if (hasStore) {
      throw new Error(
        "HACK_NATIVE_PREPARED_BASE_STORE requires HACK_NATIVE_PREPARED_BASE=prefer or require."
      );
    }
    return undefined;
  }
  if (mode !== "prefer" && mode !== "require") {
    throw new Error(
      "HACK_NATIVE_PREPARED_BASE must be prefer, require or off."
    );
  }
  if (!hasStore) {
    return { mode };
  }
  if (!isAbsolute(store)) {
    throw new Error(
      "HACK_NATIVE_PREPARED_BASE_STORE must be an absolute path."
    );
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
