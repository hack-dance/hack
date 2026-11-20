import { isRecord } from "../lib/guards.ts";

/**
 * What the runtime reports (`runtime up --json`, field `hot_reload`) for a
 * pool boot whose choice about host-to-guest change notifications is not the
 * plain default: off, or forced on over shared folders past the entry limit.
 */
export type NativeHotReloadNotice = {
  readonly state: "on" | "off";
  readonly reason: "large_share" | "setting";
  readonly limit: number;
};

const LIMIT_MAX = 100_000_000;

/**
 * A notice from exactly `{state, reason, limit}` and nothing else, or null.
 * The runtime's own message is never read: what is printed is one of the
 * fixed sentences below with one bounded number in it.
 */
export function parseNativeHotReloadNotice(
  value: unknown
): NativeHotReloadNotice | null {
  if (
    !(
      isRecord(value) &&
      Object.keys(value).every((key) =>
        ["state", "reason", "limit"].includes(key)
      )
    )
  ) {
    return null;
  }
  const { state, reason, limit } = value;
  if (
    !(
      (state === "on" || state === "off") &&
      (reason === "large_share" || reason === "setting") &&
      Number.isSafeInteger(limit) &&
      Number(limit) > 0 &&
      Number(limit) <= LIMIT_MAX
    ) ||
    // On with a large share and no setting is the default the runtime never reports.
    (state === "on" && reason === "large_share")
  ) {
    return null;
  }
  return { state, reason, limit: Number(limit) };
}

/**
 * The notice in a `runtime up` or `runtime status` result, or null when the
 * pool keeps the plain default (the runtime then reports only `state: "on"`)
 * or the result is not what this build expects.
 */
export function nativeHotReloadNoticeFromPool(
  pool: unknown
): NativeHotReloadNotice | null {
  if (!(isRecord(pool) && isRecord(pool.hot_reload))) {
    return null;
  }
  const { state, reason, limit } = pool.hot_reload;
  return parseNativeHotReloadNotice({ state, reason, limit });
}

/**
 * What forcing it on costs a start, as measured on the pinned provider (see
 * the runtime README, "Hot reload on shared source").
 */
export const NATIVE_HOT_RELOAD_FORCED_COST =
  "seconds for tens of thousands, and the start fails if that takes longer than 30 seconds";

/** The one line shown on stderr for a notice. */
export function renderNativeHotReloadNotice(
  notice: NativeHotReloadNotice
): string {
  const limit = notice.limit.toLocaleString("en-US");
  if (notice.state === "on") {
    return `Hot reload on shared source is forced on (HACK_NATIVE_HOT_RELOAD=on) with more than ${limit} files and folders shared: every start first reads all of them (${NATIVE_HOT_RELOAD_FORCED_COST}), and they are read again every second while the project runs.`;
  }
  if (notice.reason === "setting") {
    return "Hot reload on shared source is off: HACK_NATIVE_HOT_RELOAD=off. Services read and write the same files; file watchers inside them do not see edits made on the Mac.";
  }
  return `Hot reload on shared source is off: the shared project folders hold more than ${limit} files and folders, and the virtual machine would read every one before it starts and again every second. Services read and write the same files; file watchers inside them do not see edits made on the Mac. Remove installed dependency folders from the checkout to bring it back (localDirectories keeps them on the virtual machine's disk), or set HACK_NATIVE_HOT_RELOAD=on to force it on.`;
}
