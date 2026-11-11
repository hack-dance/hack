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
  syncDurably,
} from "./journal.ts";
import {
  assessOwner,
  type ObserveIdentities,
  recoverLostOwner,
  withJournalLock,
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
  const keys = resolve(root, "keys");
  await mkdir(keys, { recursive: true, mode: 0o700 });
  if (!(await lstat(keys)).isDirectory()) {
    throw storeRefusal();
  }
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
    if (meta && (await holdsAdmission({ ...opts, paths, meta }))) {
      total += 1;
      caller += meta.caller === opts.caller ? 1 : 0;
    }
  }
  return { total, caller };
}

/** Whether one journal counts against the admission limits right now. */
async function holdsAdmission(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  readonly now: number;
  readonly observe?: ObserveIdentities;
}): Promise<boolean> {
  const { paths, meta } = opts;
  const tombstone = await readTombstone(paths);
  if (tombstone) {
    // Output expiry keeps a value-free admission hold: retention shorter
    // than the timeout window must not free an unconfirmed stop's slot.
    return tombstone.holdUntil !== null && opts.now < tombstone.holdUntil;
  }
  const events = await readEvents(paths);
  const ended = endedEvent(events);
  if (ended) {
    // A stop that could not confirm the process in the container is gone
    // keeps its slot for the command's timeout window, so a start/cancel
    // loop cannot run more than the limits allow.
    return holdsSlot({ meta, ended, now: opts.now });
  }
  const assessment = await assessOwner({
    paths,
    meta,
    events,
    now: opts.now,
    observe: opts.observe,
  });
  if (assessment.kind !== "owner_lost") {
    return true;
  }
  const recovered = endedEvent(
    await recoverLostOwner({
      paths,
      meta,
      observe: opts.observe,
      enforceTimeout: true,
    })
  );
  return recovered
    ? holdsSlot({ meta, ended: recovered, now: opts.now })
    : true;
}

/** An end whose container process is unconfirmed holds its slot until the timeout window closes. */
export function holdsSlot(opts: {
  readonly meta: CommandMeta;
  readonly ended: { readonly payload: Record<string, unknown> };
  readonly now: number;
}): boolean {
  return (
    opts.ended.payload.containerProcess === "not_confirmed" &&
    opts.now < Date.parse(opts.meta.acceptedAt) + opts.meta.timeoutMs
  );
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
    // Acceptance is committed before anything can be spawned.
    await syncDurably({ file: paths.events, directories: [paths.dir, root] });
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

/** Read-only request-key lookup (no store lock: it never writes). */
export async function lookupRequest(opts: {
  readonly projectRoot: string;
  readonly requestKey: string;
  readonly fingerprintInputs: Record<string, unknown>;
  readonly root?: string;
}): Promise<AcceptResult | null> {
  const root = opts.root ?? commandsRoot();
  if (!(await lstat(resolve(root, "keys")).catch(() => null))?.isDirectory()) {
    return null;
  }
  const found = await findExistingRequest({
    root,
    keyPath: requestKeyPath({
      root,
      projectRoot: opts.projectRoot,
      requestKey: opts.requestKey,
    }),
    fingerprint: fingerprintOf(opts.fingerprintInputs),
  });
  // Retention applies here too: a result past its time is not handed back.
  if (
    found &&
    (await expireIfDue({
      paths: found.paths,
      meta: found.meta,
      now: Date.now(),
    }))
  ) {
    throw new HackCliError({
      code: "E_RESULT_EXPIRED",
      message:
        "This requestKey belongs to a command whose result has expired. It is not run again; use a new requestKey.",
    });
  }
  return found;
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
    const tombstone = await readTombstone(paths);
    if (tombstone) {
      // Retried on every sweep: an unlink that failed earlier (or a crash
      // right after the tombstone) must not leave output behind.
      await removeJournalPayload(paths);
      const expiredAt = tombstone.expiredAt;
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
    await expireJournal({ paths, meta, ended, now: opts.now });
  }
}

/**
 * Enforce retention on access: an ended command whose retention has elapsed
 * is expired now, under its journal lock, whether or not another command
 * was started since. True when the journal is (now) expired.
 */
export async function expireIfDue(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  readonly now: number;
}): Promise<boolean> {
  const ended = endedEvent(await readEvents(opts.paths));
  if (!ended || opts.now - Date.parse(ended.time) < opts.meta.retentionMs) {
    return false;
  }
  await withJournalLock(opts.paths, async () => {
    if (!(await lstat(opts.paths.expired).catch(() => null))) {
      await expireJournal({ ...opts, ended });
    }
  });
  return true;
}

/** Best-effort retention sweep for callers other than a start. */
export async function pruneStore(root = commandsRoot()): Promise<void> {
  try {
    if (!(await lstat(root).catch(() => null))?.isDirectory()) {
      return;
    }
    // Never wait behind a start: retention is enforced per journal on access.
    await withProjectsRegistryLock({
      lockPath: resolve(root, "store.lock"),
      run: () => pruneExpired({ root, now: Date.now() }),
      waitForLock: false,
      label: "background command store",
    });
  } catch {
    // Retention is also enforced on access; a busy store never fails a read.
  }
}

/**
 * Write the tombstone, then remove the payload. An end that still holds its
 * admission slot (see `holdsSlot`) leaves its deadline in the tombstone, so
 * the hold outlives the events it was read from.
 */
async function expireJournal(opts: {
  readonly paths: JournalPaths;
  readonly meta: CommandMeta;
  readonly ended: { readonly payload: Record<string, unknown> };
  readonly now: number;
}): Promise<void> {
  const holdUntil = holdsSlot(opts)
    ? new Date(
        Date.parse(opts.meta.acceptedAt) + opts.meta.timeoutMs
      ).toISOString()
    : null;
  await replacePrivateFileAtomic({
    path: opts.paths.expired,
    directories: [opts.paths.dir],
    refusal: storeRefusal,
    text: JSON.stringify({
      expiredAt: new Date(opts.now).toISOString(),
      ...(holdUntil ? { holdUntil } : {}),
    }),
  });
  await removeJournalPayload(opts.paths);
}

type Tombstone = {
  readonly expiredAt: number | null;
  readonly holdUntil: number | null;
};

async function readTombstone(paths: JournalPaths): Promise<Tombstone | null> {
  const file = await readReplaceablePrivateFile({
    path: paths.expired,
    directories: [paths.dir],
    refusal: storeRefusal,
    maxBytes: 4096,
  }).catch(() => null);
  return file ? parseTombstone(file.text) : null;
}

/**
 * Remove everything but the value-free tombstone. Idempotent: every sweep
 * runs it again for an expired journal until nothing is left to remove.
 * The tombstone's meta keeps scope and request-key identity only: argv and
 * workdir can hold sensitive literals and must not outlive retention.
 */
async function removeJournalPayload(paths: JournalPaths): Promise<void> {
  const meta = await readMeta(paths).catch(() => null);
  if (meta && (meta.argv.length > 0 || meta.workdir !== null)) {
    await replacePrivateFileAtomic({
      path: paths.meta,
      directories: [paths.dir],
      refusal: storeRefusal,
      text: JSON.stringify({ ...meta, argv: [], workdir: null }),
    }).catch(() => undefined);
  }
  for (const path of [
    paths.events,
    paths.stdout,
    paths.stderr,
    paths.launch,
    paths.reserve,
    paths.cancel,
    paths.owner,
    paths.child,
    paths.spawning,
    paths.stopping,
  ]) {
    await unlink(path).catch(() => undefined);
  }
}

function parseTombstone(text: string): Tombstone {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const time = (field: string): number | null => {
    const raw = isRecord(value) ? value[field] : undefined;
    const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  return { expiredAt: time("expiredAt"), holdUntil: time("holdUntil") };
}

async function removeRequestKey(opts: {
  readonly root: string;
  readonly paths: JournalPaths;
}): Promise<void> {
  const meta = await readMeta(opts.paths).catch(() => null);
  if (!meta?.requestKey) {
    return;
  }
  // Unlink only through real directories: neither the store root nor its
  // `keys` directory may be a symlink, so the removal cannot leave the store.
  const keysDir = resolve(opts.root, "keys");
  for (const dir of [opts.root, keysDir]) {
    const stats = await lstat(dir).catch(() => null);
    if (!stats?.isDirectory()) {
      return;
    }
  }
  const path = requestKeyPath({
    root: opts.root,
    projectRoot: meta.projectRoot,
    requestKey: meta.requestKey,
  });
  const entry = await lstat(path).catch(() => null);
  if (entry?.isFile()) {
    await unlink(path).catch(() => undefined);
  }
}
