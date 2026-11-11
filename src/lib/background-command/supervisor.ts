import { constants, openSync } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { createPrivateFileExclusive } from "../private-file.ts";
import { auditEnd } from "./audit.ts";
import {
  CAPTURE_LIMIT_BYTES,
  type CommandMeta,
  commandsRoot,
  endedEvent,
  isCommandId,
  type JournalPaths,
  JournalWriter,
  journalPaths,
  type LaunchRecord,
  OUTPUT_EVENT_LIMIT,
  type OutputStream,
  outputPath,
  readLaunch,
  readMeta,
  reconcileTail,
} from "./journal.ts";
import { pumpStream } from "./output-pump.ts";
import { encodeSecrets } from "./output-scanner.ts";
import {
  closeDescriptor,
  identityMatches,
  observeIdentities,
  observeProcessGroup,
  openAppendOnlyOutput,
  type ProcessIdentity,
  readOwnIdentity,
  readPrivateInput,
  signalProcess,
  signalProcessGroup,
} from "./platform.ts";
import {
  CHILD_BIRTH_EXITED,
  CHILD_BIRTH_UNOBSERVED,
  withJournalLock,
} from "./recovery.ts";
import { StallTracker } from "./stall.ts";

const NO_SPACE = new Error("no space for command events");

function isNoSpaceError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOSPC" || error.code === "EDQUOT")
  );
}

/** Hidden entrypoint of the hack binary: `hack <this> <commandId>`. */
export const BACKGROUND_SUPERVISOR_ARGUMENT =
  "--internal-background-command-supervisor";

/** Values shorter than this are not redacted (too many false matches). */
export const REDACT_MIN_BYTES = 6;

const TICK_MS = 200;
const EMIT_INTERVAL_MS = 500;
const EMIT_EAGER_BYTES = 16 * 1024;
const STOP_GRACE_MS = 2000;

type StopReason = "cancelled" | "timed_out";

/**
 * Supervisor of one background command, run in its own session.
 *
 * It records its identity, starts the child in a new process group with stdin
 * closed and stdout/stderr appended by the kernel to the journal's files, and
 * then only observes: it announces appended output as byte-range events,
 * redacts known values in place before announcing them, reports advisory
 * stalls, enforces the timeout, stops capture at the limit without stopping
 * the command, and writes the single `command.ended`. If it dies, the child
 * keeps running and writing; a later reader takes over (see recovery.ts).
 *
 * SIGTERM (sent by cancel after identity checks) stops the child group and
 * records `cancelled`; a pending `cancel.json` has the same effect, so a
 * signal that arrives before the handler is installed is not lost.
 */
export async function runBackgroundSupervisor(opts: {
  readonly commandId: string;
  readonly root?: string;
}): Promise<number> {
  if (!isCommandId(opts.commandId)) {
    return 2;
  }
  const signals = installSignalHandlers();
  const root = opts.root ?? commandsRoot();
  const paths = journalPaths({ root, commandId: opts.commandId });
  const prepared = await prepare(paths);
  if (prepared === "failed" || prepared === "already_ended") {
    return prepared === "failed" ? 1 : 0;
  }
  const { meta, launch, writer } = prepared;
  const startedMono = performance.now();
  const finish = async (payload: Record<string, unknown>): Promise<number> => {
    const ended = await writer.write("command.ended", {
      durationMs: Math.round(performance.now() - startedMono),
      ...payload,
    });
    await auditEnd({ paths, meta, payload: ended.payload });
    await unlink(paths.reserve).catch(() => undefined);
    return 0;
  };
  const baseEnded = {
    exitCode: null,
    signal: null,
    truncated: false,
    suppressed: meta.capture === "metadata",
  };
  if (await cancelRequested(paths)) {
    return await finish({
      ...baseEnded,
      outcome: "cancelled",
      reason: "cancelled_before_start",
    });
  }
  // Written before the spawn: if this process dies before the child's
  // identity is recorded, readers know a child may exist ("unknown").
  await createPrivateFileExclusive({
    path: paths.spawning,
    text: JSON.stringify({ at: new Date().toISOString() }),
  });
  const proc = startChild({ paths, meta, launch });
  if (!proc) {
    return await finish({
      ...baseEnded,
      outcome: "failed",
      reason: "spawn_failed",
    });
  }
  const capture = new OutputCapture({
    paths,
    writer,
    full: meta.capture === "full",
    secrets: encodeSecrets({
      values: prepared.redactValues,
      minLength: REDACT_MIN_BYTES,
    }),
    stall: new StallTracker(
      meta.stallDetection === "available" ? meta.stallAfterMs : 0,
      performance.now()
    ),
  });
  // Everything after the spawn is guarded: a failure here (for example a
  // full disk while recording the child) must not abandon a running child.
  try {
    // Without a child record nobody could cancel or verify the child later,
    // so a failure here stops it. A full disk on `command.started` only
    // stops capture, like any other event.
    await recordChild({ paths, proc });
    await writer
      .write("command.started", { pid: proc.pid, processGroupId: proc.pid })
      .catch((error: unknown) => {
        if (!isNoSpaceError(error)) {
          throw error;
        }
        capture.noSpace = true;
        capture.truncated = true;
      });
    return await finish(
      await superviseChild({
        proc,
        meta,
        paths,
        capture,
        startedMono,
        stopRequested: signals.stopRequested,
      })
    );
  } catch (error: unknown) {
    // An internal failure must not be reported as the command's result, and
    // must not leave the command running with nobody enforcing its timeout.
    // Until Bun has reaped it, the pid cannot have been reused.
    const running = proc.exitCode === null && proc.signalCode === null;
    if (running) {
      signalProcessGroup(proc.pid, "SIGKILL");
    }
    return await finish({
      ...baseEnded,
      truncated: capture.truncated,
      outcome: "unknown",
      reason: "supervisor_error",
      stoppedBySupervisor: running,
      detail: error instanceof Error ? error.name : "error",
    }).catch(() => 1);
  }
}

/**
 * The supervisor has no terminal and must outlive its launcher's session:
 * interrupt, hangup and broken-pipe signals are ignored. SIGTERM is the
 * cancel request.
 */
function installSignalHandlers(): { readonly stopRequested: () => boolean } {
  let requested = false;
  process.on("SIGINT", () => undefined);
  process.on("SIGHUP", () => undefined);
  process.on("SIGPIPE", () => undefined);
  process.on("SIGTERM", () => {
    requested = true;
  });
  return { stopRequested: () => requested };
}

/**
 * Read the request, record this process as the owner (pid, birth, session),
 * and return the writer, or "already_ended" when a canceller that found no
 * supervisor already wrote the final record.
 */
async function prepare(paths: JournalPaths): Promise<
  | "failed"
  | "already_ended"
  | {
      readonly meta: CommandMeta;
      readonly launch: LaunchRecord;
      readonly writer: JournalWriter;
      readonly redactValues: readonly string[];
    }
> {
  const meta = await readMeta(paths);
  const launch = await readLaunch(paths);
  // First, before any child exists: the descriptor must not be inherited.
  const redactValues = parseRedactValues(await readPrivateInput());
  const own = await readOwnIdentity();
  // Never run with less redaction than was accepted: a truncated or missing
  // private input fails the start before the owner record exists, so the
  // launcher reports supervisor_failed_to_start and nothing runs.
  if (
    !(meta && launch && own && redactValues) ||
    redactValues.length !== meta.redaction.values
  ) {
    return "failed";
  }
  await createPrivateFileExclusive({
    path: paths.owner,
    text: JSON.stringify({
      pid: own.identity.pid,
      birth: own.identity.birth,
      processGroupId: own.identity.processGroupId,
      sessionId: own.sessionId,
      newSession: own.sessionId === own.identity.pid,
    }),
  });
  const events = await withJournalLock(
    paths,
    async () => await reconcileTail(paths)
  );
  if (endedEvent(events)) {
    return "already_ended";
  }
  return {
    meta,
    launch,
    redactValues,
    writer: new JournalWriter(paths, meta, events.at(-1)?.seq ?? 0),
  };
}

/**
 * Start the child in its own session and process group, stdin closed, stdout
 * and stderr appended by the kernel to the journal files (or /dev/null for
 * metadata capture). Null when it cannot start.
 */
function startChild(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  readonly launch: LaunchRecord;
}): Bun.Subprocess | null {
  const descriptors =
    opts.meta.capture === "full"
      ? {
          stdout: openAppendOnlyOutput(opts.paths.stdout),
          stderr: openAppendOnlyOutput(opts.paths.stderr),
        }
      : (() => {
          const sink = openSync("/dev/null", constants.O_WRONLY);
          return { stdout: sink, stderr: sink };
        })();
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([...opts.launch.argv], {
      cwd: opts.launch.cwd,
      env: childEnv(),
      stdin: "ignore",
      stdout: descriptors.stdout,
      stderr: descriptors.stderr,
      detached: true,
    });
  } catch {
    return null;
  } finally {
    // The child holds its own copies; the supervisor never writes output.
    closeDescriptor(descriptors.stdout);
    closeDescriptor(descriptors.stderr);
  }
  return proc;
}

/** Record the child's identity (pid, birth, process group) for cancel and recovery. */
async function recordChild(opts: {
  readonly paths: JournalPaths;
  readonly proc: Bun.Subprocess;
}): Promise<void> {
  const { proc } = opts;
  let birth: string | null = null;
  for (let attempt = 0; attempt < 3 && birth === null; attempt += 1) {
    const snapshot = await observeIdentities([proc.pid]);
    birth = snapshot?.get(proc.pid)?.birth ?? null;
    if (birth === null && !unreaped(proc)) {
      // Reaped before `ps` saw it: it is certainly gone.
      birth = CHILD_BIRTH_EXITED;
    }
    if (birth === null) {
      await Bun.sleep(50);
    }
  }
  await createPrivateFileExclusive({
    path: opts.paths.child,
    text: JSON.stringify({
      pid: proc.pid,
      // An unobserved birth never matches, so nothing will signal this pid,
      // and readers treat the child's ownership as unknown, not absent.
      birth: birth ?? CHILD_BIRTH_UNOBSERVED,
      processGroupId: proc.pid,
    }),
  });
}

/**
 * Observe the child until it exits: capture output, enforce the timeout,
 * honour cancel, report stalls. Returns the `command.ended` payload.
 */
async function superviseChild(opts: {
  readonly proc: Bun.Subprocess;
  readonly meta: CommandMeta;
  readonly paths: JournalPaths;
  readonly capture: OutputCapture;
  readonly startedMono: number;
  readonly stopRequested: () => boolean;
}): Promise<Record<string, unknown>> {
  const { proc, capture } = opts;
  let exited = false;
  proc.exited.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    }
  );
  let stopping: StopReason | null = null;
  const stopper = new GroupStopper(proc);
  while (!exited) {
    await Bun.sleep(TICK_MS);
    // A child that finished during the sleep is not stopped or reclassified:
    // its own exit wins over a timeout or cancel noticed afterwards.
    const reason: StopReason | null =
      stopping || exited || !unreaped(proc)
        ? null
        : await stopReason({ ...opts, now: performance.now() });
    if (reason && (await stopper.stop())) {
      stopping = reason;
    }
    await capture.poll(false);
    if (!(stopping || exited)) {
      await capture.checkStall(performance.now());
    }
  }
  const exitCode = await proc.exited;
  // A cancel that arrived while output was being captured (the canceller
  // used to signal the group directly) is still a cancel, not a failure. A
  // clean exit (0, no signal) stays `succeeded` even if a cancel raced it:
  // reporting `cancelled` could make a caller run the command again.
  const cleanExit = exitCode === 0 && proc.signalCode === null;
  if (
    !(stopping || cleanExit) &&
    (opts.stopRequested() || (await cancelRequested(opts.paths)))
  ) {
    stopping = "cancelled";
  }
  // The leader ended on its own while a cancel was pending: the group was
  // never stopped, so its descendants are not known to be gone.
  const lateCancel = stopping === "cancelled" && !stopper.signalled;
  await stopper.finish();
  await capture.poll(true);
  const payload = endedPayload({
    stopping,
    exitCode,
    signal: proc.signalCode ?? null,
    truncated: capture.truncated,
    suppressed: opts.meta.capture === "metadata",
    backend: opts.meta.backend,
    noSpace: capture.noSpace,
  });
  return lateCancel ? { ...payload, descendants: "not_confirmed" } : payload;
}

/** True until Bun has reaped the child: its pid (and group id) cannot be reused. */
function unreaped(proc: Bun.Subprocess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

/**
 * Stops the child's process group. The group id is the child's pid, which is
 * safe to signal only while the child is unreaped. Group members seen then
 * are remembered by pid and birth; after the child is reaped, only members
 * that still match are killed, one by one, so a reused id is never signalled.
 */
class GroupStopper {
  private readonly proc: Bun.Subprocess;
  private readonly members = new Map<number, ProcessIdentity>();
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  /** True once this stopper signalled the child's group. */
  get signalled(): boolean {
    return this.stopped;
  }

  constructor(proc: Bun.Subprocess) {
    this.proc = proc;
  }

  /** False when the child was already reaped: nothing was stopped. */
  async stop(): Promise<boolean> {
    await this.remember();
    if (!unreaped(this.proc)) {
      return false;
    }
    this.stopped = true;
    signalProcessGroup(this.proc.pid, "SIGTERM");
    this.killTimer = setTimeout(() => {
      this.remember()
        .then(() => {
          if (unreaped(this.proc)) {
            signalProcessGroup(this.proc.pid, "SIGKILL");
          }
        })
        .catch(() => undefined);
    }, STOP_GRACE_MS);
    return true;
  }

  /** After exit: descendants must not outlive a forced stop. */
  async finish(): Promise<void> {
    clearTimeout(this.killTimer);
    if (!this.stopped) {
      return;
    }
    const remembered = [...this.members.values()].filter(
      (member) => member.pid !== this.proc.pid
    );
    if (remembered.length === 0) {
      return;
    }
    const snapshot = await observeIdentities(
      remembered.map((member) => member.pid)
    );
    for (const member of remembered) {
      if (snapshot && identityMatches({ expected: member, snapshot })) {
        signalProcess(member.pid, "SIGKILL");
      }
    }
  }

  private async remember(): Promise<void> {
    if (!unreaped(this.proc)) {
      return;
    }
    for (const member of (await observeProcessGroup(this.proc.pid)) ?? []) {
      this.members.set(member.pid, member);
    }
  }
}

async function stopReason(opts: {
  readonly meta: CommandMeta;
  readonly paths: JournalPaths;
  readonly startedMono: number;
  readonly now: number;
  readonly stopRequested: () => boolean;
}): Promise<StopReason | null> {
  if (opts.now - opts.startedMono >= opts.meta.timeoutMs) {
    return "timed_out";
  }
  return opts.stopRequested() || (await cancelRequested(opts.paths))
    ? "cancelled"
    : null;
}

type StreamState = {
  emittedTo: number;
  size: number;
  lastEmitMono: number;
  carry: Uint8Array;
};

/**
 * Turns kernel-appended output into events. The first output of a stream is
 * announced on the next tick; later output is coalesced to one batch per
 * EMIT_INTERVAL_MS unless EMIT_EAGER_BYTES are pending. At the capture limit
 * it records `command.output_truncated` and from then on truncates the files
 * back to what was announced, so storage stays bounded while the child keeps
 * writing.
 */
export class OutputCapture {
  truncated = false;
  /** The disk or quota filled while recording events; capture stopped. */
  noSpace = false;
  private captured = 0;
  private outputEvents = 0;
  private readonly streams: Record<OutputStream, StreamState> = {
    stdout: {
      emittedTo: 0,
      size: 0,
      lastEmitMono: Number.NEGATIVE_INFINITY,
      carry: new Uint8Array(0),
    },
    stderr: {
      emittedTo: 0,
      size: 0,
      lastEmitMono: Number.NEGATIVE_INFINITY,
      carry: new Uint8Array(0),
    },
  };
  private readonly opts: {
    readonly paths: JournalPaths;
    readonly writer: JournalWriter;
    readonly full: boolean;
    readonly secrets: readonly Uint8Array[];
    readonly stall: StallTracker;
  };

  constructor(opts: OutputCapture["opts"]) {
    this.opts = opts;
  }

  async poll(final: boolean): Promise<void> {
    if (!this.opts.full) {
      return;
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const now = performance.now();
      await this.observeGrowth(stream, now);
      if (this.truncated) {
        await this.discardPastLimit(stream);
      } else if (this.shouldEmit(stream, now, final)) {
        await this.emit(stream, now, final);
      }
    }
  }

  async checkStall(nowMono: number): Promise<void> {
    const stalled = this.opts.stall.check(nowMono);
    if (stalled?.type === "command.stalled") {
      await this.record("command.stalled", {
        idleMs: stalled.idleMs,
        lastOutputAt: stalled.lastOutputAt,
      });
    }
  }

  private async observeGrowth(
    stream: OutputStream,
    now: number
  ): Promise<void> {
    const state = this.streams[stream];
    const size = await fileSize(outputPath(this.opts.paths, stream));
    if (size <= state.size) {
      return;
    }
    state.size = size;
    const resumed = this.opts.stall.activity({
      nowMono: now,
      wall: new Date().toISOString(),
      output: true,
    });
    if (resumed) {
      await this.record(resumed.type, {
        idleMs: Math.round(resumed.idleMs),
      });
    }
  }

  private shouldEmit(
    stream: OutputStream,
    now: number,
    final: boolean
  ): boolean {
    const state = this.streams[stream];
    const pending = state.size - state.emittedTo;
    // With values to redact, scan every tick: raw bytes then stay on disk for
    // at most one tick (plus a held-back prefix of a value).
    return (
      pending > 0 &&
      (final ||
        this.opts.secrets.length > 0 ||
        pending >= EMIT_EAGER_BYTES ||
        now - state.lastEmitMono >= EMIT_INTERVAL_MS)
    );
  }

  private async emit(
    stream: OutputStream,
    now: number,
    final: boolean
  ): Promise<void> {
    const state = this.streams[stream];
    let result: Awaited<ReturnType<typeof pumpStream>>;
    try {
      result = await pumpStream({
        path: outputPath(this.opts.paths, stream),
        stream,
        from: state.emittedTo,
        carry: state.carry,
        final,
        secrets: this.opts.secrets,
        captureRemaining: CAPTURE_LIMIT_BYTES - this.captured,
        eventsRemaining: OUTPUT_EVENT_LIMIT - this.outputEvents,
        redact: true,
        emit: async (range) => {
          if (!(await this.record("command.output", range))) {
            throw NO_SPACE;
          }
          // Track progress per event, so a failure later in this batch never
          // discards bytes an event already covers.
          state.emittedTo = range.offset + range.length;
        },
      });
    } catch (error: unknown) {
      // ENOSPC can also come from redacting in place: copy-on-write
      // filesystems (APFS, btrfs) allocate new blocks for an overwrite.
      if (!(error === NO_SPACE || isNoSpaceError(error))) {
        throw error;
      }
      this.noSpace = true;
      this.truncated = true;
      await this.discardPastLimit("stdout");
      await this.discardPastLimit("stderr");
      return;
    }
    state.emittedTo = result.emittedTo;
    state.carry = result.carry;
    state.lastEmitMono = now;
    this.captured += result.emittedBytes;
    this.outputEvents += result.events;
    if (result.budgetReached) {
      this.truncated = true;
      await this.record("command.output_truncated", {
        capturedBytes: this.captured,
        limitBytes: CAPTURE_LIMIT_BYTES,
      });
      await this.discardPastLimit("stdout");
      await this.discardPastLimit("stderr");
    }
  }

  /**
   * Append an event other than the final record. A full disk or quota stops
   * capture (recorded as `truncated` with `captureStopped: "no_space"` in the
   * final record) but never the command. False when nothing was written.
   */
  private async record(
    type: Parameters<JournalWriter["write"]>[0],
    payload: Record<string, unknown>
  ): Promise<boolean> {
    if (this.noSpace) {
      return false;
    }
    try {
      await this.opts.writer.write(type, payload);
      return true;
    } catch (error: unknown) {
      if (!isNoSpaceError(error)) {
        throw error;
      }
      this.noSpace = true;
      this.truncated = true;
      return false;
    }
  }

  /**
   * Output past the limit is discarded; growth past `emittedTo` on the next
   * tick is new output and still counts as activity.
   */
  private async discardPastLimit(stream: OutputStream): Promise<void> {
    const state = this.streams[stream];
    await truncateTo(outputPath(this.opts.paths, stream), state.emittedTo);
    state.size = state.emittedTo;
  }
}

export function endedPayload(opts: {
  readonly stopping: StopReason | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly truncated: boolean;
  readonly suppressed: boolean;
  readonly backend: "compose" | "native";
  readonly noSpace?: boolean;
}): Record<string, unknown> {
  let outcome: string;
  if (opts.stopping) {
    outcome = opts.stopping;
  } else {
    outcome = opts.exitCode === 0 && !opts.signal ? "succeeded" : "failed";
  }
  return {
    outcome,
    exitCode: opts.signal ? null : opts.exitCode,
    signal: opts.signal,
    truncated: opts.truncated,
    suppressed: opts.suppressed,
    ...(opts.noSpace ? { captureStopped: "no_space" } : {}),
    ...(opts.stopping
      ? {
          // The client process group was stopped; a process started inside a
          // container by `docker compose exec` is not proven stopped.
          containerProcess:
            opts.backend === "compose" ? "not_confirmed" : "not_applicable",
        }
      : {}),
  };
}

/** Redaction values from the launcher's private input (a JSON array). */
/** Null when the input is not a complete JSON array of strings. */
function parseRedactValues(text: string): string[] | null {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) &&
      value.every((item): item is string => typeof item === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

async function cancelRequested(paths: JournalPaths): Promise<boolean> {
  return (await lstat(paths.cancel).catch(() => null)) !== null;
}

async function fileSize(path: string): Promise<number> {
  return (await lstat(path).catch(() => null))?.size ?? 0;
}

/** Stop storing past the capture limit; the child keeps writing at the new end. */
async function truncateTo(path: string, length: number): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_NOFOLLOW
  ).catch(() => null);
  if (!handle) {
    return;
  }
  try {
    if ((await handle.stat()).size > length) {
      await handle.truncate(length);
    }
  } finally {
    await handle.close();
  }
}
