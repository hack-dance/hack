import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  keys,
  readNativeComposeHostBootId,
} from "../lib/native-compose-private-state.ts";
import { openProcessSessionInspector } from "../lib/tty-process-group.ts";
import {
  beginNativeProcessCensusPhase,
  type NativeProcessCensusDiagnostics,
} from "./native-process-census-diagnostics.ts";

const LIMIT = 4 * 1024 * 1024;
const ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([a-fA-F0-9x]+)\s+(-?\d+)\s+([A-Za-z<+?]+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;
const BIRTH =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$(?![\s\S])/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$(?![\s\S])/;
const ZERO = /^0+$/;
/** macOS ps prints `?` (optionally flagged, e.g. `?N`) while a process state is
 * momentarily undeterminable under load. Such a row is transient: it is never
 * refused as malformed, never admitted as an owner, and vetoes like a live row. */
const STATE = /^(?:[DIRSTtUWXZ]|\?)[<NXEVLsl+]*$(?![\s\S])/;
const CONTROL = /[\r\n\0]/;
const SESSION = /^(?:[a-f0-9]+|0x[a-f0-9]+)$(?![\s\S])/;
export type NativeAuthoredProcessRow = {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  /** Positive POSIX getsid result, observed independently of ps sess. */
  readonly session: string | null;
  /** `transient` is an undeterminable momentary state: possibly live, never an owner. */
  readonly state: "live" | "zombie" | "transient";
  readonly uid: number;
  readonly birth: string;
  readonly executable: string;
};
type Executable = {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
};
export type NativeAuthoredProcessIncarnation = NativeAuthoredProcessRow & {
  readonly boot: string;
  readonly platform: "darwin" | "linux";
  readonly image: Executable;
  readonly selected: Executable;
};
const issued = new WeakSet<NativeAuthoredProcessIncarnation>();
const disappearedCensuses = new WeakMap<object, number>();
const supersededCensuses = new WeakSet<object>();
export function isCapturedNativeAuthoredProcess(
  value: NativeAuthoredProcessIncarnation
): boolean {
  return issued.has(value);
}
function refused(): never {
  throw new Error(
    "Native original process identity is unknown or occupied; values omitted."
  );
}
function classify(token: string): NativeAuthoredProcessRow["state"] {
  if (token.startsWith("Z")) {
    return "zombie";
  }
  return token.startsWith("?") ? "transient" : "live";
}
function integer(value: unknown, minimum = 1): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    return refused();
  }
  return value;
}
function executable(value: unknown): Executable {
  if (
    !(isRecord(value) && keys(value, "dev,ino,path")) ||
    typeof value.path !== "string" ||
    value.path.length > 4096 ||
    CONTROL.test(value.path) ||
    !isAbsolute(value.path)
  ) {
    return refused();
  }
  for (const key of ["dev", "ino"] as const) {
    const item = value[key];
    if (
      typeof item !== "string" ||
      item.length > 32 ||
      !DECIMAL.test(item) ||
      (key === "ino" && item === "0")
    ) {
      return refused();
    }
  }
  return { path: value.path, dev: String(value.dev), ino: String(value.ino) };
}
export function parseNativeAuthoredProcessIncarnation(
  value: unknown
): NativeAuthoredProcessIncarnation {
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        "birth,boot,executable,group,image,parent,pid,platform,selected,session,state,uid"
      )
    ) ||
    (value.platform !== "darwin" && value.platform !== "linux") ||
    typeof value.boot !== "string" ||
    value.boot.length !== 36 ||
    !UUID.test(value.boot) ||
    value.boot === "00000000-0000-0000-0000-000000000000" ||
    typeof value.birth !== "string" ||
    value.birth.length > 32 ||
    !BIRTH.test(value.birth) ||
    value.state !== "live" ||
    typeof value.session !== "string" ||
    value.session.length > 32 ||
    !SESSION.test(value.session) ||
    ZERO.test(value.session) ||
    typeof value.executable !== "string" ||
    !isAbsolute(value.executable) ||
    CONTROL.test(value.executable)
  ) {
    return refused();
  }
  const result: NativeAuthoredProcessIncarnation = {
    pid: integer(value.pid),
    parent: integer(value.parent),
    group: integer(value.group),
    session: value.session,
    state: "live",
    uid: integer(value.uid, 0),
    birth: value.birth,
    executable: value.executable,
    boot: value.boot,
    platform: value.platform,
    image: executable(value.image),
    selected: executable(value.selected),
  };
  if (
    result.pid !== result.group ||
    result.image.path !== result.executable ||
    result.session !== String(result.pid)
  ) {
    return refused();
  }
  return Object.freeze(result);
}
/** Strict complete census: malformed, duplicate or truncated output is never absence.
 * A `?`-state row is admitted as transient so one momentarily undeterminable
 * foreign process cannot refuse the whole host-wide observation. */
export function parseNativeAuthoredProcessCensus(
  text: string
): readonly NativeAuthoredProcessRow[] {
  if (Buffer.byteLength(text) > LIMIT || !text.endsWith("\n")) {
    return refused();
  }
  const result: NativeAuthoredProcessRow[] = [];
  const seen = new Set<number>();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = ROW.exec(line);
    if (!match) {
      return refused();
    }
    const row = {
      pid: integer(Number(match[1])),
      parent: integer(Number(match[2]), 0),
      group: integer(Number(match[3]), 0),
      session: (match[4] ?? "").toLowerCase(),
      uid: integer(Number(match[5]), -2_147_483_648),
      state: classify(match[6] ?? ""),
      birth: (match[7] ?? "").replace(/\s+/g, " "),
      executable: match[8] ?? "",
    };
    if (
      seen.has(row.pid) ||
      !row.session ||
      !row.executable ||
      !STATE.test(match[6] ?? "")
    ) {
      return refused();
    }
    seen.add(row.pid);
    result.push(row);
  }
  if (result.length === 0) {
    return refused();
  }
  return result;
}
/** Read-only system metadata; never sends a signal to a saved PID/group. Only
 * the newly captured ps child can be canceled. Pipe/exit uncertainty refuses. */
async function readRows(
  end: number,
  denied: ReadonlySet<number> = new Set()
): Promise<{
  readonly rows: readonly NativeAuthoredProcessRow[];
  readonly probe: number;
  readonly session: number;
}> {
  const timeoutMs = Math.ceil(end - performance.now());
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
    return refused();
  }
  const sessions = { darwin: "sess", linux: "sid" };
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return refused();
  }
  const session = sessions[process.platform];
  const inspector = openProcessSessionInspector();
  let ownSession: number | null;
  try {
    ownSession = inspector.session(process.pid);
  } finally {
    inspector.close();
  }
  if (ownSession === null || performance.now() >= end) {
    return refused();
  }
  const child = Bun.spawn(
    [
      "/bin/ps",
      "-Aww",
      "-o",
      `pid=,ppid=,pgid=,${session}=,uid=,state=,lstart=,comm=`,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    }
  );
  const reader = child.stdout.getReader();
  let interrupted = false;
  const cancel = () => {
    interrupted = true;
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* This original child remains unconfirmed. */
      }
    }
    void reader.cancel().catch(() => undefined);
  };
  const read = async () => {
    const parts: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) {
        break;
      }
      total += item.value.byteLength;
      if (total > LIMIT) {
        return refused();
      }
      parts.push(item.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(parts)
    );
  };
  const output = read();
  const complete = Promise.all([output, child.exited]);
  const observed = Promise.allSettled([output, child.exited]);
  // Every continuation is handled even if a system metadata child cannot be
  // confirmed within the remaining original budget. No saved process
  // or resource authority follows that failed observation.
  void complete.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      complete,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            cancel();
            reject(new Error("Native process census expired; values omitted."));
          },
          Math.max(0, Math.ceil(end - performance.now()))
        );
      }),
    ]);
    if (interrupted || value[1] !== 0) {
      return refused();
    }
    const rows = parseNativeAuthoredProcessCensus(value[0]);
    if (rows.some((row) => denied.has(row.pid))) {
      throw new Error("Native process census PID reappeared; values omitted.");
    }
    return {
      rows,
      probe: child.pid,
      session: ownSession,
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      cancel();
    }
    let bound: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      observed.then(() => true),
      new Promise<false>((resolve) => {
        bound = setTimeout(
          () => resolve(false),
          Math.max(0, Math.min(250, Math.ceil(end - performance.now())))
        );
      }),
    ]);
    clearTimeout(bound);
    if (!settled) {
      refused();
    }
    reader.releaseLock();
  }
}

/** The original incarnation a census proves quiescent. A row that carries its
 * PID, PGID or SID is a row of interest; every other row is foreign. */
export type NativeAuthoredCensusInterest = Pick<
  NativeAuthoredProcessIncarnation,
  "pid" | "group" | "session"
>;
function sameRow(
  left: NativeAuthoredProcessRow,
  right: NativeAuthoredProcessRow
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function changedIdentity(): never {
  throw new Error("Native process census identity changed; values omitted.");
}
/** The attempt is discarded whole within budget, with no denial fact. Nothing
 * from it is ever accepted, so this cannot weaken the evidence. */
function superseded(): never {
  const failure = new Error(
    "Native process census superseded by foreign churn; values omitted."
  );
  supersededCensuses.add(failure);
  throw failure;
}
/** A live or transient row whose SID lookup failed. */
function vanished(row: NativeAuthoredProcessRow): boolean {
  return row.state !== "zombie" && row.session === null;
}
function observation(
  rows: readonly NativeAuthoredProcessRow[],
  interest: NativeAuthoredCensusInterest | undefined
): ReadonlyMap<number, NativeAuthoredProcessRow> {
  const result = new Map<number, NativeAuthoredProcessRow>();
  for (const row of rows) {
    if (vanished(row) && !unavailableForeignSession(row, interest)) {
      return refused();
    }
    const prior = result.get(row.pid);
    if (prior && !sameRow(prior, row)) {
      return changedIdentity();
    }
    result.set(row.pid, row);
  }
  return result;
}

/** Resolves the SID of a foreign row whose own SID lookup failed, at the
 * listing of the observation that holds it, or returns undefined. Only stable
 * rows are proof: the same incarnation, live or transient, with one known SID
 * that is not the original's in both observations (PID reuse already
 * supersedes the pair, so the PID alone names it here). A process changes session
 * only by `setsid`, which makes it the leader of a new session named by its own
 * PID for the rest of its life. So a stable row held its SID throughout the
 * later listing, and one whose SID is not its own PID (it never led a session)
 * held it since its birth.
 * - Group: a process group lies within one session, so a row listed in the
 *   PGID of a stable row, every known SID in that PGID agreeing, shared its
 *   SID. For the earlier listing a stable session leader proves only its own
 *   PGID: `setsid` refuses a process group leader, so it would first have had
 *   to leave the group it led. Such a row had exited before the later listing,
 *   which holds every live descendant of it.
 * - Parent: every child a stable parent that never led a session forked was
 *   born into that SID, and can leave it only for a new session of its own.
 *   Launchd (PID 1) adopts orphans and leads its own session, so it proves
 *   nothing. Residual: ptrace attachment also reparents, to the debugger. */
type ForeignSessionResolver = (
  row: NativeAuthoredProcessRow,
  side: "earlier" | "later"
) => string | undefined;
function foreignSessionResolver(
  earlier: ReadonlyMap<number, NativeAuthoredProcessRow>,
  later: ReadonlyMap<number, NativeAuthoredProcessRow>,
  interest: NativeAuthoredCensusInterest
): ForeignSessionResolver {
  const stable = new Map<number, string>();
  for (const [pid, second] of later) {
    const first = earlier.get(pid);
    if (
      first !== undefined &&
      second.state !== "zombie" &&
      first.session !== null &&
      first.session === second.session &&
      first.session !== interest.session
    ) {
      stable.set(pid, first.session);
    }
  }
  const leader = (pid: number) => stable.get(pid) === String(pid);
  const groups = (side: ReadonlyMap<number, NativeAuthoredProcessRow>) => {
    const known = new Map<number, string | null>();
    const proven = new Set<number>();
    for (const row of side.values()) {
      if (row.state === "zombie" || row.session === null) {
        continue;
      }
      const prior = known.get(row.group);
      known.set(
        row.group,
        prior === undefined || prior === row.session ? row.session : null
      );
      if (
        stable.has(row.pid) &&
        (side === later || !leader(row.pid) || row.group === row.pid)
      ) {
        proven.add(row.group);
      }
    }
    return (group: number) =>
      proven.has(group) ? (known.get(group) ?? undefined) : undefined;
  };
  const proofs = { earlier: groups(earlier), later: groups(later) };
  return (row, side) => {
    const group = proofs[side](row.group);
    if (group !== undefined) {
      return group;
    }
    return leader(row.parent) ? undefined : stable.get(row.parent);
  };
}

/** The row a pair keeps for one PID that is not a row of interest (or is seen
 * in one observation only), or undefined when it supersedes the pair. */
function settledForeignRow(opts: {
  readonly first: NativeAuthoredProcessRow | undefined;
  readonly second: NativeAuthoredProcessRow | undefined;
  readonly resolve: ForeignSessionResolver;
}): NativeAuthoredProcessRow | undefined {
  const { first, second, resolve } = opts;
  if (!(first && second)) {
    const row = first ?? second ?? refused();
    if (!vanished(row)) {
      return row;
    }
    const session = resolve(row, first ? "earlier" : "later");
    return session === undefined ? undefined : { ...row, session };
  }
  if (
    first.birth !== second.birth ||
    (second.state !== "zombie" && (vanished(first) || first.state === "zombie"))
  ) {
    return;
  }
  return vanished(second) ? { ...second, session: first.session } : second;
}

/** Two complete observations preserve every row. This is qualified
 * no-live-members evidence, never whole session absence.
 *
 * Without `interest` every PID decides: reuse, any field or state change, or a
 * zombie seen in only one observation refuses. With `interest` a PID decides
 * when any row of it, in either observation, is a row of interest; it keeps
 * exactly that strict rule, so drift, PID reuse and unstable zombies of interest
 * still refuse. A foreign PID decides nothing, since only rows of interest can
 * veto quiescence:
 * - The same incarnation (PID and birth) in both, live with a known SID or a
 *   zombie in the later one: exec, reparenting, PGID, SID, live/transient or
 *   live-to-zombie drift is ordinary host churn. The later row is kept.
 * - A foreign zombie seen in only one observation cannot execute, so it is kept
 *   and counted as an unresolved zombie.
 * - A foreign row whose SID lookup failed (macOS: it exited between `ps` and
 *   `getsid`) is never kept with an unknown SID. In the later observation it
 *   takes the SID its incarnation showed in the earlier one. Otherwise it takes
 *   the SID proven for its PGID or parent (see `foreignSessionResolver`), which
 *   is never the original's.
 * - PID reuse, a zombie turning live, a failed SID lookup followed by a live
 *   row, or an unresolved failed lookup supersedes the pair. It is never
 *   accepted; the census discards it and needs two fresh complete observations.
 * A refusal of a row of interest always wins over supersession. */
export function mergeNativeAuthoredProcessCensuses(
  before: readonly NativeAuthoredProcessRow[],
  after: readonly NativeAuthoredProcessRow[],
  interest?: NativeAuthoredCensusInterest
): readonly NativeAuthoredProcessRow[] {
  const earlier = observation(before, interest);
  const later = observation(after, interest);
  const decides = (pid: number) =>
    [earlier.get(pid), later.get(pid)].some(
      (row) =>
        row !== undefined &&
        (interest === undefined ||
          row.pid === interest.pid ||
          row.group === interest.group ||
          (row.session !== null && row.session === interest.session))
    );
  const resolve =
    interest === undefined
      ? refused
      : foreignSessionResolver(earlier, later, interest);
  const merged = new Map<number, NativeAuthoredProcessRow>();
  const unstable: number[] = [];
  let churned = false;
  for (const pid of new Set([...earlier.keys(), ...later.keys()])) {
    const first = earlier.get(pid);
    const second = later.get(pid);
    if (!(first && second) && (first ?? second)?.state === "zombie") {
      unstable.push(pid);
    }
    if (first && second && sameRow(first, second) && !vanished(second)) {
      merged.set(pid, second);
      continue;
    }
    if (first && second && decides(pid)) {
      return changedIdentity();
    }
    const kept = settledForeignRow({ first, second, resolve });
    if (kept) {
      merged.set(pid, kept);
    } else {
      churned = true;
    }
  }
  if (unstable.some(decides)) {
    return refused();
  }
  if (churned) {
    return superseded();
  }
  return [...merged.values()];
}
/** Diagnostic only: every result still refuses the failed census attempt. */
export function classifyNativeAuthoredSessionFailure(
  selected: NativeAuthoredProcessRow,
  fresh: readonly NativeAuthoredProcessRow[]
): "disappeared" | "changed" | "same-live-SID-unavailable" {
  const current = fresh.find((row) => row.pid === selected.pid);
  if (!current) {
    return "disappeared";
  }
  const identity = (row: NativeAuthoredProcessRow) => ({
    pid: row.pid,
    birth: row.birth,
    parent: row.parent,
    group: row.group,
    uid: row.uid,
    executable: row.executable,
    state: row.state,
  });
  return JSON.stringify(identity(selected)) ===
    JSON.stringify(identity(current))
    ? "same-live-SID-unavailable"
    : "changed";
}
async function unavailableSession(
  selected: NativeAuthoredProcessRow,
  end: number,
  denied: ReadonlySet<number>
): Promise<never> {
  let reason:
    | ReturnType<typeof classifyNativeAuthoredSessionFailure>
    | "unknown" = "unknown";
  try {
    const fresh = await readRows(end, denied);
    if (performance.now() < end) {
      reason = classifyNativeAuthoredSessionFailure(selected, fresh.rows);
    }
  } catch {
    // Failed/expired diagnostic observation confers no disappearance evidence.
  }
  const failure = new Error(
    `Native process live-session observation refused (${reason}); values omitted.`
  );
  if (reason === "disappeared") {
    disappearedCensuses.set(failure, selected.pid);
  }
  throw failure;
}
/** A live row whose SID lookup failed has no known session, so only its PID
 * and PGID can show it is of interest. On macOS a process that exits, or turns
 * into a zombie, between `ps` and `getsid` fails the lookup; on a busy host
 * that is ordinary churn. With `interest`, a row whose PID and PGID are both
 * foreign is therefore kept with a null SID, without a diagnostic re-listing or
 * a denial fact. The merge resolves it or supersedes the pair, and never
 * accepts an unknown SID. A row of interest, and every row of an unbounded
 * census, keeps the classified disappearance or refusal below. */
function unavailableForeignSession(
  row: NativeAuthoredProcessRow,
  interest: NativeAuthoredCensusInterest | undefined
): boolean {
  return (
    interest !== undefined &&
    row.pid !== interest.pid &&
    row.group !== interest.group
  );
}
async function sessionRows(
  end: number,
  denied: ReadonlySet<number>,
  diagnostics?: NativeProcessCensusDiagnostics,
  interest?: NativeAuthoredCensusInterest
): Promise<readonly NativeAuthoredProcessRow[]> {
  const metadata = beginNativeProcessCensusPhase({
    diagnostics,
    phase: "metadata",
  });
  let captured: Awaited<ReturnType<typeof readRows>>;
  try {
    captured = await readRows(end, denied);
    metadata?.({ outcome: "complete", rowCount: captured.rows.length });
  } catch (error) {
    metadata?.({ outcome: "refused" });
    throw error;
  }
  const { rows, probe, session } = captured;
  const sessions = beginNativeProcessCensusPhase({
    diagnostics,
    phase: "sessions",
  });
  let complete = false;
  try {
    if (process.platform === "linux") {
      if (
        rows.some(
          (row) => typeof row.session !== "string" || !DECIMAL.test(row.session)
        )
      ) {
        return refused();
      }
      complete = true;
      return rows;
    }
    const inspector = openProcessSessionInspector();
    try {
      const result: NativeAuthoredProcessRow[] = [];
      for (const row of rows) {
        if (performance.now() >= end) {
          return refused();
        }
        if (row.state === "zombie") {
          result.push({ ...row, session: null });
          continue;
        }
        const sid = row.pid === probe ? session : inspector.session(row.pid);
        if (sid === null && !unavailableForeignSession(row, interest)) {
          return await unavailableSession(row, end, denied);
        }
        result.push({ ...row, session: sid === null ? null : String(sid) });
      }
      complete = true;
      return result;
    } finally {
      inspector.close();
    }
  } finally {
    sessions?.({
      outcome: complete ? "complete" : "refused",
      rowCount: rows.length,
    });
  }
}
function mergeObservedCensuses(opts: {
  before: readonly NativeAuthoredProcessRow[];
  after: readonly NativeAuthoredProcessRow[];
  interest: NativeAuthoredCensusInterest | undefined;
  diagnostics: NativeProcessCensusDiagnostics | undefined;
}): readonly NativeAuthoredProcessRow[] {
  const merge = beginNativeProcessCensusPhase({
    diagnostics: opts.diagnostics,
    phase: "merge",
  });
  try {
    const merged = mergeNativeAuthoredProcessCensuses(
      opts.before,
      opts.after,
      opts.interest
    );
    merge?.({ outcome: "complete", rowCount: merged.length });
    return merged;
  } catch (error) {
    merge?.({ outcome: "refused" });
    throw error;
  }
}

/** Within budget, a failed attempt is discarded whole only for a pair superseded
 * by foreign churn (no denial fact) or a first positive disappearance of a PID,
 * which becomes a denial fact. Every other failure refuses the census. */
function discardable(opts: {
  readonly error: unknown;
  readonly denied: Set<number>;
  readonly end: number;
}): boolean {
  const { error, denied, end } = opts;
  if (typeof error !== "object" || error === null || performance.now() >= end) {
    return false;
  }
  if (supersededCensuses.has(error)) {
    return true;
  }
  const disappeared = disappearedCensuses.get(error);
  if (disappeared === undefined || denied.has(disappeared)) {
    return false;
  }
  denied.add(disappeared);
  return true;
}

/** Complete read-only metadata, including explicit unresolved zombie rows. The
 * second observation brackets state/identity across SID lookup. A positively
 * disappeared live row may discard an entire attempt; its successor requires
 * two new complete observations within the original monotonic budget. Only
 * disappeared PIDs survive as denial facts: any reappearance refuses. With
 * `interest`, a pair superseded by foreign churn is likewise discarded whole,
 * without a denial fact.
 * Otherwise unknown or changed membership refuses immediately.
 * No saved PID signals. */
export async function readNativeAuthoredProcessCensus(
  timeoutMs = 3000,
  opts?: {
    readonly diagnostics?: NativeProcessCensusDiagnostics;
    readonly interest?: NativeAuthoredCensusInterest;
  }
): Promise<readonly NativeAuthoredProcessRow[]> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
    return refused();
  }
  const end = performance.now() + timeoutMs;
  const census = beginNativeProcessCensusPhase({
    diagnostics: opts?.diagnostics,
    phase: "census",
  });
  let completedRows: number | undefined;
  try {
    const denied = new Set<number>();
    while (performance.now() < end) {
      try {
        const before = await sessionRows(
          end,
          denied,
          opts?.diagnostics,
          opts?.interest
        );
        const after = await sessionRows(
          end,
          denied,
          opts?.diagnostics,
          opts?.interest
        );
        if (performance.now() >= end) {
          return refused();
        }
        const merged = mergeObservedCensuses({
          before,
          after,
          interest: opts?.interest,
          diagnostics: opts?.diagnostics,
        });
        if (performance.now() >= end) {
          return refused();
        }
        completedRows = merged.length;
        return merged;
      } catch (error) {
        if (!discardable({ error, denied, end })) {
          throw error;
        }
        // Never carry rows/SIDs from the failed attempt into a successful proof.
      }
    }
    return refused();
  } finally {
    census?.({
      outcome: completedRows === undefined ? "refused" : "complete",
      rowCount: completedRows,
    });
  }
}

/** One complete census per observation. Absence refuses at once; a transient
 * row of interest is re-observed within the same monotonic budget and refuses
 * if it never settles. Foreign rows, transient or not, decide nothing here. */
async function originalRow(pid: number): Promise<NativeAuthoredProcessRow> {
  const end = performance.now() + 3000;
  while (performance.now() < end) {
    const { rows } = await readRows(end);
    const row = rows.find((item) => item.pid === pid) ?? refused();
    if (row.state === "transient") {
      continue;
    }
    const inspector = openProcessSessionInspector();
    try {
      const session = inspector.session(pid);
      if (session === null) {
        return refused();
      }
      return { ...row, session: String(session) };
    } finally {
      inspector.close();
    }
  }
  return refused();
}

async function image(path: string): Promise<Executable> {
  const canonical = await realpath(path);
  const file = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await file.stat({ bigint: true });
    const named = await lstat(canonical, { bigint: true });
    if (
      !before.isFile() ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.mode !== named.mode ||
      (before.mode & 0o022n) !== 0n
    ) {
      return refused();
    }
    return {
      path: canonical,
      dev: String(before.dev),
      ino: String(before.ino),
    };
  } finally {
    await file.close();
  }
}
/** Must be called by the original captured-child owner before input delivery. */
export async function captureNativeAuthoredProcessIncarnation(opts: {
  readonly pid: number;
  readonly selected: string;
}): Promise<NativeAuthoredProcessIncarnation> {
  const boot = await readNativeComposeHostBootId();
  const row = await originalRow(opts.pid);
  if (
    row.parent !== process.pid ||
    row.group !== row.pid ||
    row.uid !== process.getuid?.()
  ) {
    return refused();
  }
  const observed = await image(
    process.platform === "linux"
      ? await readlink(`/proc/${row.pid}/exe`)
      : row.executable
  );
  const selected = await image(opts.selected);
  const again = await originalRow(opts.pid);
  if (
    JSON.stringify(again) !== JSON.stringify(row) ||
    boot !== (await readNativeComposeHostBootId())
  ) {
    return refused();
  }
  const captured = parseNativeAuthoredProcessIncarnation({
    ...row,
    executable: observed.path,
    boot,
    platform: process.platform,
    image: observed,
    selected,
  });
  issued.add(captured);
  return captured;
}
export function requireNativeAuthoredProcessQuiescent(
  original: NativeAuthoredProcessIncarnation,
  rows: readonly NativeAuthoredProcessRow[]
): void {
  if (
    rows.some(
      (row) =>
        row.pid === original.pid ||
        (row.state !== "zombie" &&
          (row.session === null ||
            row.group === original.group ||
            row.session === original.session))
    )
  ) {
    refused();
  }
}
/** Fresh same-boot image and complete no-live-members census; no PID signals. */
export async function assertNativeAuthoredProcessQuiescent(
  original: NativeAuthoredProcessIncarnation,
  remaining: () => number,
  opts?: { readonly diagnostics?: NativeProcessCensusDiagnostics }
): Promise<{
  readonly kind: "no-live-members";
  readonly unresolvedZombies: number;
}> {
  const value = parseNativeAuthoredProcessIncarnation(original);
  if (
    value.platform !== process.platform ||
    value.uid !== process.getuid?.() ||
    value.boot !== (await readNativeComposeHostBootId()) ||
    JSON.stringify(await image(value.image.path)) !==
      JSON.stringify(value.image) ||
    JSON.stringify(await image(value.selected.path)) !==
      JSON.stringify(value.selected)
  ) {
    return refused();
  }
  const rows = await readNativeAuthoredProcessCensus(
    Math.min(3000, remaining()),
    { diagnostics: opts?.diagnostics, interest: value }
  );
  requireNativeAuthoredProcessQuiescent(value, rows);
  remaining();
  return Object.freeze({
    kind: "no-live-members",
    unresolvedZombies: rows.filter(
      (row) => row.state === "zombie" && row.session === null
    ).length,
  });
}

/** Original callback supplement only: this proves PID/PGID absence, never SID
 * absence or recovery eligibility. The original captured owner separately waits
 * for its child/streams and verifies its retained group before invoking it. */
export async function assertNativeAuthoredOriginalGroupAbsent(
  original: NativeAuthoredProcessIncarnation
): Promise<void> {
  const value = parseNativeAuthoredProcessIncarnation(original);
  if (
    !isCapturedNativeAuthoredProcess(original) ||
    value.boot !== (await readNativeComposeHostBootId())
  ) {
    return refused();
  }
  const { rows } = await readRows(performance.now() + 3000);
  if (rows.some((row) => row.pid === value.pid || row.group === value.group)) {
    return refused();
  }
}

export async function assertNativeAuthoredProcessRuntime(
  original: NativeAuthoredProcessIncarnation,
  binary: string
): Promise<void> {
  if ((await realpath(binary)) !== original.selected.path) {
    return refused();
  }
}
