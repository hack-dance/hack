import { closeSync, constants, openSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  ProjectsRegistryLockTimeoutError,
  withProjectsRegistryLock,
} from "../projects-registry-lock.ts";
import { auditEnd } from "./audit.ts";
import {
  type AppendLine,
  CAPTURE_LIMIT_BYTES,
  type CommandMeta,
  type EventEnvelope,
  emittedOffsets,
  endedEvent,
  isExpired,
  type JournalPaths,
  JournalWriter,
  OUTPUT_EVENT_LIMIT,
  outputPath,
  readChild,
  readEvents,
  readOwner,
  reconcileTail,
  type TailIo,
} from "./journal.ts";
import { pumpStream } from "./output-pump.ts";
import {
  fileLocksAvailable,
  identityMatches,
  type ObservedIdentity,
  observeIdentities,
  readBootTimeMs,
  releaseFileLock,
  signalProcessGroup,
  tryExclusiveFileLock,
} from "./platform.ts";

/** How long an accepted command may go without a supervisor record. */
export const OWNER_START_GRACE_MS = 30_000;

/**
 * What is known about the command's own process.
 * - `alive`: a process with the recorded pid and birth exists.
 * - `gone`: confirmed absent: its recorded identity no longer matches, it
 *   was never spawned (no spawn marker), it was reaped before it could be
 *   observed, or the machine booted after the command was accepted.
 * - `unknown`: it may exist but its identity was never recorded (the
 *   supervisor died between spawn and record, or `ps` could not observe it).
 *   Unknown is never treated as absence: no final record frees admission and
 *   retention does not remove its files.
 */
export type ChildState = "alive" | "gone" | "unknown";

export type OwnerAssessment =
  | { readonly kind: "ended" }
  /** Supervisor alive (pid and birth match). */
  | { readonly kind: "alive" }
  /** Accepted recently; the supervisor has not recorded itself yet. */
  | { readonly kind: "starting" }
  /** `ps` was unavailable: no conclusion, nothing is written. */
  | { readonly kind: "indeterminate" }
  | {
      readonly kind: "owner_lost";
      readonly reason: "supervisor_lost" | "supervisor_never_started";
      readonly child: ChildState;
    };

/** Seam for tests: process observation. */
export type ObserveIdentities = (
  pids: readonly number[]
) => Promise<ReadonlyMap<number, ObservedIdentity> | null>;

/** Seam for tests: last boot time in ms, or null when unknown. */
export type ReadBootTime = () => Promise<number | null>;

const BOOT_EVIDENCE_MARGIN_MS = 60_000;

/** Child birth values that are not a `ps` start time. */
export const CHILD_BIRTH_UNOBSERVED = "unobserved";
export const CHILD_BIRTH_EXITED = "exited-before-observation";

/** Classify the command's process from its records and a `ps` snapshot. */
export async function childState(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  readonly snapshot: ReadonlyMap<number, ObservedIdentity>;
  readonly readBootTime?: ReadBootTime;
}): Promise<ChildState> {
  const child = await readChild(opts.paths);
  if (child?.birth === CHILD_BIRTH_EXITED) {
    return "gone";
  }
  if (child && child.birth !== CHILD_BIRTH_UNOBSERVED) {
    return identityMatches({ expected: child, snapshot: opts.snapshot })
      ? "alive"
      : "gone";
  }
  const spawned =
    child !== null ||
    (await lstat(opts.paths.spawning).catch(() => null)) !== null;
  if (!spawned) {
    return "gone";
  }
  const booted = await (opts.readBootTime ?? readBootTimeMs)();
  // Boot time is wall clock minus uptime and moves when the clock is
  // stepped; a margin keeps an early-boot correction from misreading it.
  return booted !== null &&
    booted > Date.parse(opts.meta.acceptedAt) + BOOT_EVIDENCE_MARGIN_MS
    ? "gone"
    : "unknown";
}

export async function assessOwner(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  readonly events: readonly EventEnvelope[];
  readonly now: number;
  readonly observe?: ObserveIdentities;
  readonly readBootTime?: ReadBootTime;
}): Promise<OwnerAssessment> {
  if (endedEvent(opts.events)) {
    return { kind: "ended" };
  }
  const observe = opts.observe ?? observeIdentities;
  const owner = await readOwner(opts.paths);
  if (!owner) {
    const accepted = Date.parse(opts.meta.acceptedAt);
    // The owner record is written before the spawn marker, so without it
    // nothing was spawned.
    return opts.now - accepted < OWNER_START_GRACE_MS
      ? { kind: "starting" }
      : {
          kind: "owner_lost",
          reason: "supervisor_never_started",
          child: "gone",
        };
  }
  const child = await readChild(opts.paths);
  const snapshot = await observe([owner.pid, ...(child ? [child.pid] : [])]);
  if (!snapshot) {
    return { kind: "indeterminate" };
  }
  if (identityMatches({ expected: owner, snapshot })) {
    return { kind: "alive" };
  }
  return {
    kind: "owner_lost",
    reason: "supervisor_lost",
    child: await childState({ ...opts, snapshot }),
  };
}

const JOURNAL_LOCK_WAIT_MS = 10_000;

/**
 * The journal lock: an exclusive flock(2) on the journal's `lock` file,
 * which acceptance creates empty. Taking it allocates nothing, so a full
 * disk or quota never forces the final record's reserved bytes to be spent
 * on locking, and the kernel releases it when its holder dies. Only the
 * writer of `command.ended` releases the reserve, under this lock, so two
 * recoveries cannot spend it twice. Without libc the file-based registry
 * lock is used instead (every process on the host makes the same choice). It
 * publishes an owner receipt, so it uses its own path: the empty `lock` file
 * acceptance created would read as an unreclaimable foreign owner. Writing
 * that receipt needs space, so in this fallback a full disk or quota can
 * block recovery until space is freed; only flock locking needs none.
 */
export async function withJournalLock<T>(
  paths: JournalPaths,
  run: () => Promise<T>,
  /** Test seam: force the file-based fallback. */
  opts: { readonly fileLocks?: boolean } = {}
): Promise<T> {
  if (!(opts.fileLocks ?? fileLocksAvailable())) {
    return await withProjectsRegistryLock({
      lockPath: paths.fallbackLock,
      run,
      label: "background command journal",
    });
  }
  // O_CREAT is a no-op for a journal created with its lock file; an older
  // or damaged journal gets one created here (which can need space).
  const fd = openSync(
    paths.lock,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const started = performance.now();
    while (!tryExclusiveFileLock(fd)) {
      if (performance.now() - started >= JOURNAL_LOCK_WAIT_MS) {
        throw new ProjectsRegistryLockTimeoutError(
          "Timed out waiting for background command journal lock"
        );
      }
      await Bun.sleep(25 + Math.random() * 75);
    }
    try {
      return await run();
    } finally {
      releaseFileLock(fd);
    }
  } finally {
    closeSync(fd);
  }
}

export function isNoSpaceError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOSPC" || error.code === "EDQUOT")
  );
}

/**
 * Take over a journal whose supervisor is gone. Under the journal lock, and
 * only after re-checking that the supervisor is gone and no final record
 * exists: make the tail whole, announce output the kernel appended since the
 * last event (marked `unsupervised`, since no redaction values are available
 * here), then, once the child is confirmed gone, write the single
 * `command.ended` with outcome `unknown`. While the child's ownership is
 * unknown nothing final is written. A full disk stops announcing output
 * but never the final record. Nothing is ever re-run.
 */
export async function recoverLostOwner(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  readonly now?: () => number;
  readonly observe?: ObserveIdentities;
  readonly readBootTime?: ReadBootTime;
  /** Test seam: group signalling. */
  readonly signalGroup?: (pgid: number, signal: NodeJS.Signals) => boolean;
  /** Test seams: journal append, tail repair write and lock. */
  readonly append?: AppendLine;
  readonly tailIo?: Partial<TailIo>;
  readonly lock?: typeof withJournalLock;
  /**
   * Stop a verified orphan that ran past its timeout. Only the start path
   * (admission) sets this; reads never signal processes.
   */
  readonly enforceTimeout?: boolean;
}): Promise<EventEnvelope[]> {
  return await (opts.lock ?? withJournalLock)(opts.paths, async () =>
    // A journal expired since the caller looked is never finalized again:
    // its tombstone (and any admission hold in it) is the record.
    (await isExpired(opts.paths)) ? [] : await recoverLocked(opts)
  );
}

/** `recoverLostOwner` under the journal lock. */
async function recoverLocked(
  opts: Parameters<typeof recoverLostOwner>[0]
): Promise<EventEnvelope[]> {
  const now = opts.now ?? Date.now;
  // Read only until the supervisor is proven gone: it may be mid-write.
  const observed = await readEvents(opts.paths);
  const assessment = await assessOwner({
    ...opts,
    events: observed,
    now: now(),
  });
  if (assessment.kind !== "owner_lost") {
    return observed;
  }
  const events = await reconcileTail(opts.paths, opts.tailIo);
  if (endedEvent(events)) {
    return events;
  }
  const writer = new JournalWriter(
    opts.paths,
    opts.meta,
    events.at(-1)?.seq ?? 0,
    opts.append
  );
  // Before anything else: output the supervisor never scanned is dropped
  // from disk when it had values to redact (they are not available here),
  // otherwise announced. On a full disk announcing stops (ENOSPC is caught
  // there); the reserve stays untouched for the final record.
  const truncated = await takeOverOutput({
    paths: opts.paths,
    meta: opts.meta,
    events,
    writer,
    final: assessment.child === "gone",
  });
  const overdue =
    opts.enforceTimeout === true &&
    assessment.child === "alive" &&
    now() - Date.parse(opts.meta.acceptedAt) >= opts.meta.timeoutMs;
  const childGone =
    assessment.child === "gone" ||
    (overdue &&
      (await stopOverdueChild({
        paths: opts.paths,
        observe: opts.observe,
        signalGroup: opts.signalGroup,
      })));
  if (!childGone) {
    return await readEvents(opts.paths);
  }
  const finalTruncated = overdue
    ? (await takeOverOutput({
        paths: opts.paths,
        meta: opts.meta,
        events: await readEvents(opts.paths),
        writer,
        final: true,
      })) || truncated
    : truncated;
  const ended = await writer.write("command.ended", {
    outcome: overdue ? "timed_out" : "unknown",
    reason: overdue ? "orphan_timeout" : assessment.reason,
    exitCode: null,
    signal: null,
    durationMs: Math.max(0, now() - Date.parse(opts.meta.acceptedAt)),
    truncated: finalTruncated,
    suppressed: opts.meta.capture === "metadata",
    containerProcess: await recoveredContainerProcess(opts),
  });
  await auditEnd({
    paths: opts.paths,
    meta: opts.meta,
    payload: ended.payload,
  });
  return await readEvents(opts.paths);
}

/**
 * A lost owner never stopped anything in the container or guest (Compose or
 * native): the container process is `not_confirmed` (which keeps the
 * admission slot until the timeout window closes) unless no child was ever
 * spawned.
 */
async function recoveredContainerProcess(opts: {
  readonly paths: JournalPaths;
}): Promise<"not_confirmed" | "not_applicable"> {
  const spawned =
    (await readChild(opts.paths)) !== null ||
    (await lstat(opts.paths.spawning).catch(() => null)) !== null;
  return spawned ? "not_confirmed" : "not_applicable";
}

/**
 * Announce output the kernel appended since the last event, marked
 * `unsupervised` (no redaction values exist here). Returns whether capture
 * is truncated.
 */
/**
 * Output that landed after the supervisor was lost. Without the redaction
 * values (only the supervisor ever held them, over a pipe), a command that
 * had values to redact cannot have that output stored safely: each stream
 * file is cut back to the bytes the supervisor had scanned and announced,
 * and one `command.output_truncated` with `reason: "redaction_unavailable"`
 * marks it. A command still running keeps appending, so every takeover cuts
 * again. With no values to redact the output is announced, marked
 * `unsupervised`. Returns whether capture is now truncated.
 */
async function takeOverOutput(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  readonly events: readonly EventEnvelope[];
  readonly writer: JournalWriter;
  readonly final: boolean;
}): Promise<boolean> {
  if (!needsAtRestScrub(opts.meta)) {
    return await announceUnsupervisedOutput(opts);
  }
  const dropped = await dropUnscannedOutput({
    paths: opts.paths,
    events: opts.events,
  });
  const marked = opts.events.some(
    (event) =>
      event.type === "command.output_truncated" &&
      event.payload.reason === "redaction_unavailable"
  );
  if (dropped && !marked) {
    await opts.writer
      .write("command.output_truncated", {
        reason: "redaction_unavailable",
        capturedBytes: emittedOffsets(opts.events).captured,
        limitBytes: CAPTURE_LIMIT_BYTES,
      })
      .catch((error: unknown) => {
        // The cut already freed space; a full disk only loses the marker.
        if (!isNoSpaceError(error)) {
          throw error;
        }
      });
  }
  return dropped || marked || emittedOffsets(opts.events).truncated;
}

/** Full capture with values to redact: unscanned output must not stay on disk. */
export function needsAtRestScrub(meta: CommandMeta): boolean {
  return meta.capture === "full" && meta.redaction.values > 0;
}

/**
 * Cut each stream file back to the bytes covered by output events (which
 * the supervisor redacted before announcing them). Returns whether anything
 * was dropped. Cutting allocates nothing, so it works on a full disk.
 */
export async function dropUnscannedOutput(opts: {
  readonly paths: JournalPaths;
  readonly events: readonly EventEnvelope[];
}): Promise<boolean> {
  const offsets = emittedOffsets(opts.events);
  let dropped = false;
  for (const stream of ["stdout", "stderr"] as const) {
    const handle = await open(
      outputPath(opts.paths, stream),
      constants.O_WRONLY | constants.O_NOFOLLOW
    ).catch(() => null);
    if (!handle) {
      continue;
    }
    try {
      if ((await handle.stat()).size > offsets[stream]) {
        await handle.truncate(offsets[stream]);
        dropped = true;
      }
    } finally {
      await handle.close();
    }
  }
  return dropped;
}

async function announceUnsupervisedOutput(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  readonly events: readonly EventEnvelope[];
  readonly writer: JournalWriter;
  readonly final: boolean;
}): Promise<boolean> {
  const offsets = emittedOffsets(opts.events);
  let captured = offsets.captured;
  let outputEvents = offsets.outputEvents;
  if (opts.meta.capture !== "full" || offsets.truncated) {
    return offsets.truncated;
  }
  for (const stream of ["stdout", "stderr"] as const) {
    let result: Awaited<ReturnType<typeof pumpStream>>;
    try {
      result = await pumpStream({
        path: outputPath(opts.paths, stream),
        stream,
        from: offsets[stream],
        final: opts.final,
        secrets: [],
        captureRemaining: CAPTURE_LIMIT_BYTES - captured,
        eventsRemaining: OUTPUT_EVENT_LIMIT - outputEvents,
        redact: false,
        emit: async (range) => {
          await opts.writer.write("command.output", {
            ...range,
            unsupervised: true,
          });
        },
      });
    } catch (error: unknown) {
      // A full disk stops announcing output; the final record still gets
      // the reserved bytes.
      if (isNoSpaceError(error)) {
        return true;
      }
      throw error;
    }
    captured += result.emittedBytes;
    outputEvents += result.events;
    if (result.budgetReached) {
      await opts.writer
        .write("command.output_truncated", {
          capturedBytes: captured,
          limitBytes: CAPTURE_LIMIT_BYTES,
        })
        .catch((error: unknown) => {
          if (!isNoSpaceError(error)) {
            throw error;
          }
        });
      return true;
    }
  }
  return false;
}

/**
 * The supervisor is gone and the command ran past its timeout: nobody else
 * will enforce it. SIGKILL the child's process group only if its pid, birth
 * and group still match, then confirm it is gone.
 */
async function stopOverdueChild(opts: {
  readonly paths: JournalPaths;
  readonly observe?: ObserveIdentities;
  readonly signalGroup?: (pgid: number, signal: NodeJS.Signals) => boolean;
}): Promise<boolean> {
  const observe = opts.observe ?? observeIdentities;
  const child = await readChild(opts.paths);
  if (!child) {
    return false;
  }
  const snapshot = await observe([child.pid]);
  const row = snapshot?.get(child.pid);
  if (
    !(
      row &&
      row.birth === child.birth &&
      row.processGroupId === child.processGroupId
    )
  ) {
    return snapshot !== null && !row;
  }
  (opts.signalGroup ?? signalProcessGroup)(child.processGroupId, "SIGKILL");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const after = await observe([child.pid]);
    if (after && !identityMatches({ expected: child, snapshot: after })) {
      return true;
    }
    await Bun.sleep(100);
  }
  return false;
}

export async function journalExists(paths: JournalPaths): Promise<boolean> {
  return (await lstat(paths.dir).catch(() => null))?.isDirectory() === true;
}
