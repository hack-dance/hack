import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import { HackCliError } from "../cli-result.ts";
import { isRecord } from "../guards.ts";
import {
  createPrivateFileExclusive,
  readReplaceablePrivateFile,
  replacePrivateFileAtomic,
} from "../private-file.ts";
import { withProjectsRegistryLock } from "../projects-registry-lock.ts";
import {
  appendLine,
  buildEnvelope,
  type CommandMeta,
  commandsRoot,
  endedEvent,
  formatCursor,
  HACK_VERSION,
  isCommandId,
  JOURNAL_FORMAT_VERSION,
  type JournalPaths,
  journalPaths,
  newCommandId,
  newGeneration,
  RESERVE_BYTES,
  readEvents,
  readMeta,
} from "./journal.ts";
import {
  assessOwner,
  type ObserveIdentities,
  recoverLostOwner,
} from "./recovery.ts";

/** Active background commands one caller session may have. */
export const CALLER_ACTIVE_LIMIT = 4;
/** Active background commands per Hack home. */
export const HOME_ACTIVE_LIMIT = 16;
/** How long an expired command's tombstone (and its request key) is kept. */
export const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

export type AcceptInput = Omit<
  CommandMeta,
  | "formatVersion"
  | "writerVersion"
  | "commandId"
  | "generation"
  | "acceptedAt"
  | "fingerprint"
> & {
  /** Validated inputs that define "the same request" for a request key. */
  readonly fingerprintInputs: Record<string, unknown>;
};

export type AcceptResult = {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  /** True when a retried request key returned an existing command. */
  readonly reused: boolean;
};

function storeRefusal(): Error {
  return new HackCliError({
    code: "E_PERMISSION",
    message:
      "The background command store is not a private directory; nothing was started.",
  });
}

/** Create `<hack home>/commands` (0700) and refuse a symlink in its place. */
export async function ensureStoreRoot(root = commandsRoot()): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stats = await lstat(root);
  if (!stats.isDirectory()) {
    throw storeRefusal();
  }
  if ((stats.mode & 0o077) !== 0) {
    await chmod(root, 0o700);
  }
  await mkdir(resolve(root, "keys"), { recursive: true, mode: 0o700 });
  return root;
}

export function withStoreLock<T>(
  root: string,
  run: () => Promise<T>
): Promise<T> {
  return withProjectsRegistryLock({
    lockPath: resolve(root, "store.lock"),
    run,
    label: "background command store",
  });
}

/** Stable digest of validated inputs; never includes environment values. */
export function fingerprintOf(inputs: Record<string, unknown>): string {
  const canonical = JSON.stringify(inputs, Object.keys(inputs).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

function requestKeyPath(opts: {
  readonly root: string;
  readonly projectRoot: string;
  readonly requestKey: string;
}): string {
  const digest = createHash("sha256")
    .update(`${opts.projectRoot}\0${opts.requestKey}`)
    .digest("hex");
  return resolve(opts.root, "keys", `${digest}.json`);
}

async function readRequestKey(opts: {
  readonly root: string;
  readonly path: string;
}): Promise<{
  readonly commandId: string;
  readonly fingerprint: string;
} | null> {
  const file = await readReplaceablePrivateFile({
    path: opts.path,
    directories: [resolve(opts.root, "keys")],
    refusal: storeRefusal,
    maxBytes: 4096,
  });
  if (!file) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(file.text);
    if (
      isRecord(value) &&
      typeof value.commandId === "string" &&
      isCommandId(value.commandId) &&
      typeof value.fingerprint === "string"
    ) {
      return { commandId: value.commandId, fingerprint: value.fingerprint };
    }
  } catch {
    // Treated as absent below only if the command is gone; see caller.
  }
  return null;
}

export async function listCommandIds(root: string): Promise<string[]> {
  const names = await readdir(root).catch(() => []);
  return names.filter((name) => isCommandId(name)).sort();
}

/**
 * Count active commands: no final record yet. A journal whose supervisor is
 * provably gone is finalized first (outcome `unknown`), so a crashed
 * supervisor cannot hold an admission slot forever.
 */
async function countActive(opts: {
  readonly root: string;
  readonly caller: string;
  readonly now: number;
  readonly observe?: ObserveIdentities;
}): Promise<{ readonly total: number; readonly caller: number }> {
  let total = 0;
  let caller = 0;
  for (const commandId of await listCommandIds(opts.root)) {
    const paths = journalPaths({ root: opts.root, commandId });
    const meta = await readMeta(paths).catch(() => null);
    if (!meta) {
      continue;
    }
    let events = await readEvents(paths);
    if (endedEvent(events)) {
      continue;
    }
    const assessment = await assessOwner({
      paths,
      meta,
      events,
      now: opts.now,
      observe: opts.observe,
    });
    if (assessment.kind === "owner_lost") {
      events = await recoverLostOwner({ paths, meta, observe: opts.observe });
      if (endedEvent(events)) {
        continue;
      }
    }
    total += 1;
    if (meta.caller === opts.caller) {
      caller += 1;
    }
  }
  return { total, caller };
}

/**
 * Persist an accepted command before anything is launched.
 *
 * Under the store lock: expired journals are pruned; a request key already
 * used for the same project returns that command when the validated inputs
 * match and is a conflict otherwise (a retried start never runs twice); the
 * admission limits are checked; then the journal directory, `meta.json`, the
 * reserved bytes and `command.accepted` (seq 1) are written.
 */
export async function acceptCommand(opts: {
  readonly input: AcceptInput;
  readonly root?: string;
  readonly now?: Date;
  readonly observe?: ObserveIdentities;
}): Promise<AcceptResult> {
  const root = await ensureStoreRoot(opts.root);
  const now = opts.now ?? new Date();
  return await withStoreLock(root, async () => {
    await pruneExpired({ root, now: now.getTime() });
    const { fingerprintInputs, ...input } = opts.input;
    const fingerprint = fingerprintOf(fingerprintInputs);
    const keyPath =
      input.requestKey === null
        ? null
        : requestKeyPath({
            root,
            projectRoot: input.projectRoot,
            requestKey: input.requestKey,
          });
    const existing = keyPath
      ? await findExistingRequest({ root, keyPath, fingerprint })
      : null;
    if (existing) {
      return existing;
    }
    const active = await countActive({
      root,
      caller: input.caller,
      now: now.getTime(),
      observe: opts.observe,
    });
    if (active.caller >= CALLER_ACTIVE_LIMIT) {
      throw new HackCliError({
        code: "E_ADMISSION_LIMIT",
        message: `This session already has ${CALLER_ACTIVE_LIMIT} active background commands. Wait for one to end or cancel one, then retry.`,
      });
    }
    if (active.total >= HOME_ACTIVE_LIMIT) {
      throw new HackCliError({
        code: "E_ADMISSION_LIMIT",
        message: `This Hack home already has ${HOME_ACTIVE_LIMIT} active background commands. Wait for one to end or cancel one, then retry.`,
      });
    }
    const meta: CommandMeta = {
      formatVersion: JOURNAL_FORMAT_VERSION,
      writerVersion: HACK_VERSION,
      commandId: newCommandId(),
      generation: newGeneration(),
      acceptedAt: now.toISOString(),
      fingerprint,
      ...input,
    };
    const paths = journalPaths({ root, commandId: meta.commandId });
    await mkdir(paths.dir, { mode: 0o700 });
    await createPrivateFileExclusive({
      path: paths.meta,
      text: JSON.stringify(meta),
    });
    await reserveFinalRecordSpace(paths.reserve);
    const accepted = buildEnvelope({
      meta,
      seq: 1,
      type: "command.accepted",
      payload: {
        operation: meta.operation,
        backend: meta.backend,
        capture: meta.capture,
        timeoutMs: meta.timeoutMs,
        stallAfterMs: meta.stallAfterMs,
        liveOutput: meta.liveOutput,
        stallDetection: meta.stallDetection,
        requestKey: meta.requestKey !== null,
      },
      time: now,
    });
    await appendLine(paths.events, `${JSON.stringify(accepted)}\n`);
    if (keyPath) {
      await createPrivateFileExclusive({
        path: keyPath,
        text: JSON.stringify({ commandId: meta.commandId, fingerprint }),
      });
    }
    return { paths, meta, reused: false };
  });
}

/**
 * The command an earlier start with this request key created, when its
 * validated inputs match. Different inputs are a conflict; an expired result
 * is reported, and the command is never run again.
 */
async function findExistingRequest(opts: {
  readonly root: string;
  readonly keyPath: string;
  readonly fingerprint: string;
}): Promise<AcceptResult | null> {
  const existing = await readRequestKey({
    root: opts.root,
    path: opts.keyPath,
  });
  if (!existing) {
    return null;
  }
  if (existing.fingerprint !== opts.fingerprint) {
    throw new HackCliError({
      code: "E_REQUEST_CONFLICT",
      message:
        "This requestKey was already used for a different command in this project. Use a new requestKey for a new command.",
    });
  }
  const paths = journalPaths({
    root: opts.root,
    commandId: existing.commandId,
  });
  const meta = await readMeta(paths);
  if (!meta || (await lstat(paths.expired).catch(() => null))) {
    throw new HackCliError({
      code: "E_RESULT_EXPIRED",
      message:
        "This requestKey belongs to a command whose result has expired. It is not run again; use a new requestKey.",
    });
  }
  return { paths, meta, reused: true };
}

/** Preallocate bytes that are released only to write `command.ended`. */
async function reserveFinalRecordSpace(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.write(Buffer.alloc(RESERVE_BYTES));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function cursorBeforeFirst(meta: CommandMeta): string {
  return formatCursor({
    commandId: meta.commandId,
    generation: meta.generation,
    seq: 0,
  });
}

/** Latest time the result can still be read: deadline plus retention. */
export function expiresAt(meta: CommandMeta): string {
  return new Date(
    Date.parse(meta.acceptedAt) + meta.timeoutMs + meta.retentionMs
  ).toISOString();
}

/**
 * Retention. Only ended commands expire: their output and events are removed
 * `retentionMs` after the end (never more than 24 hours) and an `expired.json`
 * tombstone is left so a later read reports "expired" rather than "not
 * found". Tombstones and their request keys are removed after 7 days.
 * Running commands are never touched here.
 */
export async function pruneExpired(opts: {
  readonly root: string;
  readonly now: number;
}): Promise<void> {
  for (const commandId of await listCommandIds(opts.root)) {
    const paths = journalPaths({ root: opts.root, commandId });
    const tombstone = await readReplaceablePrivateFile({
      path: paths.expired,
      directories: [paths.dir],
      refusal: storeRefusal,
      maxBytes: 4096,
    }).catch(() => null);
    if (tombstone) {
      const expiredAt = parseExpiredAt(tombstone.text);
      if (expiredAt !== null && opts.now - expiredAt > TOMBSTONE_MS) {
        await removeRequestKey({ root: opts.root, paths });
        await rm(paths.dir, { recursive: true, force: true });
      }
      continue;
    }
    const meta = await readMeta(paths).catch(() => null);
    if (!meta) {
      continue;
    }
    const ended = endedEvent(await readEvents(paths));
    if (!ended) {
      continue;
    }
    if (opts.now - Date.parse(ended.time) < meta.retentionMs) {
      continue;
    }
    await expireJournal({ paths, now: opts.now });
  }
}

async function expireJournal(opts: {
  readonly paths: JournalPaths;
  readonly now: number;
}): Promise<void> {
  await replacePrivateFileAtomic({
    path: opts.paths.expired,
    directories: [opts.paths.dir],
    refusal: storeRefusal,
    text: JSON.stringify({ expiredAt: new Date(opts.now).toISOString() }),
  });
  for (const path of [
    opts.paths.events,
    opts.paths.stdout,
    opts.paths.stderr,
    opts.paths.launch,
    opts.paths.reserve,
    opts.paths.cancel,
  ]) {
    await unlink(path).catch(() => undefined);
  }
}

function parseExpiredAt(text: string): number | null {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && typeof value.expiredAt === "string") {
      const parsed = Date.parse(value.expiredAt);
      return Number.isFinite(parsed) ? parsed : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function removeRequestKey(opts: {
  readonly root: string;
  readonly paths: JournalPaths;
}): Promise<void> {
  const meta = await readMeta(opts.paths).catch(() => null);
  if (meta?.requestKey) {
    await unlink(
      requestKeyPath({
        root: opts.root,
        projectRoot: meta.projectRoot,
        requestKey: meta.requestKey,
      })
    ).catch(() => undefined);
  }
}

/**
 * Background audit log, `<hack home>/commands/audit.log` (0600). Starts,
 * final outcomes and cancels are recorded; reads are not. Lines never hold
 * argv, output or environment values.
 */
export async function appendCommandAudit(opts: {
  readonly root?: string;
  readonly entry: {
    readonly event: "start" | "end" | "cancel";
    readonly commandId: string;
    readonly operation: string;
    readonly projectId: string;
    readonly instanceId: string;
    readonly service: string;
    readonly caller: string;
    readonly outcome?: string;
    readonly exitCode?: number | null;
  };
}): Promise<void> {
  try {
    const root = await ensureStoreRoot(opts.root);
    await appendLine(
      resolve(root, "audit.log"),
      `${JSON.stringify({ ts: new Date().toISOString(), ...opts.entry })}\n`
    );
  } catch {
    // Auditing never blocks or fails a command, matching the MCP audit log.
  }
}
