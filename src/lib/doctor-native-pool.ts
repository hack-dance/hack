/**
 * Doctor machine check: a native VM pool left running with nothing using it.
 *
 * The pool belongs to the native home, not to a project, so this is a machine
 * check: it runs once, in a project doctor run too, marked machine scope. The
 * runtime decides idleness: it warns only when `runtime status --json`
 * reports `pool_idle: true` (running, a live provider process, and no graph,
 * Compose or native-authored, running or retained, no environment allocation
 * and no exec session). `false`, `null`, an older runtime without the field
 * or a stopped pool never produces an idle warning. Unknown status produces
 * an observation warning instead of an all-clear. Doctor never stops the pool, and
 * `--fix` does not either: the message gives the exact stop command.
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
  const stopped =
    status.phase === "stopped" ||
    status.phase === "uninitialized" ||
    status.phase === "process-exited" ||
    status.process_alive === false;
  const running = status.phase === "running" && status.process_alive === true;
  let state: NativePoolReport["state"];
  if (stopped) {
    state = "stopped";
  } else if (running && status.pool_idle === true) {
    state = "idle";
  } else if (running && status.pool_idle === false) {
    state = "in_use";
  } else {
    state = "unknown";
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
  readonly name: typeof NATIVE_POOL_IDLE_CHECK;
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
        message: `The native VM pool is running and nothing uses it: no project graph, running or retained, and no exec session${memory ? `. It holds ${memory}` : ""}. Stop it with: ${nativePoolStopCommand(opts.runtime)}`,
        nativePool: report,
      };
    }
    case "in_use":
      return {
        name,
        status: "ok",
        message:
          report.graphRuns === null || report.graphRuns === 0
            ? "The native VM pool is in use."
            : `The native VM pool records ${report.graphRuns} project graph${report.graphRuns === 1 ? "" : "s"}, running or retained.`,
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
        status: "warn",
        message:
          opts.status === null
            ? "Native runtime status unavailable; pool idleness could not be checked."
            : "The runtime could not establish the native VM pool's state or users; pool idleness could not be checked.",
        nativePool: report,
      };
  }
}
