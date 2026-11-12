import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import pkg from "../../../package.json";
import { HackCliError } from "../cli-result.ts";
import { resolveGlobalHackDir } from "../config-paths.ts";
import { isRecord } from "../guards.ts";
import { readReplaceablePrivateFile } from "../private-file.ts";

/**
 * On-disk journal of one background command.
 *
 * Layout, under `<hack home>/commands/<commandId>/` (directory 0700, files
 * 0600; never under a project's `.hack/`, which may be committed or synced):
 *
 * - `meta.json`: immutable request metadata written at acceptance. It never
 *   holds environment values.
 * - `launch.json`: the child argv and cwd, read once by the supervisor.
 * - `owner.json`, `child.json`: supervisor and child identity (pid, birth,
 *   process group), written by the supervisor. `spawning.json` is written just
 *   before the child is spawned: with it and no usable `child.json`, a child
 *   may exist whose identity is unknown ("ownership unknown").
 * - `events.jsonl`: one envelope per line, dense `seq` from 1.
 * - `stdout`, `stderr`: the child's output, appended by the kernel.
 * - `reserve`: preallocated bytes released only to write `command.ended`.
 * - `cancel.json`: a cancel request, written before any signal is sent.
 * - `expired.json`: tombstone left when retention removed the output.
 * - `lock`: empty file, flocked as the journal lock. `lock.owner` is the
 *   owner receipt of the file-based fallback used when flock is unavailable.
 *
 * Writers: the launcher writes `command.accepted` (seq 1) before the
 * supervisor exists; the live supervisor is then the only writer. Any other
 * process (a reader or a canceller) appends only under the journal lock and
 * only after verifying, by pid and birth, that the supervisor is gone.
 */

export const JOURNAL_FORMAT_VERSION = 1;
export const HACK_VERSION: string = (pkg as { readonly version: string })
  .version;
export const RESERVE_BYTES = 64 * 1024;
/** Capture limit per command, stdout and stderr together. */
export const CAPTURE_LIMIT_BYTES = 8 * 1024 * 1024;
/**
 * Output not yet scanned beyond which capture counts as fallen behind: it
 * stops (recorded as `truncated`) and the files are cut back on every poll,
 * so disk use stays bounded while the command keeps running. Never a limit
 * on the command itself.
 */
export const CAPTURE_BACKLOG_LIMIT_BYTES = 64 * 1024 * 1024;
/** Largest byte range one output event covers. */
export const OUTPUT_EVENT_MAX_BYTES = 16 * 1024;
/** Largest `meta.json` or `launch.json` a reader accepts (and a start may write). */
export const JOURNAL_RECORD_MAX_BYTES = 1024 * 1024;
/** Output events per command; past this capture stops as if the byte limit were hit. */
export const OUTPUT_EVENT_LIMIT = 65_536;

const COMMAND_ID_PATTERN = /^cmd_[a-z0-9]{26}$/;
const GENERATION_PATTERN = /^[a-z0-9]{8}$/;
const SEQ_PATTERN = /^\d{1,12}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const OUTCOMES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "unknown",
] as const;
export type CommandOutcome = (typeof OUTCOMES)[number];

export const EVENT_TYPES = [
  "command.accepted",
  "command.started",
  "command.output",
  "command.stalled",
  "command.resumed",
  "command.output_truncated",
  "command.ended",
] as const;
export type StoredEventType = (typeof EVENT_TYPES)[number];

export type CommandOperation = "exec" | "run";
export type CaptureMode = "full" | "metadata";

const metaSchema = z.object({
  formatVersion: z.number().int().positive(),
  writerVersion: z.string(),
  commandId: z.string().regex(COMMAND_ID_PATTERN),
  generation: z.string().regex(GENERATION_PATTERN),
  requestKey: z.string().nullable(),
  fingerprint: z.string(),
  operation: z.enum(["exec", "run"]),
  backend: z.enum(["compose", "native"]),
  projectId: z.string(),
  projectRoot: z.string(),
  instanceId: z.string(),
  service: z.string(),
  argv: z.array(z.string()),
  workdir: z.string().nullable(),
  caller: z.string(),
  acceptedAt: z.string(),
  timeoutMs: z.number().int().positive(),
  stallAfterMs: z.number().int().nonnegative(),
  capture: z.enum(["full", "metadata"]),
  retentionMs: z.number().int().nonnegative(),
  liveOutput: z.enum(["available", "unavailable"]),
  stallDetection: z.enum(["available", "unavailable"]),
  redaction: z.object({ values: z.number().int().nonnegative() }),
});
export type CommandMeta = z.infer<typeof metaSchema>;

const identitySchema = z.object({
  pid: z.number().int().positive(),
  birth: z.string().min(1),
  processGroupId: z.number().int().positive(),
});
const ownerSchema = identitySchema.extend({
  sessionId: z.number().int().positive().nullable(),
  newSession: z.boolean(),
});
export type OwnerRecord = z.infer<typeof ownerSchema>;
export type ChildRecord = z.infer<typeof identitySchema>;

const launchSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string(),
  /**
   * A background `run`'s named one-off container: removed by the supervisor
   * when it stops the command, after checking these labels.
   */
  container: z
    .object({
      name: z.string().regex(/^hack-bg-[a-z0-9]{20}$/),
      service: z.string(),
    })
    .optional(),
  /**
   * A background `exec`'s process in the container carries
   * `HACK_BACKGROUND_COMMAND=<marker>`; `compose` is the `docker compose`
   * prefix (project, files, profiles) used to stop it.
   */
  guest: z
    .object({
      marker: z.string().regex(/^[a-z0-9]{20}$/),
      service: z.string(),
      compose: z.array(z.string()).min(2),
    })
    .optional(),
  /**
   * The Docker engine selection resolved at start (an absolute
   * DOCKER_CONFIG, and the context name, `default` included). The command's
   * client and cleanup both run with it, so they talk to the same engine
   * even if a relative path or the current context would now resolve
   * differently. Absent in journals from before it existed.
   */
  docker: z
    .object({
      config: z.string().optional(),
      context: z.string().optional(),
    })
    .optional(),
});
export type LaunchRecord = z.infer<typeof launchSchema>;

const envelopeSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  seq: z.number().int().positive(),
  cursor: z.string(),
  time: z.string(),
  projectId: z.string(),
  instanceId: z.string(),
  commandId: z.string(),
  service: z.string(),
  type: z.enum(EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof envelopeSchema>;

export type OutputStream = "stdout" | "stderr";

export function commandsRoot(): string {
  return resolve(resolveGlobalHackDir(), "commands");
}

export function isCommandId(value: string): boolean {
  return COMMAND_ID_PATTERN.test(value);
}

function randomToken(length: number): string {
  const bytes = randomBytes(length);
  let token = "";
  for (const byte of bytes) {
    token += ALPHABET[byte % ALPHABET.length];
  }
  return token;
}

export function newCommandId(): string {
  return `cmd_${randomToken(26)}`;
}

export function newGeneration(): string {
  return randomToken(8);
}

export type JournalPaths = {
  readonly dir: string;
  readonly meta: string;
  readonly launch: string;
  readonly owner: string;
  readonly child: string;
  readonly spawning: string;
  readonly stopping: string;
  /** Native only: created by the `hack` child once the guest exit code is known. */
  readonly exitConfirmed: string;
  readonly events: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly reserve: string;
  readonly cancel: string;
  readonly expired: string;
  readonly lock: string;
  /** Owner receipt of the file-based lock used when flock is unavailable. */
  readonly fallbackLock: string;
};

export function journalPaths(opts: {
  readonly root: string;
  readonly commandId: string;
}): JournalPaths {
  if (!isCommandId(opts.commandId)) {
    throw new HackCliError({
      code: "E_USAGE",
      message: "Invalid command id.",
    });
  }
  const dir = resolve(opts.root, opts.commandId);
  return {
    dir,
    meta: resolve(dir, "meta.json"),
    launch: resolve(dir, "launch.json"),
    owner: resolve(dir, "owner.json"),
    child: resolve(dir, "child.json"),
    spawning: resolve(dir, "spawning.json"),
    stopping: resolve(dir, "stopping"),
    exitConfirmed: resolve(dir, "exit-confirmed"),
    events: resolve(dir, "events.jsonl"),
    stdout: resolve(dir, "stdout"),
    stderr: resolve(dir, "stderr"),
    reserve: resolve(dir, "reserve"),
    cancel: resolve(dir, "cancel.json"),
    expired: resolve(dir, "expired.json"),
    lock: resolve(dir, "lock"),
    fallbackLock: resolve(dir, "lock.owner"),
  };
}

export function outputPath(paths: JournalPaths, stream: OutputStream): string {
  return stream === "stdout" ? paths.stdout : paths.stderr;
}

// --- Cursors --------------------------------------------------------------

/** `<commandId>:<generation>:<seq>`; seq 0 means "before the first event". */
export function formatCursor(opts: {
  readonly commandId: string;
  readonly generation: string;
  readonly seq: number;
}): string {
  return `${opts.commandId}:${opts.generation}:${opts.seq}`;
}

export type ParsedCursor = {
  readonly commandId: string;
  readonly generation: string;
  readonly seq: number;
};

export function parseCursor(value: string): ParsedCursor | null {
  const parts = value.split(":");
  if (parts.length !== 3) {
    return null;
  }
  const [commandId = "", generation = "", seqText = ""] = parts;
  if (
    !(
      isCommandId(commandId) &&
      GENERATION_PATTERN.test(generation) &&
      SEQ_PATTERN.test(seqText)
    )
  ) {
    return null;
  }
  return { commandId, generation, seq: Number(seqText) };
}

// --- Private JSON records ----------------------------------------------------

function journalRefusal(): Error {
  return new HackCliError({
    code: "E_PERMISSION",
    message:
      "A background command record is not a private regular file; it was not read.",
  });
}

async function readPrivateJson(opts: {
  readonly path: string;
  readonly dir: string;
}): Promise<unknown> {
  const file = await readReplaceablePrivateFile({
    path: opts.path,
    directories: [opts.dir],
    refusal: journalRefusal,
    maxBytes: JOURNAL_RECORD_MAX_BYTES,
  });
  if (!file) {
    return null;
  }
  try {
    return JSON.parse(file.text);
  } catch {
    return null;
  }
}

/** Refuse a journal written by a newer format, naming the writer's version. */
function assertSupportedFormat(value: unknown): void {
  if (
    isRecord(value) &&
    typeof value.formatVersion === "number" &&
    value.formatVersion > JOURNAL_FORMAT_VERSION
  ) {
    const writer =
      typeof value.writerVersion === "string" ? value.writerVersion : "newer";
    throw new HackCliError({
      code: "E_JOURNAL_VERSION",
      message: `This background command was recorded by Hack ${writer} in journal format ${value.formatVersion}; this Hack (${HACK_VERSION}) reads format ${JOURNAL_FORMAT_VERSION}. Use the newer Hack to read it.`,
    });
  }
}

export async function readMeta(
  paths: JournalPaths
): Promise<CommandMeta | null> {
  const value = await readPrivateJson({ path: paths.meta, dir: paths.dir });
  if (value === null) {
    return null;
  }
  assertSupportedFormat(value);
  const parsed = metaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function readOwner(
  paths: JournalPaths
): Promise<OwnerRecord | null> {
  const parsed = ownerSchema.safeParse(
    await readPrivateJson({ path: paths.owner, dir: paths.dir })
  );
  return parsed.success ? parsed.data : null;
}

export async function readChild(
  paths: JournalPaths
): Promise<ChildRecord | null> {
  const parsed = identitySchema.safeParse(
    await readPrivateJson({ path: paths.child, dir: paths.dir })
  );
  return parsed.success ? parsed.data : null;
}

export async function readLaunch(
  paths: JournalPaths
): Promise<LaunchRecord | null> {
  const parsed = launchSchema.safeParse(
    await readPrivateJson({ path: paths.launch, dir: paths.dir })
  );
  return parsed.success ? parsed.data : null;
}

export async function isExpired(paths: JournalPaths): Promise<boolean> {
  return (await lstat(paths.expired).catch(() => null)) !== null;
}

// --- Events ------------------------------------------------------------------

/** Parse complete lines only; an unterminated final line is a write in progress. */
export function parseEventLines(text: string): EventEnvelope[] {
  const end = text.lastIndexOf("\n");
  if (end < 0) {
    return [];
  }
  const events: EventEnvelope[] = [];
  for (const line of text.slice(0, end).split("\n")) {
    if (line.length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = envelopeSchema.safeParse(value);
    if (parsed.success) {
      events.push(parsed.data);
    }
  }
  return events;
}

export async function readEvents(
  paths: JournalPaths
): Promise<EventEnvelope[]> {
  const text = await readFile(paths.events, "utf8").catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return parseEventLines(text);
}

export function buildEnvelope(opts: {
  readonly meta: CommandMeta;
  readonly seq: number;
  readonly type: StoredEventType;
  readonly payload: Record<string, unknown>;
  readonly time?: Date;
}): EventEnvelope {
  return {
    v: 1,
    id: `${opts.meta.commandId}.${opts.meta.generation}.${opts.seq}`,
    seq: opts.seq,
    cursor: formatCursor({
      commandId: opts.meta.commandId,
      generation: opts.meta.generation,
      seq: opts.seq,
    }),
    time: (opts.time ?? new Date()).toISOString(),
    projectId: opts.meta.projectId,
    instanceId: opts.meta.instanceId,
    commandId: opts.meta.commandId,
    service: opts.meta.service,
    type: opts.type,
    payload: opts.payload,
  };
}

function isNoSpace(error: unknown): boolean {
  return (
    isRecord(error) && (error.code === "ENOSPC" || error.code === "EDQUOT")
  );
}

/** Seam for tests: the append primitive. */
export type AppendLine = (path: string, line: string) => Promise<void>;

/**
 * Append one line with a single O_APPEND write. A short write (a nearly full
 * disk or quota reports fewer bytes instead of failing) is cut back to the
 * previous end and reported as ENOSPC, so no torn line stays behind. A line
 * torn by an earlier crash is closed with a newline first, so it cannot merge
 * with this one; readers already ignore the fragment.
 */
export const appendLine: AppendLine = async (path, line) => {
  const handle = await open(
    path,
    constants.O_RDWR |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    const before = (await handle.stat()).size;
    let prefix = "";
    if (before > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, before - 1);
      prefix = last[0] === 0x0a ? "" : "\n";
    }
    const bytes = Buffer.from(`${prefix}${line}`, "utf8");
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length);
    if (bytesWritten !== bytes.length) {
      await handle.truncate(before).catch(() => undefined);
      throw Object.assign(new Error("Short write to the command journal."), {
        code: "ENOSPC",
      });
    }
  } finally {
    await handle.close();
  }
};

/** Seams for tests: the tail repair's positioned write and its fsync. */
export type TailIo = {
  /** A positioned write; returns the bytes written. */
  readonly writeAt: (
    handle: FileHandle,
    bytes: Buffer,
    position: number
  ) => Promise<number>;
  readonly sync: (handle: FileHandle) => Promise<void>;
};

const defaultTailIo: TailIo = {
  writeAt: async (handle, bytes, position) =>
    (await handle.write(bytes, 0, bytes.length, position)).bytesWritten,
  sync: async (handle) => await handle.sync(),
};

/**
 * Make the journal's tail whole before a writer other than the live
 * supervisor appends (call it under the journal lock, with the supervisor
 * gone or not yet started). A crash can leave bytes after the last newline:
 * a complete envelope that is exactly the next sequence number is committed
 * by adding its newline; anything else is cut off. Readers never treated
 * those bytes as an event, so the sequence stays dense and a second
 * `command.ended` cannot appear. On a full disk a final tail record is
 * committed from the reserve and any other tail record is cut, so the repair
 * never needs space the final record does not own. Returns the committed
 * events.
 */
export async function reconcileTail(
  paths: JournalPaths,
  seams: Partial<TailIo> = {}
): Promise<EventEnvelope[]> {
  const io: TailIo = { ...defaultTailIo, ...seams };
  const handle = await open(
    paths.events,
    constants.O_RDWR | constants.O_NOFOLLOW
  ).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!handle) {
    return [];
  }
  try {
    const bytes = await handle.readFile();
    const lastNewline = bytes.lastIndexOf(0x0a);
    const committedLength = lastNewline + 1;
    const committed = parseEventLines(
      bytes.subarray(0, committedLength).toString("utf8")
    );
    if (committedLength === bytes.length) {
      return committed;
    }
    const tail = bytes.subarray(committedLength).toString("utf8");
    const next = parseEnvelope(tail);
    if (
      next &&
      next.seq === (committed.at(-1)?.seq ?? 0) + 1 &&
      (await commitNewline({ handle, paths, at: bytes.length, next, io })) &&
      // Some filesystems report a full disk only at fsync: then the record
      // is not known to be durable and is cut like any other.
      (await syncUnlessNoSpace(handle, io))
    ) {
      return [...committed, next];
    }
    // Not the next record, or no space to commit it: cutting it allocates
    // nothing, and readers never counted it. Its fsync is best effort on a
    // full disk, since nothing new needs to persist.
    await handle.truncate(committedLength);
    await syncUnlessNoSpace(handle, io);
    return committed;
  } finally {
    await handle.close();
  }
}

/** fsync; false on a full disk or quota, other errors propagate. */
async function syncUnlessNoSpace(
  handle: FileHandle,
  io: TailIo
): Promise<boolean> {
  try {
    await io.sync(handle);
    return true;
  } catch (error: unknown) {
    if (!isNoSpace(error)) {
      throw error;
    }
    return false;
  }
}

/**
 * Write the newline that commits a complete tail envelope. On a full disk or
 * quota the newline can need a new block: a final record is committed from
 * the reserve (the reserve exists for it). Any other record, or a final
 * record whose reserve is already spent, is reported as not committed so the
 * caller cuts it, which needs no space. Returns whether the newline was
 * written.
 */
async function commitNewline(opts: {
  readonly handle: FileHandle;
  readonly paths: JournalPaths;
  readonly at: number;
  readonly next: EventEnvelope;
  readonly io: TailIo;
}): Promise<boolean> {
  const write = async (): Promise<boolean> => {
    try {
      const written = await opts.io.writeAt(
        opts.handle,
        Buffer.from("\n"),
        opts.at
      );
      return written === 1;
    } catch (error: unknown) {
      if (!isNoSpace(error)) {
        throw error;
      }
      return false;
    }
  };
  if (await write()) {
    return true;
  }
  if (opts.next.type !== "command.ended") {
    return false;
  }
  await unlink(opts.paths.reserve).catch(() => undefined);
  return await write();
}

function parseEnvelope(text: string): EventEnvelope | null {
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Append events with dense sequence numbers starting after `lastSeq`.
 * `command.ended` is fsynced and, when the disk or quota is full, written
 * after releasing the reserved bytes, so a full disk cannot lose it.
 */
export class JournalWriter {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  private seq: number;
  private readonly append: AppendLine;

  constructor(
    paths: JournalPaths,
    meta: CommandMeta,
    lastSeq: number,
    append: AppendLine = appendLine
  ) {
    this.paths = paths;
    this.meta = meta;
    this.seq = lastSeq;
    this.append = append;
  }

  get lastSeq(): number {
    return this.seq;
  }

  async write(
    type: StoredEventType,
    payload: Record<string, unknown>
  ): Promise<EventEnvelope> {
    const envelope = buildEnvelope({
      meta: this.meta,
      seq: this.seq + 1,
      type,
      payload,
    });
    const line = `${JSON.stringify(envelope)}\n`;
    try {
      await this.append(this.paths.events, line);
    } catch (error: unknown) {
      if (!(type === "command.ended" && isNoSpace(error))) {
        throw error;
      }
      await unlink(this.paths.reserve).catch(() => undefined);
      await this.append(this.paths.events, line);
    }
    this.seq += 1;
    if (type === "command.ended") {
      await syncFile(this.paths.events);
    }
    return envelope;
  }
}

/**
 * fsync a file, then the directories that name it, so a committed record
 * survives power loss. A file fsync failure propagates; directory fsync is
 * best effort because some filesystems refuse it.
 */
export async function syncDurably(opts: {
  readonly file: string;
  readonly directories: readonly string[];
}): Promise<void> {
  const handle = await open(
    opts.file,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (const directory of opts.directories) {
    const dir = await open(directory, constants.O_RDONLY).catch(() => null);
    try {
      await dir?.sync();
    } catch {
      // Directory fsync is not supported everywhere.
    } finally {
      await dir?.close();
    }
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY).catch(() => null);
  try {
    await handle?.sync();
  } catch {
    // Best effort; the line is already written.
  } finally {
    await handle?.close();
  }
}

export function endedEvent(
  events: readonly EventEnvelope[]
): EventEnvelope | null {
  return events.find((event) => event.type === "command.ended") ?? null;
}

/** Bytes already covered by output events, per stream. */
export function emittedOffsets(events: readonly EventEnvelope[]): {
  readonly stdout: number;
  readonly stderr: number;
  readonly captured: number;
  readonly outputEvents: number;
  readonly truncated: boolean;
} {
  let stdout = 0;
  let stderr = 0;
  let captured = 0;
  let outputEvents = 0;
  let truncated = false;
  for (const event of events) {
    if (event.type === "command.output_truncated") {
      truncated = true;
    }
    if (event.type !== "command.output") {
      continue;
    }
    const range = outputRange(event);
    if (!range) {
      continue;
    }
    outputEvents += 1;
    captured += range.length;
    const end = range.offset + range.length;
    if (range.stream === "stdout") {
      stdout = Math.max(stdout, end);
    } else {
      stderr = Math.max(stderr, end);
    }
  }
  return { stdout, stderr, captured, outputEvents, truncated };
}

export function outputRange(event: EventEnvelope): {
  readonly stream: OutputStream;
  readonly offset: number;
  readonly length: number;
} | null {
  const { stream, offset, length } = event.payload;
  if (
    (stream === "stdout" || stream === "stderr") &&
    typeof offset === "number" &&
    typeof length === "number" &&
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0
  ) {
    return { stream, offset, length };
  }
  return null;
}

/**
 * Serialize a journal record, refusing one larger than its reader accepts:
 * an unreadable record would hide its journal from admission, retention and
 * the per-home quota.
 */
export function boundedRecordText(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > JOURNAL_RECORD_MAX_BYTES) {
    throw new HackCliError({
      code: "E_USAGE",
      message:
        "This background command is too large to record (its arguments, working directory and target exceed 1 MiB once serialized). Run it in the foreground or shorten its arguments.",
    });
  }
  return text;
}
