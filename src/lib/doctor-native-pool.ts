/**
 * Doctor machine check: a native VM pool left running with no graph.
 *
 * The pool belongs to the native home, not to a project, so this is a machine
 * check: it runs once, in a project doctor run too, marked machine scope. It
 * warns only when `runtime status --json` proves the pool is running and
 * records no graph, running or retained (`graph_runs: 0`). A missing or
 * unreadable inventory, an older runtime without the field, or a stopped
 * pool is never a warning. Doctor never stops the pool, and `--fix` does
 * not either: the message gives the exact stop command.
 */

import { isRecord } from "./guards.ts";
import { quoteShellWord } from "./logs.ts";

export const NATIVE_POOL_IDLE_CHECK = "native pool idle";

/** The `nativePool` JSON field: what the runtime reported, no paths. */
export type NativePoolReport = {
  readonly state: "idle" | "in_use" | "stopped" | "unknown";
  readonly graphRuns: number | null;
  /** Physical footprint of the provider process, when the runtime reports it. */
  readonly memoryBytes: number | null;
  /** The guest memory the pool's profile reserves. */
  readonly guestMemoryMib: number | null;
};

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/** Reads the fields this check needs from a `runtime status --json` reply. */
export function readNativePoolReport(status: unknown): NativePoolReport {
  if (!isRecord(status)) {
    return {
      state: "unknown",
      graphRuns: null,
      memoryBytes: null,
      guestMemoryMib: null,
    };
  }
  const memory = isRecord(status.provider_memory)
    ? count(status.provider_memory.physical_footprint_bytes)
    : null;
  const guestMemoryMib = count(status.guest_memory_mib);
  const graphRuns = count(status.graph_runs);
  const running = status.phase === "running" && status.process_alive !== false;
  let state: NativePoolReport["state"];
  if (!running) {
    state = "stopped";
  } else if (graphRuns === null) {
    state = "unknown";
  } else {
    state = graphRuns === 0 ? "idle" : "in_use";
  }
  return {
    state,
    graphRuns,
    memoryBytes: running ? memory : null,
    guestMemoryMib,
  };
}

function formatMemory(report: NativePoolReport): string | null {
  if (report.memoryBytes !== null) {
    const gib = report.memoryBytes / 1024 ** 3;
    return gib >= 1
      ? `${gib.toFixed(1)} GiB`
      : `${Math.round(report.memoryBytes / 1024 ** 2)} MiB`;
  }
  return report.guestMemoryMib === null
    ? null
    : `up to ${report.guestMemoryMib} MiB of guest memory`;
}

/** The exact command that stops this home's pool. */
export function nativePoolStopCommand(runtime: {
  readonly binary: string;
  readonly home: string;
}): string {
  return [
    quoteShellWord(runtime.binary),
    "--candidate-root",
    quoteShellWord(runtime.home),
    "runtime",
    "down",
    "--json",
  ].join(" ");
}

export function nativePoolIdleCheck(opts: {
  /** The `runtime status --json` reply, or null when it could not be read. */
  readonly status: unknown;
  readonly runtime: { readonly binary: string; readonly home: string };
}): {
  readonly name: string;
  readonly status: "ok" | "warn";
  readonly message: string;
  readonly nativePool: NativePoolReport;
} {
  const report = readNativePoolReport(opts.status);
  const name = NATIVE_POOL_IDLE_CHECK;
  switch (report.state) {
    case "idle": {
      const memory = formatMemory(report);
      return {
        name,
        status: "warn",
        message: `The native VM pool is running with no project graph, running or retained${memory ? `, and holds ${memory}` : ""}. Stop it with: ${nativePoolStopCommand(opts.runtime)}`,
        nativePool: report,
      };
    }
    case "in_use":
      return {
        name,
        status: "ok",
        message: `The native VM pool serves ${report.graphRuns} project graph${report.graphRuns === 1 ? "" : "s"}.`,
        nativePool: report,
      };
    case "stopped":
      return {
        name,
        status: "ok",
        message: "The native VM pool is not running.",
        nativePool: report,
      };
    default:
      return {
        name,
        status: "ok",
        message:
          opts.status === null
            ? "Skipped (native runtime status unavailable)"
            : "The native VM pool is running; its graphs could not be counted, so idleness is not judged.",
        nativePool: report,
      };
  }
}
