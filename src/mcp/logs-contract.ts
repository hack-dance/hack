/**
 * Result contract for the MCP `hack.project.logs.tail` and
 * `hack.project.logs.snapshot` tools.
 *
 * A collection ends in exactly one outcome:
 * - `complete`: the backend reached end of stream and exited 0.
 * - `cutoff`: the MCP server stopped collection at one of its own bounds. This
 *   is a success; `data.cutoff` names the bound and its effective limit.
 * - `backend_error`: the log backend reported failure (a stream `error` event,
 *   a failing `end` event, or a non-zero exit the server did not cause). This
 *   is a closed error, never a truncated success.
 * - `cancelled`: the request was aborted or the session closed; nothing is
 *   kept for a later request (see docs/reference/mcp-logs.md).
 *
 * Failure evidence counts only while collection is still running. Once the
 * server stops the command for a bound, a later `error`/`end` event or a
 * signal exit status is a consequence of that stop, not a backend failure.
 * The byte bound is the exception for events: the retained prefix was written
 * before the child was signalled and nothing after the cut is parsed, so an
 * `error` or failing `end` event inside that prefix is still a failure.
 */

/** Why collection stopped, as reported in `data.stop_reason`. */
export type McpLogStopReason =
  | "eof"
  | "max_events"
  | "timeout"
  | "output_limit"
  | "cancelled"
  | "interrupted";

/** The bound that ended a successful, incomplete collection. */
export type McpLogCutoff = {
  /** `events` counts `type: "log"` events only; `bytes` is the shared stdout
   * plus stderr capture budget; `time` is the collection window. */
  readonly bound: "events" | "bytes" | "time";
  readonly limit: number;
};

export type McpLogOutcome =
  | { readonly kind: "complete" }
  | { readonly kind: "cutoff"; readonly cutoff: McpLogCutoff }
  | { readonly kind: "backend_error" }
  | { readonly kind: "cancelled" };

/** Closed post-spawn failure. The message is fixed and never repeats backend
 * output, caller input or query text. */
export const MCP_LOG_BACKEND_ERROR = Object.freeze({
  code: "E_UNEXPECTED",
  reason: "backend_error",
  message: "Log backend failed. Run 'hack logs' for details.",
} as const);

/** End reasons written by the CLI's JSON stream for a normal end of stream. */
const CLEAN_END_REASONS: ReadonlySet<string> = new Set(["eof", "closed"]);

/** Classify one parsed `hack logs --json` stream event. */
export function observeLogStreamEvent(event: Record<string, unknown>): {
  readonly isLog: boolean;
  readonly backendFailure: boolean;
} {
  const type = event.type;
  if (type === "log") {
    return { isLog: true, backendFailure: false };
  }
  if (type === "error") {
    return { isLog: false, backendFailure: true };
  }
  if (type === "end") {
    const reason = event.reason;
    return {
      isLog: false,
      backendFailure:
        typeof reason === "string" && !CLEAN_END_REASONS.has(reason),
    };
  }
  return { isLog: false, backendFailure: false };
}

/**
 * Decide the outcome of a finished collection. Backend failure evidence wins
 * over a cutoff; a non-zero exit after a server-initiated stop is ignored.
 */
export function classifyLogCollection(opts: {
  readonly stopReason: McpLogStopReason;
  readonly exitCode: number;
  readonly backendFailureObserved: boolean;
  readonly limits: {
    readonly maxEvents?: number;
    readonly timeMs: number;
    readonly bytes: number;
  };
}): McpLogOutcome {
  if (opts.backendFailureObserved) {
    return { kind: "backend_error" };
  }
  switch (opts.stopReason) {
    case "cancelled":
    case "interrupted":
      return { kind: "cancelled" };
    case "max_events":
      return {
        kind: "cutoff",
        cutoff: { bound: "events", limit: opts.limits.maxEvents ?? 0 },
      };
    case "timeout":
      return {
        kind: "cutoff",
        cutoff: { bound: "time", limit: opts.limits.timeMs },
      };
    case "output_limit":
      return {
        kind: "cutoff",
        cutoff: { bound: "bytes", limit: opts.limits.bytes },
      };
    case "eof":
      return opts.exitCode === 0
        ? { kind: "complete" }
        : { kind: "backend_error" };
    default: {
      const unreachable: never = opts.stopReason;
      return unreachable;
    }
  }
}

/** Narrow a lifetime stop reason to the closed set the logs contract reports. */
export function toLogStopReason(reason: string): McpLogStopReason {
  switch (reason) {
    case "max_events":
    case "timeout":
    case "output_limit":
    case "cancelled":
    case "interrupted":
      return reason;
    default:
      return "interrupted";
  }
}
