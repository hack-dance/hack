import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { HackCliError } from "../cli-result.ts";
import {
  type CommandMeta,
  commandsRoot,
  type EventEnvelope,
  emittedOffsets,
  endedEvent,
  formatCursor,
  isExpired,
  type JournalPaths,
  journalPaths,
  OUTPUT_EVENT_MAX_BYTES,
  outputPath,
  outputRange,
  parseCursor,
  readChild,
  readEvents,
  readMeta,
  readOwner,
} from "./journal.ts";
import {
  assessOwner,
  journalExists,
  type ObserveIdentities,
  recoverLostOwner,
} from "./recovery.ts";
import { expiresAt } from "./store.ts";

export const DEFAULT_READ_MAX_BYTES = 32 * 1024;
export const MAX_READ_MAX_BYTES = 256 * 1024;
/** One output event always fits, so every read can make progress. */
export const MIN_READ_MAX_BYTES = OUTPUT_EVENT_MAX_BYTES;
export const DEFAULT_MCP_WAIT_MS = 25_000;
export const MAX_WAIT_MS = 30_000;
const POLL_MS = 200;

export type CommandState = "accepted" | "running" | "stalled" | "ended";

export type ProjectedEvent = Omit<EventEnvelope, "type"> & {
  readonly type: EventEnvelope["type"] | "gap";
};

export type ReadEndReason =
  | "ended"
  | "wait_elapsed"
  | "gap"
  | "budget"
  | "stalled";

export type ReadResult = {
  readonly commandId: string;
  readonly state: CommandState;
  readonly events: readonly ProjectedEvent[];
  readonly nextCursor: string;
  readonly gap: boolean;
  readonly timedOut: boolean;
  readonly ended: boolean;
  readonly endReason: ReadEndReason;
  readonly outcome?: string;
  readonly exitCode?: number | null;
};

export type LoadedJournal = {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
};

/**
 * Open a journal by id. Missing and malformed journals are "not found";
 * a tombstoned one is "expired"; a newer format is refused by readMeta.
 */
export async function loadJournal(opts: {
  readonly commandId: string;
  readonly root?: string;
}): Promise<LoadedJournal> {
  const paths = journalPaths({
    root: opts.root ?? commandsRoot(),
    commandId: opts.commandId,
  });
  if (!(await journalExists(paths))) {
    throw commandNotFound();
  }
  if (await isExpired(paths)) {
    throw new HackCliError({
      code: "E_RESULT_EXPIRED",
      message:
        "This background command's result has expired and its output was removed.",
    });
  }
  const meta = await readMeta(paths);
  if (!meta) {
    throw commandNotFound();
  }
  return { paths, meta };
}

export function commandNotFound(): HackCliError {
  return new HackCliError({
    code: "E_COMMAND_NOT_FOUND",
    message:
      "No background command with this id exists for the selected project and instance.",
  });
}

/** Events, finalizing a journal whose supervisor is provably gone. */
export async function readCurrentEvents(opts: {
  readonly journal: LoadedJournal;
  readonly observe?: ObserveIdentities;
  readonly now?: () => number;
}): Promise<EventEnvelope[]> {
  const events = await readEvents(opts.journal.paths);
  if (endedEvent(events)) {
    return events;
  }
  const assessment = await assessOwner({
    ...opts.journal,
    events,
    now: (opts.now ?? Date.now)(),
    observe: opts.observe,
  });
  return assessment.kind === "owner_lost"
    ? await recoverLostOwner({
        ...opts.journal,
        observe: opts.observe,
        now: opts.now,
      })
    : events;
}

export function stateOf(events: readonly EventEnvelope[]): CommandState {
  let state: CommandState = "accepted";
  for (const event of events) {
    switch (event.type) {
      case "command.started":
      case "command.resumed":
        state = "running";
        break;
      case "command.stalled":
        state = "stalled";
        break;
      case "command.ended":
        return "ended";
      default:
        break;
    }
  }
  return state;
}

/**
 * Text of one output range, cut exactly at its recorded bytes. Output that is
 * not valid UTF-8, or that was announced by a reader after the supervisor was
 * lost while redaction values existed, is withheld with its size.
 */
export async function projectOutput(opts: {
  readonly journal: LoadedJournal;
  readonly event: EventEnvelope;
}): Promise<{ readonly event: ProjectedEvent; readonly bytes: number }> {
  const range = outputRange(opts.event);
  if (!range) {
    return { event: opts.event, bytes: 0 };
  }
  const withheld = (
    reason: string
  ): { event: ProjectedEvent; bytes: number } => ({
    event: {
      ...opts.event,
      payload: { ...opts.event.payload, withheld: reason },
    },
    bytes: 0,
  });
  if (
    opts.event.payload.unsupervised === true &&
    opts.journal.meta.redaction.values > 0
  ) {
    return withheld("redaction_unavailable");
  }
  const handle = await open(
    outputPath(opts.journal.paths, range.stream),
    constants.O_RDONLY | constants.O_NOFOLLOW
  ).catch(() => null);
  if (!handle) {
    return withheld("unavailable");
  }
  try {
    const buffer = new Uint8Array(range.length);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      range.length,
      range.offset
    );
    if (bytesRead !== range.length) {
      return withheld("unavailable");
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      return {
        event: { ...opts.event, payload: { ...opts.event.payload, text } },
        bytes: range.length,
      };
    } catch {
      return withheld("not_utf8");
    }
  } finally {
    await handle.close();
  }
}

/**
 * Read events after a cursor, waiting up to `waitMs` for more. Returns early
 * when the command has ended, a stall starts, or the next event would pass
 * `maxBytes` of projected text. An unknown or expired cursor returns a gap
 * naming the earliest available cursor. A slow or absent reader never slows
 * the command: readers only read files.
 */
export async function readCommandEvents(opts: {
  readonly journal: LoadedJournal;
  readonly after?: string;
  readonly waitMs: number;
  readonly maxBytes: number;
  readonly observe?: ObserveIdentities;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<ReadResult> {
  const { meta } = opts.journal;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = now() + opts.waitMs;
  const cursor = (seq: number): string =>
    formatCursor({
      commandId: meta.commandId,
      generation: meta.generation,
      seq,
    });
  const start = parseAfter({ meta, after: opts.after });
  const batch: Batch = { events: [], used: 0, afterSeq: start.afterSeq };
  for (;;) {
    const events = await readCurrentEvents({
      journal: opts.journal,
      observe: opts.observe,
      now,
    });
    if (start.gap || batch.afterSeq > (events.at(-1)?.seq ?? 0)) {
      return gapResult({ meta, events, cursor });
    }
    const stop =
      (await collectEvents({
        journal: opts.journal,
        events,
        batch,
        maxBytes: opts.maxBytes,
      })) ?? (now() >= deadline ? "wait_elapsed" : null);
    if (stop) {
      return finishRead({ meta, events, batch, stop, cursor });
    }
    await sleep(Math.max(1, Math.min(POLL_MS, deadline - now())));
  }
}

type Batch = {
  readonly events: ProjectedEvent[];
  used: number;
  afterSeq: number;
};

function parseAfter(opts: {
  readonly meta: CommandMeta;
  readonly after: string | undefined;
}): { readonly afterSeq: number; readonly gap: boolean } {
  if (opts.after === undefined) {
    return { afterSeq: 0, gap: false };
  }
  const parsed = parseCursor(opts.after);
  if (!parsed || parsed.commandId !== opts.meta.commandId) {
    throw new HackCliError({
      code: "E_USAGE",
      message: "The cursor is malformed or belongs to another command.",
    });
  }
  return {
    afterSeq: parsed.seq,
    gap: parsed.generation !== opts.meta.generation,
  };
}

/**
 * Add events after `batch.afterSeq` until the byte budget, a stall or the end
 * stops the read. Returns the stop reason, or null to keep waiting.
 */
async function collectEvents(opts: {
  readonly journal: LoadedJournal;
  readonly events: readonly EventEnvelope[];
  readonly batch: Batch;
  readonly maxBytes: number;
}): Promise<ReadEndReason | null> {
  const { batch } = opts;
  for (const event of opts.events) {
    if (event.seq <= batch.afterSeq) {
      continue;
    }
    const projected =
      event.type === "command.output"
        ? await projectOutput({ journal: opts.journal, event })
        : { event, bytes: 0 };
    if (
      batch.events.length > 0 &&
      batch.used + projected.bytes > opts.maxBytes
    ) {
      return "budget";
    }
    batch.events.push(projected.event);
    batch.used += projected.bytes;
    batch.afterSeq = event.seq;
    const stop = STOPPING_EVENTS.get(event.type);
    if (stop) {
      return stop;
    }
  }
  const ended = endedEvent(opts.events);
  return ended && batch.afterSeq >= ended.seq ? "ended" : null;
}

const STOPPING_EVENTS: ReadonlyMap<string, ReadEndReason> = new Map([
  ["command.stalled", "stalled"],
  ["command.ended", "ended"],
]);

function finishRead(opts: {
  readonly meta: CommandMeta;
  readonly events: readonly EventEnvelope[];
  readonly batch: Batch;
  readonly stop: ReadEndReason;
  readonly cursor: (seq: number) => string;
}): ReadResult {
  const { batch, stop } = opts;
  const final = stop === "ended" ? endedEvent(opts.events) : null;
  const outcome = final?.payload.outcome;
  const exitCode = final?.payload.exitCode;
  return {
    commandId: opts.meta.commandId,
    state: stateOf(opts.events.filter((event) => event.seq <= batch.afterSeq)),
    events: batch.events,
    nextCursor: opts.cursor(batch.afterSeq),
    gap: false,
    timedOut: stop === "wait_elapsed",
    ended: stop === "ended",
    endReason: stop,
    ...(typeof outcome === "string" ? { outcome } : {}),
    ...(typeof exitCode === "number" || exitCode === null
      ? { exitCode: exitCode ?? null }
      : {}),
  };
}

function gapResult(opts: {
  readonly meta: CommandMeta;
  readonly events: readonly EventEnvelope[];
  readonly cursor: (seq: number) => string;
}): ReadResult {
  const earliest = opts.cursor(0);
  const gapEvent: ProjectedEvent = {
    v: 1,
    id: `${opts.meta.commandId}.${opts.meta.generation}.gap`,
    seq: 0,
    cursor: earliest,
    time: new Date().toISOString(),
    projectId: opts.meta.projectId,
    instanceId: opts.meta.instanceId,
    commandId: opts.meta.commandId,
    service: opts.meta.service,
    type: "gap",
    payload: { reason: "E_CURSOR_EXPIRED", earliestCursor: earliest },
  };
  return {
    commandId: opts.meta.commandId,
    state: stateOf(opts.events),
    events: [gapEvent],
    nextCursor: earliest,
    gap: true,
    timedOut: false,
    ended: false,
    endReason: "gap",
  };
}

/** Value-free description of a command: metadata, state and identities. */
export async function inspectCommand(opts: {
  readonly journal: LoadedJournal;
  readonly observe?: ObserveIdentities;
}): Promise<Record<string, unknown>> {
  const { meta, paths } = opts.journal;
  const events = await readCurrentEvents(opts);
  const ended = endedEvent(events);
  const offsets = emittedOffsets(events);
  const owner = await readOwner(paths);
  const child = await readChild(paths);
  const stalled = events.filter(
    (event) => event.type === "command.stalled"
  ).length;
  return {
    commandId: meta.commandId,
    state: stateOf(events),
    operation: meta.operation,
    backend: meta.backend,
    projectId: meta.projectId,
    instanceId: meta.instanceId,
    service: meta.service,
    argv: meta.argv,
    workdir: meta.workdir,
    acceptedAt: meta.acceptedAt,
    startedAt:
      events.find((event) => event.type === "command.started")?.time ?? null,
    endedAt: ended?.time ?? null,
    expiresAt: expiresAt(meta),
    writerVersion: meta.writerVersion,
    formatVersion: meta.formatVersion,
    limits: {
      timeoutMs: meta.timeoutMs,
      stallAfterMs: meta.stallAfterMs,
      retentionMs: meta.retentionMs,
    },
    capture: meta.capture,
    liveOutput: meta.liveOutput,
    stallDetection: meta.stallDetection,
    redaction: { values: meta.redaction.values, partial: true },
    output: {
      stdoutBytes: offsets.stdout,
      stderrBytes: offsets.stderr,
      capturedBytes: offsets.captured,
      truncated: offsets.truncated,
    },
    stalls: stalled,
    supervisor: owner
      ? {
          pid: owner.pid,
          processGroupId: owner.processGroupId,
          newSession: owner.newSession,
        }
      : null,
    child: child
      ? { pid: child.pid, processGroupId: child.processGroupId }
      : null,
    latestCursor: events.at(-1)?.cursor ?? null,
    earliestCursor: formatCursor({
      commandId: meta.commandId,
      generation: meta.generation,
      seq: 0,
    }),
    ...(ended ? { ended: ended.payload } : {}),
  };
}
