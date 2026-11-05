import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ClosedCliError, HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  type NativeProjectRun,
  type NativeProjectRunScope,
  nativeProjectDownHookPaths,
} from "./native-project-run.ts";

/**
 * Value-free journal of a native Compose-import generation's `down.before` and
 * `down.after` hooks, kept beside the run mapping so a foreground Ctrl-C and a
 * later `hack down` neither skip nor double-run them.
 *
 * One record per project branch, replaced by compare-and-swap under a private
 * lock. It holds only the run id, a random writer generation and a state; no
 * command, environment value or output is persisted. An intent record precedes
 * every hook spawn and known completion follows the hook's exit, so a record
 * left in a `*-started` state means the hook's outcome is unknown. Unknown
 * completion is never replayed: it blocks later downs and a new generation
 * until it is inspected. Modeled by `tests/models/tla/native-foreground-down-hooks`.
 */
export type NativeDownHookState =
  | "owed"
  | "before-started"
  | "before-failed"
  | "after-owed"
  | "after-started"
  | "complete";
export type NativeDownHookRecord = {
  readonly run: string;
  readonly generation: string;
  readonly state: NativeDownHookState;
};

const KIND = "hack.native-project-down-hooks";
const HEX32 = /^[a-f0-9]{32}$/;
const LIMIT = 1024;
const LOCK_ATTEMPTS = 80;
const LOCK_DELAY_MS = 25;
/** Poll interval while another stop's `down.before` claim is in progress. */
const CLAIM_POLL_MS = 100;
const STATES: readonly NativeDownHookState[] = [
  "owed",
  "before-started",
  "before-failed",
  "after-owed",
  "after-started",
  "complete",
];

export const NATIVE_DOWN_HOOK_UNKNOWN =
  "Native down hook completion is unknown; inspect before retrying.";

function unknownCompletion(): HackCliError {
  return new HackCliError({
    code: "E_LIFECYCLE_FAILED",
    message: NATIVE_DOWN_HOOK_UNKNOWN,
  });
}
function changed(): ClosedCliError {
  return new ClosedCliError(
    "Native down hook journal is unsafe or changed; inspect native state before retrying. No hook was replayed."
  );
}
function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
function started(record: NativeDownHookRecord | null): boolean {
  return (
    record?.state === "before-started" || record?.state === "after-started"
  );
}
function same(
  left: NativeDownHookRecord | null,
  right: NativeDownHookRecord | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.run === right.run &&
      left.generation === right.generation &&
      left.state === right.state)
  );
}
function parse(value: unknown): NativeDownHookRecord {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== "generation,kind,run,state,version" ||
    value.version !== 1 ||
    value.kind !== KIND ||
    typeof value.run !== "string" ||
    !HEX32.test(value.run) ||
    typeof value.generation !== "string" ||
    !HEX32.test(value.generation) ||
    typeof value.state !== "string" ||
    !STATES.includes(value.state as NativeDownHookState)
  ) {
    throw changed();
  }
  return {
    run: value.run,
    generation: value.generation,
    state: value.state as NativeDownHookState,
  };
}
async function readRecord(path: string): Promise<NativeDownHookRecord | null> {
  let fd: Awaited<ReturnType<typeof open>>;
  try {
    fd = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    throw changed();
  }
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > LIMIT ||
      (stat.mode & 0o777) !== 0o600
    ) {
      throw changed();
    }
    const buffer = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) {
      throw changed();
    }
    try {
      return parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, bytesRead)
          )
        )
      );
    } catch {
      throw changed();
    }
  } finally {
    await fd.close();
  }
}
async function writeTemp(path: string, text: string): Promise<void> {
  const fd = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await fd.writeFile(text);
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function acquire(lock: string): Promise<void> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      return;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw changed();
      }
    }
    await Bun.sleep(LOCK_DELAY_MS);
  }
  // A concurrent writer holds it, or an interrupted one left it: never break it.
  throw changed();
}

/** Read the current record; missing storage means no record. */
export async function loadNativeDownHookRecord(
  scope: NativeProjectRunScope
): Promise<NativeDownHookRecord | null> {
  let paths: Awaited<ReturnType<typeof nativeProjectDownHookPaths>>;
  try {
    paths = await nativeProjectDownHookPaths(scope, false);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    throw changed();
  }
  return await readRecord(paths.file);
}

/**
 * Replace `expected` with `next` (null removes the record) only when the
 * current record equals `expected`. Returns false when it changed meanwhile.
 * The record and its directory are synchronized before this returns.
 */
export async function replaceNativeDownHookRecord(
  scope: NativeProjectRunScope,
  expected: NativeDownHookRecord | null,
  next: NativeDownHookRecord | null
): Promise<boolean> {
  let paths: Awaited<ReturnType<typeof nativeProjectDownHookPaths>>;
  try {
    paths = await nativeProjectDownHookPaths(scope, next !== null);
  } catch (error) {
    if (expected === null && next === null && hasCode(error, "ENOENT")) {
      return true;
    }
    throw changed();
  }
  await acquire(paths.lock);
  const temp = join(
    paths.root,
    `down-hooks-${randomBytes(16).toString("hex")}.tmp`
  );
  try {
    if (!same(await readRecord(paths.file), expected)) {
      return false;
    }
    if (next === null) {
      if (expected !== null) {
        await unlink(paths.file);
      }
    } else {
      await writeTemp(
        temp,
        JSON.stringify({
          version: 1,
          kind: KIND,
          run: next.run,
          generation: next.generation,
          state: next.state,
        })
      );
      await rename(temp, paths.file);
    }
    await syncDirectory(paths.root);
    return true;
  } catch (error) {
    if (error instanceof ClosedCliError) {
      throw error;
    }
    throw changed();
  } finally {
    await unlink(temp).catch(() => undefined);
    await rmdir(paths.lock).catch(() => undefined);
  }
}

function generation(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Up admission, after the retained run's frontend finalization is confirmed and
 * before any hook: a started (unknown) phase of an earlier generation refuses;
 * any other leftover record is superseded by this generation.
 */
export async function admitNativeDownHookGeneration(
  scope: NativeProjectRunScope
): Promise<void> {
  const current = await loadNativeDownHookRecord(scope);
  if (current === null) {
    return;
  }
  if (started(current)) {
    throw unknownCompletion();
  }
  if (!(await replaceNativeDownHookRecord(scope, current, null))) {
    throw changed();
  }
}

/** Outcome of a journaled hook phase; a crash mid-hook leaves its intent record. */
export type NativeDownHookOutcome =
  | "skipped"
  | "succeeded"
  | "failed"
  | "canceled";

/** Runs one phase's commands; resolves to the exit status after the child exited. */
export type NativeDownHookCommands = () => Promise<number>;

export type NativeForegroundDownHooks = {
  /**
   * After a successful `up.after`, as the last step before readiness is
   * published: owe the down hooks when no record exists (a concurrent
   * `hack down` may already own one). An interrupt observed by then took the
   * forced stop path, so the owe is withdrawn: Ctrl-C during `up.after` never
   * runs down hooks.
   */
  readonly owe: (interrupted: () => boolean) => Promise<void>;
  /**
   * First stop request on a ready graph, before graph cleanup. While another
   * stop (a concurrent `hack down`) holds this run's `down.before` claim, it
   * waits for that hook's settlement, so graph cleanup never overtakes it,
   * calling `waiting` once; a second interrupt (`canceled`) ends the wait and
   * forces the stop. It then claims the phase if the other stop restored it
   * after a known failure, and otherwise skips it.
   */
  readonly before: (
    commands: NativeDownHookCommands,
    canceled: () => boolean,
    waiting?: () => void
  ) => Promise<NativeDownHookOutcome>;
  /** After confirmed graph cleanup and lifecycle-process retirement. */
  readonly after: (
    commands: NativeDownHookCommands,
    canceled: () => boolean
  ) => Promise<NativeDownHookOutcome>;
};

async function journaled(opts: {
  readonly scope: NativeProjectRunScope;
  readonly claimed: NativeDownHookRecord;
  readonly commands: NativeDownHookCommands;
  readonly canceled: () => boolean;
  readonly settle: (code: number, canceled: boolean) => NativeDownHookRecord;
}): Promise<NativeDownHookOutcome> {
  let code: number;
  try {
    code = await opts.commands();
  } catch {
    // The runner throws only before a spawn or after the child exited.
    code = 1;
  }
  const canceled = opts.canceled();
  if (
    !(await replaceNativeDownHookRecord(
      opts.scope,
      opts.claimed,
      opts.settle(code, canceled)
    ))
  ) {
    throw changed();
  }
  if (canceled) {
    return "canceled";
  }
  return code === 0 ? "succeeded" : "failed";
}

/**
 * The foreground frontend's journal for one generation. Each transition is a
 * compare-and-swap on this generation's own record, so a concurrent
 * `hack down` that claimed the record wins and this frontend skips the phase
 * (after awaiting a `down.before` that is still running there).
 */
export function createNativeForegroundDownHooks(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: string;
}): NativeForegroundDownHooks {
  const own = generation();
  const record = (state: NativeDownHookState): NativeDownHookRecord => ({
    run: opts.run,
    generation: own,
    state,
  });
  if (!HEX32.test(opts.run)) {
    throw changed();
  }
  return Object.freeze({
    async owe(interrupted) {
      if (
        (await replaceNativeDownHookRecord(opts.scope, null, record("owed"))) &&
        interrupted()
      ) {
        await replaceNativeDownHookRecord(opts.scope, record("owed"), null);
      }
    },
    async before(commands, canceled, waiting) {
      const claimed = record("before-started");
      let notified = false;
      while (
        !(await replaceNativeDownHookRecord(
          opts.scope,
          record("owed"),
          claimed
        ))
      ) {
        const current = await loadNativeDownHookRecord(opts.scope);
        if (
          current?.run !== opts.run ||
          current.generation === own ||
          current.state !== "before-started"
        ) {
          // Settled (or superseded) elsewhere: never run it twice.
          return "skipped";
        }
        if (canceled()) {
          return "canceled";
        }
        if (!notified) {
          notified = true;
          waiting?.();
        }
        await Bun.sleep(CLAIM_POLL_MS);
      }
      return await journaled({
        scope: opts.scope,
        claimed,
        commands,
        canceled,
        settle: (code, interrupted) =>
          record(code === 0 && !interrupted ? "after-owed" : "before-failed"),
      });
    },
    async after(commands, canceled) {
      const claimed = record("after-started");
      if (
        !(await replaceNativeDownHookRecord(
          opts.scope,
          record("after-owed"),
          claimed
        ))
      ) {
        return "skipped";
      }
      return await journaled({
        scope: opts.scope,
        claimed,
        commands,
        canceled,
        settle: () => record("complete"),
      });
    },
  });
}

export type NativeDownHookSession = {
  /** Runs `down.before` when owed; `commands` rejects when the hook failed. */
  readonly before: (commands: () => Promise<void>) => Promise<void>;
  /** Runs `down.after` when owed; known completion is never rerun. */
  readonly after: (commands: () => Promise<void>) => Promise<void>;
};

/**
 * `hack down`'s view of the journal for the saved run. A started (unknown)
 * phase refuses before any hook. On a live graph an owed record, or no record
 * when the project declares down hooks, is claimed; a stopped graph runs only
 * what is still owed (after a frontend crash, or a down.after the frontend
 * never reached). A known `down.before` failure restores the claimed record so
 * an explicit later down may retry it, as on the Compose backend.
 */
export async function openNativeDownHookSession(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly graphStopped: boolean;
  readonly configured: boolean;
}): Promise<NativeDownHookSession> {
  const loaded = await loadNativeDownHookRecord(opts.scope);
  if (started(loaded)) {
    throw unknownCompletion();
  }
  // A record of another run is stale: it never authorizes this run's hooks.
  const current = loaded?.run === opts.run.run ? loaded : null;
  const own = generation();
  const record = (state: NativeDownHookState): NativeDownHookRecord => ({
    run: opts.run.run,
    generation: own,
    state,
  });
  const claimBefore =
    current?.state === "owed" ||
    (!opts.graphStopped && current === null && opts.configured);
  let afterFrom: NativeDownHookRecord | null =
    current?.state === "after-owed" ? current : null;
  let beforeDone = false;
  const session: NativeDownHookSession = {
    async before(commands) {
      if (!claimBefore || beforeDone) {
        return;
      }
      beforeDone = true;
      const claimed = record("before-started");
      if (!(await replaceNativeDownHookRecord(opts.scope, loaded, claimed))) {
        throw changed();
      }
      try {
        await commands();
      } catch (error) {
        if (!(await replaceNativeDownHookRecord(opts.scope, claimed, loaded))) {
          throw changed();
        }
        throw error;
      }
      const owed = record("after-owed");
      if (!(await replaceNativeDownHookRecord(opts.scope, claimed, owed))) {
        throw changed();
      }
      afterFrom = owed;
    },
    async after(commands) {
      if (afterFrom === null) {
        return;
      }
      const from = afterFrom;
      afterFrom = null;
      const claimed = record("after-started");
      if (!(await replaceNativeDownHookRecord(opts.scope, from, claimed))) {
        // The frontend finished this phase meanwhile; never run it twice.
        const now = await loadNativeDownHookRecord(opts.scope);
        if (now?.run === opts.run.run && now.state === "complete") {
          return;
        }
        throw started(now) ? unknownCompletion() : changed();
      }
      let failure: unknown;
      try {
        await commands();
      } catch (error) {
        failure = error ?? new Error("Native down after hook failed.");
      }
      // Known completion, successful or not, is final for this generation.
      if (
        !(await replaceNativeDownHookRecord(
          opts.scope,
          claimed,
          record("complete")
        ))
      ) {
        throw changed();
      }
      if (failure !== undefined) {
        throw failure;
      }
    },
  };
  return Object.freeze(session);
}

/**
 * The foreground stop's report once every cleanup completed. A canceled phase
 * (second interrupt) keeps the interrupted exit status; a failed phase is a
 * lifecycle failure, and a journal refusal surfaces unchanged.
 */
export function nativeForegroundStopFailure(opts: {
  readonly before: NativeDownHookOutcome;
  /** The after phase's outcome, or the journal refusal it raised. */
  readonly after: unknown;
}): unknown {
  if (opts.before === "failed") {
    return new HackCliError({
      code: "E_LIFECYCLE_FAILED",
      message:
        "Native down before hook failed during the foreground stop; the graph was stopped and data retained. A later down does not rerun it.",
    });
  }
  if (opts.after === "failed") {
    return new HackCliError({
      code: "E_LIFECYCLE_FAILED",
      message:
        "Native down after hook failed; native graph cleanup was confirmed and data retained.",
    });
  }
  if (
    typeof opts.after === "string" &&
    ["skipped", "succeeded", "canceled"].includes(opts.after)
  ) {
    return undefined;
  }
  return opts.after;
}
