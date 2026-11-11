import type { NativeProjectPsResult } from "../backends/native-project-observe.ts";
import { emitCliResult, HackCliError, okResult } from "../lib/cli-result.ts";

/**
 * `hack up --detach` on a native project that is already up (HACK-2102).
 *
 * A detached native `up` launches a background foreground `up`. When the
 * project already has a live graph, that child refuses it and exits, and the
 * launcher could only report that startup "was not confirmed". On Compose the
 * same command is a successful no-op, and agents run it freely. So the
 * launcher first makes one read-only observation, the same one `hack ps`
 * makes, and answers from it when the project is already up.
 *
 * Only a confirmed state is answered here: a ready graph whose foreground
 * owner answered and whose runtime it verified. Every other state launches
 * exactly as before, so a start that is genuinely unconfirmed still reports
 * its own reason.
 */
export type NativeAlreadyRunning =
  /** Not a confirmed live, ready graph: launch as before. */
  | { readonly kind: "launch" }
  /** Every service is running, or is a one-shot that finished successfully. */
  | {
      readonly kind: "running";
      readonly started: string[];
      readonly completed: string[];
    }
  /** The graph is live and ready, but these services are not up. */
  | { readonly kind: "partial"; readonly down: string[] };

/** Byte-wise order, so output does not depend on the caller's locale. */
function byCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

export function classifyNativeAlreadyRunning(
  result: NativeProjectPsResult
): NativeAlreadyRunning {
  if (result.status !== "observed" || result.phase !== "ready-observed") {
    return { kind: "launch" };
  }
  const started: string[] = [];
  const completed: string[] = [];
  const down: string[] = [];
  for (const item of result.items) {
    if (
      item.state === "running" &&
      (item.health === null || item.health === "healthy")
    ) {
      started.push(item.service);
    } else if (item.state === "exited" && item.exitCode === 0) {
      completed.push(item.service);
    } else {
      down.push(item.service);
    }
  }
  // Finished one-shots alone are not a running project.
  if (started.length === 0 && down.length === 0) {
    return { kind: "launch" };
  }
  return down.length > 0
    ? { kind: "partial", down: down.sort(byCodePoint) }
    : {
        kind: "running",
        started: started.sort(byCodePoint),
        completed: completed.sort(byCodePoint),
      };
}

/**
 * Native `up` starts a whole project and cannot start part of a running one.
 * Naming the services and the commands that do work replaces the launcher's
 * generic refusal; nothing was started or stopped.
 */
export function nativePartiallyRunningRefusal(
  down: readonly string[]
): HackCliError {
  return new HackCliError({
    code: "E_STARTUP_INCOMPLETE",
    message: `Native project is already running, but these services are not up: ${down.join(", ")}. Native up cannot start part of a running project: run hack restart, or hack down and then hack up. Inspect them with hack ps and hack logs SERVICE --no-follow. Nothing was started or stopped.`,
  });
}

/** The successful no-op, in the same shape as a detached start that became ready. */
export function reportNativeAlreadyRunning(opts: {
  readonly json: boolean;
  readonly project: string;
  readonly branch: string | null;
  readonly composeProject: string;
  readonly started: readonly string[];
  readonly completed: readonly string[];
  readonly startedAtMs: number;
}): void {
  if (!opts.json) {
    process.stdout.write(
      "Project is already running. Use hack ps, hack logs SERVICE --no-follow, and hack down.\n"
    );
    return;
  }
  emitCliResult({
    result: okResult({
      data: {
        action: "up",
        alreadyRunning: true,
        project: opts.project,
        branch: opts.branch,
        composeProject: opts.composeProject,
        services: {
          started: [...opts.started],
          completed: [...opts.completed],
          stopped: [],
          failed: [],
        },
        durationMs: Date.now() - opts.startedAtMs,
      },
    }),
  });
}
