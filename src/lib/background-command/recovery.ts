import { lstat } from "node:fs/promises";
import { withProjectsRegistryLock } from "../projects-registry-lock.ts";
import {
  CAPTURE_LIMIT_BYTES,
  type CommandMeta,
  type EventEnvelope,
  emittedOffsets,
  endedEvent,
  type JournalPaths,
  JournalWriter,
  OUTPUT_EVENT_LIMIT,
  outputPath,
  readChild,
  readEvents,
  readOwner,
} from "./journal.ts";
import { pumpStream } from "./output-pump.ts";
import {
  identityMatches,
  type ObservedIdentity,
  observeIdentities,
  signalProcessGroup,
} from "./platform.ts";

/** How long an accepted command may go without a supervisor record. */
export const OWNER_START_GRACE_MS = 30_000;

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
      readonly childAlive: boolean;
    };

/** Seam for tests: process observation. */
export type ObserveIdentities = (
  pids: readonly number[]
) => Promise<ReadonlyMap<number, ObservedIdentity> | null>;

export async function assessOwner(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  readonly events: readonly EventEnvelope[];
  readonly now: number;
  readonly observe?: ObserveIdentities;
}): Promise<OwnerAssessment> {
  if (endedEvent(opts.events)) {
    return { kind: "ended" };
  }
  const observe = opts.observe ?? observeIdentities;
  const owner = await readOwner(opts.paths);
  if (!owner) {
    const accepted = Date.parse(opts.meta.acceptedAt);
    return opts.now - accepted < OWNER_START_GRACE_MS
      ? { kind: "starting" }
      : {
          kind: "owner_lost",
          reason: "supervisor_never_started",
          childAlive: false,
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
    childAlive: child ? identityMatches({ expected: child, snapshot }) : false,
  };
}

export function withJournalLock<T>(
  paths: JournalPaths,
  run: () => Promise<T>
): Promise<T> {
  return withProjectsRegistryLock({
    lockPath: paths.lock,
    run,
    label: "background command journal",
  });
}

/**
 * Take over a journal whose supervisor is gone. Under the journal lock, and
 * only after re-checking that the supervisor is gone and no final record
 * exists: announce output the kernel appended since the last event (marked
 * `unsupervised`, since no redaction values are available here), then, once
 * the child is gone too, write the single `command.ended` with outcome
 * `unknown`. Nothing is ever re-run. Returns the events after the attempt.
 */
export async function recoverLostOwner(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  readonly now?: () => number;
  readonly observe?: ObserveIdentities;
  /** Test seam: group signalling. */
  readonly signalGroup?: (pgid: number, signal: NodeJS.Signals) => boolean;
}): Promise<EventEnvelope[]> {
  const now = opts.now ?? Date.now;
  return await withJournalLock(opts.paths, async () => {
    const events = await readEvents(opts.paths);
    const assessment = await assessOwner({
      paths: opts.paths,
      meta: opts.meta,
      events,
      now: now(),
      observe: opts.observe,
    });
    if (assessment.kind !== "owner_lost") {
      return events;
    }
    const last = events.at(-1)?.seq ?? 0;
    const writer = new JournalWriter(opts.paths, opts.meta, last);
    const truncated = await announceUnsupervisedOutput({
      paths: opts.paths,
      meta: opts.meta,
      events,
      writer,
      final: !assessment.childAlive,
    });
    const overdue =
      assessment.childAlive &&
      now() - Date.parse(opts.meta.acceptedAt) >= opts.meta.timeoutMs;
    const childGone =
      !assessment.childAlive ||
      (overdue &&
        (await stopOverdueChild({
          paths: opts.paths,
          observe: opts.observe,
          signalGroup: opts.signalGroup,
        })));
    if (childGone) {
      await writer.write("command.ended", {
        outcome: overdue ? "timed_out" : "unknown",
        reason: assessment.reason,
        exitCode: null,
        signal: null,
        durationMs: Math.max(0, now() - Date.parse(opts.meta.acceptedAt)),
        truncated,
        suppressed: opts.meta.capture === "metadata",
      });
    }
    return await readEvents(opts.paths);
  });
}

/**
 * Announce output the kernel appended since the last event, marked
 * `unsupervised` (no redaction values exist here). Returns whether capture
 * is truncated.
 */
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
    const result = await pumpStream({
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
    captured += result.emittedBytes;
    outputEvents += result.events;
    if (result.budgetReached) {
      await opts.writer.write("command.output_truncated", {
        capturedBytes: captured,
        limitBytes: CAPTURE_LIMIT_BYTES,
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
