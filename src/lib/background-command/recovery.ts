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
    const offsets = emittedOffsets(events);
    let captured = offsets.captured;
    let outputEvents = offsets.outputEvents;
    let truncated = offsets.truncated;
    if (opts.meta.capture === "full" && !truncated) {
      for (const stream of ["stdout", "stderr"] as const) {
        const result = await pumpStream({
          path: outputPath(opts.paths, stream),
          stream,
          from: offsets[stream],
          final: !assessment.childAlive,
          secrets: [],
          captureRemaining: CAPTURE_LIMIT_BYTES - captured,
          eventsRemaining: OUTPUT_EVENT_LIMIT - outputEvents,
          redact: false,
          emit: async (range) => {
            await writer.write("command.output", {
              ...range,
              unsupervised: true,
            });
          },
        });
        captured += result.emittedBytes;
        outputEvents += result.events;
        if (result.budgetReached && !truncated) {
          truncated = true;
          await writer.write("command.output_truncated", {
            capturedBytes: captured,
            limitBytes: CAPTURE_LIMIT_BYTES,
          });
        }
      }
    }
    if (!assessment.childAlive) {
      await writer.write("command.ended", {
        outcome: "unknown",
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

export async function journalExists(paths: JournalPaths): Promise<boolean> {
  return (await lstat(paths.dir).catch(() => null))?.isDirectory() === true;
}
