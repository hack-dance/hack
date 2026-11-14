import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { isRecord } from "./guards.ts";
import { normalizeProjectName } from "./project-name.ts";
import {
  readProjectsRegistry,
  selectRegisteredProjectByName,
} from "./projects-registry.ts";
import {
  ProjectsRegistryLockTimeoutError,
  withProjectsRegistryLock,
} from "./projects-registry-lock.ts";

/**
 * The activity log (HACK-2218): `<hack home>/activity.jsonl`, one JSON line
 * per project lifecycle action, appended by every `hack up`, `down` and
 * `restart` whatever the backend, and read by `hack activity`.
 *
 * Contract:
 * - Append-only. Each record is one `write(2)` of a whole line on a file
 *   opened `O_APPEND`, at most {@link ACTIVITY_LINE_LIMIT} bytes, so
 *   concurrent CLIs cannot interleave within a line.
 * - Private: created 0600 (an existing file with group or other access is
 *   tightened before writing), never through a symlink, never a file of
 *   another user.
 * - Bounded: when the file would pass {@link ACTIVITY_ROTATE_BYTES} it is
 *   renamed to `activity.jsonl.1` (replacing the previous generation) under
 *   a short lock; one generation is kept.
 * - Names only: the project's registered name, a branch slug, service names
 *   and fixed enums. Never a value, an env value, a command line or a path.
 * - Best effort: a failure to record is swallowed and never changes the
 *   command's result or exit code.
 */

export const ACTIVITY_FILE_NAME = "activity.jsonl";
export const ACTIVITY_SCHEMA_VERSION = 1;
/**
 * One record is written with a single write of at most this many bytes (plus
 * a leading newline after a torn line). 4096 is the smallest PIPE_BUF the
 * supported platforms give.
 */
export const ACTIVITY_LINE_LIMIT = 4096;
/** Size at which the current file becomes the kept generation. */
export const ACTIVITY_ROTATE_BYTES = 1024 * 1024;
/** How long an append waits for the log lock before appending without it. */
const APPEND_LOCK_WAIT_MS = 2000;

export const ACTIVITY_ACTIONS = ["up", "down", "restart", "autostart"] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

/** Who asked for the action; from `HACK_ORIGIN`, `cli` when unset or unknown. */
export const ACTIVITY_ORIGINS = ["cli", "app", "autostart", "agent"] as const;
export type ActivityOrigin = (typeof ACTIVITY_ORIGINS)[number];

/**
 * `ok`: exit 0. `interrupted`: the command returned 130 (SIGINT) or 143
 * (SIGTERM), for example a foreground `up` stopped with Ctrl-C. `failed`:
 * any other exit status or an error.
 */
export const ACTIVITY_OUTCOMES = ["ok", "failed", "interrupted"] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

export type ActivityRecord = {
  readonly v: typeof ACTIVITY_SCHEMA_VERSION;
  /** ISO 8601 UTC time the action started. */
  readonly ts: string;
  /** The project's registered name; null when it is not registered. */
  readonly project: string | null;
  /** The branch instance, when one was targeted. */
  readonly branch: string | null;
  readonly action: ActivityAction;
  readonly origin: ActivityOrigin;
  readonly outcome: ActivityOutcome;
  /** Names of services that failed to start, when known. Sorted, unique. */
  readonly failed_services: readonly string[];
  readonly duration_ms: number;
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
const FAILED_SERVICES_LIMIT = 32;

export function resolveActivityOrigin(
  raw: string | undefined = process.env.HACK_ORIGIN
): ActivityOrigin {
  const value = (raw ?? "").trim();
  return (ACTIVITY_ORIGINS as readonly string[]).includes(value)
    ? (value as ActivityOrigin)
    : "cli";
}

export function resolveActivityPath(): string {
  return join(resolveGlobalHackDir(), ACTIVITY_FILE_NAME);
}

// ---------------------------------------------------------------------------
// What a running action learns about itself. Lifecycle code notes the branch
// and failed services where it finds them; outside a recorded action these
// notes do nothing.
// ---------------------------------------------------------------------------

type ActivityNotes = {
  /** Undefined: nothing noted. Null: the base instance. */
  branch?: string | null;
  failedServices: Set<string>;
};

const notes = new AsyncLocalStorage<ActivityNotes>();
let suppressed = false;

/**
 * Stop this process from recording: the detached native owner re-runs `up`
 * in a child that lives as long as the services, and its launcher records
 * the action.
 */
export function suppressActivityRecording(): void {
  suppressed = true;
}

/**
 * Note the branch instance the running action targets; null for the base
 * instance. A later note replaces an earlier one, so a command that retargets
 * (an implicit `down` reconciled to the instance actually running) records
 * where it acted. A name that is not a plain name records no branch.
 */
export function noteActivityBranch(branch: string | null): void {
  const current = notes.getStore();
  if (current) {
    current.branch = branch && NAME.test(branch) ? branch : null;
  }
}

/** Note services that failed to start in the running action (names only). */
export function noteActivityFailedServices(
  services: readonly (string | undefined)[]
): void {
  const current = notes.getStore();
  if (!current) {
    return;
  }
  for (const service of services) {
    if (service && SERVICE.test(service)) {
      current.failedServices.add(service);
    }
  }
}

/**
 * Run a lifecycle action and append its record afterwards. The result (or
 * error) of `run` is returned (or thrown) unchanged; recording never fails
 * the command.
 */
export async function recordActivity(opts: {
  readonly action: ActivityAction;
  /** Resolves the project's registered name after the action. */
  readonly project: () => Promise<string | null>;
  /** An explicit `--branch`, used when the action noted none. */
  readonly branch?: string;
  readonly run: () => Promise<number>;
  readonly now?: () => number;
}): Promise<number> {
  if (suppressed) {
    return await opts.run();
  }
  const now = opts.now ?? Date.now;
  const started = now();
  const current: ActivityNotes = { failedServices: new Set() };
  let exitCode = 1;
  try {
    exitCode = await notes.run(current, opts.run);
    return exitCode;
  } finally {
    try {
      const record = buildActivityRecord({
        action: opts.action,
        startedAt: started,
        durationMs: Math.max(0, now() - started),
        project: await opts.project().catch(() => null),
        branch:
          current.branch === undefined ? (opts.branch ?? null) : current.branch,
        exitCode,
        failedServices: [...current.failedServices],
      });
      await appendActivityRecord({ record });
    } catch {
      // Best effort: the activity log never changes a command's result.
    }
  }
}

export function buildActivityRecord(opts: {
  readonly action: ActivityAction;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly project: string | null;
  readonly branch: string | null;
  readonly exitCode: number;
  readonly failedServices: readonly string[];
  readonly origin?: ActivityOrigin;
}): ActivityRecord {
  let outcome: ActivityOutcome = "failed";
  if (opts.exitCode === 0) {
    outcome = "ok";
  } else if (opts.exitCode === 130 || opts.exitCode === 143) {
    outcome = "interrupted";
  }
  return {
    v: ACTIVITY_SCHEMA_VERSION,
    ts: new Date(opts.startedAt).toISOString(),
    project: opts.project && NAME.test(opts.project) ? opts.project : null,
    branch: opts.branch && NAME.test(opts.branch) ? opts.branch : null,
    action: opts.action,
    origin: opts.origin ?? resolveActivityOrigin(),
    outcome,
    failed_services: [...new Set(opts.failedServices)]
      .filter((name) => SERVICE.test(name))
      .sort()
      .slice(0, FAILED_SERVICES_LIMIT),
    duration_ms: Math.round(opts.durationMs),
  };
}

/** One record as its line; services are dropped from the end to fit the limit. */
export function encodeActivityRecord(record: ActivityRecord): Buffer {
  let services = [...record.failed_services];
  for (;;) {
    const line = Buffer.from(
      `${JSON.stringify({ ...record, failed_services: services })}\n`
    );
    if (line.byteLength <= ACTIVITY_LINE_LIMIT || services.length === 0) {
      return line;
    }
    services = services.slice(0, -1);
  }
}

/** Attempts to land a record in a file that is still linked (fallback). */
const APPEND_ATTEMPTS = 3;

type LogFile = Awaited<ReturnType<typeof open>>;

type OpenedLog = {
  readonly file: LogFile;
  readonly size: number;
  readonly ino: number;
  readonly dev: number;
};

/**
 * Open `path` for appending and enforce the private-file policy on the
 * descriptor: never through a symlink, a regular file of this user, mode
 * 0600 (a looser one is tightened). Throws otherwise.
 */
async function openPrivateLog(opts: {
  readonly path: string;
  readonly create: boolean;
}): Promise<OpenedLog> {
  // Read-write only to look at the last byte; every write appends.
  const file = await open(
    opts.path,
    constants.O_RDWR |
      constants.O_APPEND |
      (opts.create ? constants.O_CREAT : 0) |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600
  );
  try {
    const info = await file.stat();
    const uid = process.getuid?.();
    if (!info.isFile() || (uid !== undefined && info.uid !== uid)) {
      throw new Error("Activity log is not this user's regular file");
    }
    if ((info.mode & 0o077) !== 0) {
      await file.chmod(0o600);
    }
    return { file, size: info.size, ino: info.ino, dev: info.dev };
  } catch (error: unknown) {
    await file.close();
    throw error;
  }
}

/**
 * Append one record. Throws on any failure (callers swallow it): a symlinked
 * or non-regular file, one owned by another user, or a short write.
 *
 * Appends and rotation take the same lock (`<path>.lock`), so a rotation
 * never retires a file between a writer's open and its write: a completed
 * append is lost only to retention, after a later rotation has kept a full
 * newer generation. When the lock stays busy past its short wait, the record
 * is appended without it and without rotating; then the descriptor's link
 * count is checked after the write, and a record that landed in a retired
 * (unlinked) file is appended again.
 */
export async function appendActivityRecord(opts: {
  readonly record: ActivityRecord;
  readonly path?: string;
  readonly rotateBytes?: number;
  /** Tests only: runs after the file is opened, before the write. */
  readonly afterOpen?: () => Promise<void>;
  /** Tests only: the lock wait. */
  readonly lockWaitMs?: number;
}): Promise<void> {
  const path = opts.path ?? resolveActivityPath();
  const line = encodeActivityRecord(opts.record);
  if (line.byteLength > ACTIVITY_LINE_LIMIT) {
    throw new Error("Activity record exceeds the line limit");
  }
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  let locked = false;
  try {
    await withProjectsRegistryLock({
      lockPath: `${path}.lock`,
      label: "activity log",
      timeoutMs: opts.lockWaitMs ?? APPEND_LOCK_WAIT_MS,
      run: async () => {
        locked = true;
        await appendHoldingLock({
          path,
          line,
          rotateBytes: opts.rotateBytes ?? ACTIVITY_ROTATE_BYTES,
          afterOpen: opts.afterOpen,
        });
      },
    });
  } catch (error: unknown) {
    if (locked || !(error instanceof ProjectsRegistryLockTimeoutError)) {
      throw error;
    }
    await appendWithoutLock({ path, line, afterOpen: opts.afterOpen });
  }
}

async function appendHoldingLock(opts: {
  readonly path: string;
  readonly line: Buffer;
  readonly rotateBytes: number;
  readonly afterOpen?: () => Promise<void>;
}): Promise<void> {
  let opened = await openPrivateLog({ path: opts.path, create: true });
  try {
    if (
      opened.size > 0 &&
      opened.size + opts.line.byteLength > opts.rotateBytes
    ) {
      // Keep the file just checked (0600, this user's) as the generation,
      // only if the name still points at it.
      const named = await lstat(opts.path);
      if (named.ino === opened.ino && named.dev === opened.dev) {
        await rename(opts.path, `${opts.path}.1`);
      }
      await opened.file.close();
      opened = await openPrivateLog({ path: opts.path, create: true });
    }
    await opts.afterOpen?.();
    await writeLine({ file: opened.file, size: opened.size, line: opts.line });
  } finally {
    await opened.file.close();
  }
}

async function appendWithoutLock(opts: {
  readonly path: string;
  readonly line: Buffer;
  readonly afterOpen?: () => Promise<void>;
}): Promise<void> {
  for (let attempt = 1; attempt <= APPEND_ATTEMPTS; attempt += 1) {
    const opened = await openPrivateLog({ path: opts.path, create: true });
    try {
      if (attempt === 1) {
        await opts.afterOpen?.();
      }
      await writeLine({
        file: opened.file,
        size: opened.size,
        line: opts.line,
      });
      if ((await opened.file.stat()).nlink > 0) {
        return;
      }
    } finally {
      await opened.file.close();
    }
  }
  throw new Error("Activity record landed only in retired files");
}

async function writeLine(opts: {
  readonly file: LogFile;
  readonly size: number;
  readonly line: Buffer;
}): Promise<void> {
  // After a torn write (a crash or a full disk mid-line) the file does not
  // end in a newline: start a fresh line so this record stays whole. Still
  // one write. A writer without the lock that looks during another append
  // can leave a blank line, which readers skip; appends never interleave.
  let bytes = opts.line;
  if (opts.size > 0) {
    const last = Buffer.alloc(1);
    await opts.file.read(last, 0, 1, opts.size - 1);
    if (last[0] !== 0x0a) {
      bytes = Buffer.concat([Buffer.from("\n"), opts.line]);
    }
  }
  const { bytesWritten } = await opts.file.write(bytes, 0, bytes.byteLength);
  if (bytesWritten !== bytes.byteLength) {
    throw new Error("Short activity write");
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The most entries one read returns. */
export const ACTIVITY_READ_LIMIT_MAX = 10_000;

/**
 * Records newest first, from the current file and the kept generation.
 * Lines that are not complete, valid records (a torn last line, a line from
 * a newer schema) are skipped. Missing files read as empty.
 */
export async function readActivity(opts: {
  readonly project?: string;
  readonly limit: number;
  readonly path?: string;
  /** Tests only: runs after the current file is opened, before the kept one. */
  readonly betweenOpens?: () => Promise<void>;
}): Promise<readonly ActivityRecord[]> {
  const path = opts.path ?? resolveActivityPath();
  const [current, kept] = await openGenerations({
    path,
    betweenOpens: opts.betweenOpens,
  });
  const out: ActivityRecord[] = [];
  for (const text of [current, kept]) {
    const records = parseActivityText(text);
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i] as ActivityRecord;
      if (opts.project !== undefined && record.project !== opts.project) {
        continue;
      }
      out.push(record);
      if (out.length >= opts.limit) {
        return out;
      }
    }
  }
  return out;
}

/** Attempts before reading only the current file. */
const SNAPSHOT_ATTEMPTS = 3;

/**
 * The text of the current file and the kept generation, as one snapshot.
 * Both are opened before either is read. A rotation between the two opens
 * shows as the same file under both names; then the pair is opened again,
 * so the same records are never read twice and the replaced generation is
 * never mistaken for the kept one. If rotations keep racing, only the
 * current file is read.
 */
async function openGenerations(opts: {
  readonly path: string;
  readonly betweenOpens?: () => Promise<void>;
}): Promise<readonly [string, string]> {
  for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt += 1) {
    const current = await openPrivate(opts.path);
    let kept: PrivateFile | null = null;
    try {
      if (attempt === 1) {
        await opts.betweenOpens?.();
      }
      kept = await openPrivate(`${opts.path}.1`);
      const same =
        current !== null &&
        kept !== null &&
        current.info.dev === kept.info.dev &&
        current.info.ino === kept.info.ino;
      if (!same) {
        return [await readAll(current), await readAll(kept)];
      }
      if (attempt === SNAPSHOT_ATTEMPTS) {
        return ["", await readAll(kept)];
      }
    } finally {
      await current?.file.close();
      await kept?.file.close();
    }
  }
  return ["", ""];
}

type PrivateFile = {
  readonly file: Awaited<ReturnType<typeof open>>;
  readonly info: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>;
};

/** A regular file opened without following a link; null when absent. */
async function openPrivate(path: string): Promise<PrivateFile | null> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const info = await file.stat();
    const uid = process.getuid?.();
    if (!info.isFile() || (uid !== undefined && info.uid !== uid)) {
      throw new Error("Activity log is not this user's regular file");
    }
    return { file, info };
  } catch (error: unknown) {
    await file.close();
    throw error;
  }
}

async function readAll(opened: PrivateFile | null): Promise<string> {
  return opened ? await opened.file.readFile({ encoding: "utf8" }) : "";
}

/** Complete, valid records in file order. */
export function parseActivityText(text: string): ActivityRecord[] {
  const lines = text.split("\n");
  // The last element is "" after a final newline, or a torn partial line.
  lines.pop();
  const records: ActivityRecord[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isActivityRecord(parsed)) {
      // Only the known fields: a line edited by hand cannot add others.
      records.push({
        v: parsed.v,
        ts: parsed.ts,
        project: parsed.project,
        branch: parsed.branch,
        action: parsed.action,
        origin: parsed.origin,
        outcome: parsed.outcome,
        failed_services: [...parsed.failed_services],
        duration_ms: parsed.duration_ms,
      });
    }
  }
  return records;
}

function isActivityRecord(value: unknown): value is ActivityRecord {
  return (
    isRecord(value) &&
    value.v === ACTIVITY_SCHEMA_VERSION &&
    typeof value.ts === "string" &&
    !Number.isNaN(Date.parse(value.ts)) &&
    (value.project === null ||
      (typeof value.project === "string" && NAME.test(value.project))) &&
    (value.branch === null ||
      (typeof value.branch === "string" && NAME.test(value.branch))) &&
    (ACTIVITY_ACTIONS as readonly unknown[]).includes(value.action) &&
    (ACTIVITY_ORIGINS as readonly unknown[]).includes(value.origin) &&
    (ACTIVITY_OUTCOMES as readonly unknown[]).includes(value.outcome) &&
    Array.isArray(value.failed_services) &&
    value.failed_services.length <= FAILED_SERVICES_LIMIT &&
    value.failed_services.every(
      (name: unknown) => typeof name === "string" && SERVICE.test(name)
    ) &&
    typeof value.duration_ms === "number" &&
    Number.isFinite(value.duration_ms) &&
    value.duration_ms >= 0
  );
}

// ---------------------------------------------------------------------------
// Project name: the registered name only, never a path.
// ---------------------------------------------------------------------------

/**
 * The registered name of the project a lifecycle command targeted: the
 * project `--project` selects (canonical-name rules), otherwise the
 * registered project whose checkout, `.hack` directory or linked worktree
 * contains `--path` (or the working directory), the deepest match winning.
 * Null when none is, or when the selector is ambiguous.
 */
export async function resolveRegisteredProjectName(opts: {
  readonly cwd: string;
  readonly path?: string;
  readonly project?: string;
}): Promise<string | null> {
  const registry = await readProjectsRegistry();
  if (opts.project !== undefined) {
    // The same canonical-name rules `--project` selection uses (case and
    // `_`/space/slash aliases); the recorded name is the registry's own.
    const name = normalizeProjectName(opts.project.trim());
    return name
      ? (selectRegisteredProjectByName({ projects: registry.projects, name })
          ?.name ?? null)
      : null;
  }
  const target = resolve(opts.cwd, opts.path ?? ".");
  const spellings = new Set([target]);
  const real = await realpath(target).catch(() => null);
  if (real) {
    spellings.add(real);
  }
  let best: { readonly name: string; readonly depth: number } | null = null;
  for (const entry of registry.projects) {
    const roots = [
      entry.repoRoot,
      entry.projectDir,
      // Linked worktrees are kept beside the primary checkout.
      ...(entry.worktrees ?? []).map((worktree) => worktree.path),
    ];
    for (const root of roots) {
      const base = resolve(root);
      const inside = [...spellings].some(
        (spelling) => spelling === base || spelling.startsWith(`${base}${sep}`)
      );
      if (inside && (best === null || base.length > best.depth)) {
        best = { name: entry.name, depth: base.length };
      }
    }
  }
  return best?.name ?? null;
}
