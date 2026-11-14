type RetirementTraceEvent =
  | "native-owner-check"
  | "native-inputs-fresh"
  | "native-directories-fresh"
  | "native-owner-fresh"
  | "native-controller-fresh"
  | "native-abandon-begin"
  | "native-abandon-entry"
  | "native-abandon-controller"
  | "native-abandon-retained"
  | "native-abandon-settled"
  | "native-abandon-failed"
  | "abort-begin"
  | "abort-refresh-fresh"
  | "abort-refresh-token"
  | "abort-refreshed"
  | "abort-mux-stop-begin"
  | "abort-mux-stop-end"
  | "abort-retired"
  | "abort-failed"
  | "birth-refresh-begin"
  | "birth-refresh-panes"
  | "birth-refresh-identities"
  | "capture-begin"
  | "capture-reads"
  | "capture-complete"
  | "retirement-captured"
  | "retirement-mux-stopped"
  | "group-signal"
  | "group-signal-failed"
  | "group-census"
  | "group-census-failed"
  | "group-wait-ended";

/** Opt-in diagnostics: only fixed event labels, counts, PIDs and boolean outcomes. */
export function traceLifecycleRetirement(
  event: RetirementTraceEvent,
  fields: Readonly<Record<string, number | boolean | readonly number[]>> = {},
  error?: unknown
): void {
  if (process.env.HACK_LIFECYCLE_RETIREMENT_TRACE !== "1") {
    return;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  console.error(
    "[lifecycle-retirement]",
    JSON.stringify({
      event,
      ...fields,
      ...(error === undefined
        ? {}
        : {
            failed: true,
            eperm: code === "EPERM",
            esrch: code === "ESRCH",
            timedOut: code === "ETIMEDOUT",
          }),
    })
  );
}
