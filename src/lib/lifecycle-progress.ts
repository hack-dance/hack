/**
 * `hack up|down|restart --json --progress`: an ndjson stream on stdout.
 *
 * Contract (schema {@link LIFECYCLE_PROGRESS_SCHEMA}):
 * - line 1: `{schema, type: "start", ts, action, project?}`, written once the
 *   command resolved its project;
 * - zero or more `{type: "progress", ts, service, phase}` lines, where
 *   `service` is `null` for project-level phases;
 * - one closing line: the command's ordinary `--json` envelope, compact.
 *   Nothing follows it.
 *
 * A command arms the stream before any work and starts it once validation
 * and project resolution succeeded. A result emitted before the stream
 * started (a refusal) is the ordinary pretty envelope, not a stream.
 *
 * Phases are only signals the Compose path already observes; a phase that
 * did not happen is skipped, never synthesized.
 */

import { writeSync } from "node:fs";
import { CliUsageError } from "../cli/command.ts";
import { type CliResult, errorResult, renderCliResult } from "./cli-result.ts";
import type { DependencyStartupPhase } from "./dependency-startup-progress.ts";
import { isRecord } from "./guards.ts";

export const LIFECYCLE_PROGRESS_SCHEMA = "hack.lifecycle-progress.v1";

export type LifecycleProgressAction = "up" | "down" | "restart";

/** Project-level phases (`service: null`). */
export type LifecycleProjectPhase =
  | "images"
  | "starting"
  | "stopping"
  | "stopped";

/** Final per-service state, taken from the closing envelope. */
export type LifecycleServiceFinalPhase =
  | "running"
  | "completed"
  | "stopped"
  | "failed";

export type LifecycleProgressPhase =
  | LifecycleProjectPhase
  | DependencyStartupPhase
  | LifecycleServiceFinalPhase;

export type LifecycleProgressEvent = {
  readonly service: string | null;
  readonly phase: LifecycleProgressPhase;
};

/**
 * One command's stream. `write` receives complete lines (with a trailing
 * newline); `now` supplies the timestamp, injectable for tests.
 */
export class LifecycleProgressStream {
  private state: "armed" | "streaming" | "closed" = "armed";
  private readonly action: LifecycleProgressAction;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  constructor(opts: {
    readonly action: LifecycleProgressAction;
    readonly write: (line: string) => void;
    readonly now?: () => Date;
  }) {
    this.action = opts.action;
    this.write = opts.write;
    this.now = opts.now ?? (() => new Date());
  }

  /** Write the first line. Later calls are ignored. */
  begin(opts: { readonly project?: string }): void {
    if (this.state !== "armed") {
      return;
    }
    this.state = "streaming";
    this.line({
      schema: LIFECYCLE_PROGRESS_SCHEMA,
      type: "start",
      ts: this.ts(),
      action: this.action,
      ...(opts.project === undefined ? {} : { project: opts.project }),
    });
  }

  /** Write one progress line; ignored before {@link begin} or after close. */
  progress(event: LifecycleProgressEvent): void {
    if (this.state !== "streaming") {
      return;
    }
    this.line({
      type: "progress",
      ts: this.ts(),
      service: event.service,
      phase: event.phase,
    });
  }

  /**
   * Write the final per-service lines and the compact envelope, then close.
   * Returns false (writing nothing) when the stream never began, so the
   * caller prints the ordinary pretty envelope.
   */
  close(opts: { readonly result: CliResult<unknown> }): boolean {
    if (this.state === "closed") {
      // Already closed (e.g. by a signal): swallow later envelopes so the
      // compact closing line stays last.
      return true;
    }
    if (this.state !== "streaming") {
      return false;
    }
    for (const event of finalServiceEvents(opts.result)) {
      this.progress(event);
    }
    this.state = "closed";
    this.write(renderCliResult({ result: opts.result, compact: true }));
    return true;
  }

  private ts(): string {
    return this.now().toISOString();
  }

  private line(value: Record<string, unknown>): void {
    this.write(`${JSON.stringify(value)}\n`);
  }
}

const FINAL_SERVICE_KEYS: ReadonlyArray<
  readonly [string, LifecycleServiceFinalPhase]
> = [
  ["started", "running"],
  ["running", "running"],
  ["completed", "completed"],
  ["stopped", "stopped"],
  ["failed", "failed"],
];

/**
 * Per-service final states the envelope already carries: `data.services`
 * on success, or the `running/completed/failed` lists an incomplete-startup
 * error puts in `detail`. Other envelopes yield none.
 */
export function finalServiceEvents(
  result: CliResult<unknown>
): readonly LifecycleProgressEvent[] {
  let source: unknown = result.ok ? undefined : result.error.detail;
  if (result.ok && isRecord(result.data)) {
    source = result.data.services;
  }
  if (!isRecord(source)) {
    return [];
  }
  const events: LifecycleProgressEvent[] = [];
  for (const [key, phase] of FINAL_SERVICE_KEYS) {
    const names = source[key];
    if (!Array.isArray(names)) {
      continue;
    }
    for (const name of names) {
      if (typeof name === "string") {
        events.push({ service: name, phase });
      }
    }
  }
  return events;
}

let active: LifecycleProgressStream | null = null;

/**
 * Validate `--progress` before any project or runtime work and arm the
 * stream when requested. It needs `--json`, and only the Compose backend
 * reports phases today: the native backend (`HACK_RUNTIME_BACKEND=native`)
 * refuses it. Native-authored projects refuse it through their
 * unsupported-options check.
 */
export function prepareLifecycleProgress(opts: {
  readonly action: LifecycleProgressAction;
  readonly progress: boolean | undefined;
  readonly json: boolean | undefined;
  readonly backend: string | undefined;
}): void {
  if (opts.progress !== true) {
    return;
  }
  if (opts.json !== true) {
    throw new CliUsageError("--progress requires --json.");
  }
  if (opts.backend === "native") {
    throw new CliUsageError(
      "Native lifecycle commands do not support --progress yet."
    );
  }
  armLifecycleProgress({ action: opts.action });
}

/**
 * Arm the process-wide stream for this command. One lifecycle command runs
 * per process; deep Compose code reports through
 * {@link reportLifecycleProgress} without threading a parameter.
 */
export function armLifecycleProgress(opts: {
  readonly action: LifecycleProgressAction;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}): LifecycleProgressStream {
  active = new LifecycleProgressStream({
    action: opts.action,
    // Synchronous: the signal path closes the stream and then re-raises the
    // signal, which would drop a write still queued on a stdout pipe.
    write: opts.write ?? ((line) => writeSync(1, line)),
    now: opts.now,
  });
  // Installed when armed, well before `start`: signal handlers may register
  // asynchronously, and a signal before `start` closes nothing (close is a
  // no-op while armed) and still ends the process by that signal.
  removeSignalClose();
  installSignalClose();
  return active;
}

/** Start the armed stream, if any. */
export function beginLifecycleProgress(opts: {
  readonly project?: string;
}): void {
  if (!active) {
    return;
  }
  active.begin(opts);
}

let signalHandlers: Array<readonly [NodeJS.Signals, () => void]> = [];

/**
 * SIGINT/SIGTERM after `start` closes the stream with an `E_CANCELLED`
 * envelope; before `start` it writes nothing. Other handlers (lifecycle cleanup) keep running and own the exit;
 * when none remain, the signal is raised again so the process still ends by
 * that signal, as it would without `--progress`.
 */
function installSignalClose(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      removeSignalClose();
      active?.close({
        result: errorResult({
          code: "E_CANCELLED",
          message: `Interrupted by ${signal}.`,
        }),
      });
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    };
    signalHandlers.push([signal, handler]);
    process.on(signal, handler);
  }
}

function removeSignalClose(): void {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  signalHandlers = [];
}

/** Report one phase; a no-op unless a stream is armed and started. */
export function reportLifecycleProgress(event: LifecycleProgressEvent): void {
  active?.progress(event);
}

/**
 * Close the active stream with the command's envelope. Returns false when no
 * stream started; the caller then prints the ordinary envelope.
 */
export function closeLifecycleProgress(opts: {
  readonly result: CliResult<unknown>;
}): boolean {
  const closed = active?.close(opts) ?? false;
  if (closed) {
    removeSignalClose();
  }
  return closed;
}

/** Whether `--progress` was requested for this process (armed or started). */
export function isLifecycleProgressRequested(): boolean {
  return active !== null;
}

/** Test seam: drop the process-wide stream. */
export function resetLifecycleProgress(): void {
  removeSignalClose();
  active = null;
}
