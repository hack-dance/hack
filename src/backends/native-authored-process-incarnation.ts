import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  keys,
  readNativeComposeHostBootId,
} from "../lib/native-compose-private-state.ts";
import { openProcessSessionInspector } from "../lib/tty-process-group.ts";

const LIMIT = 4 * 1024 * 1024;
const ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([a-fA-F0-9x]+)\s+(-?\d+)\s+([A-Za-z<+]+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;
const BIRTH =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$(?![\s\S])/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$(?![\s\S])/;
const ZERO = /^0+$/;
const STATE = /^[DIRSTtUWXZ][<NXEVLsl+]*$(?![\s\S])/;
const CONTROL = /[\r\n\0]/;
const SESSION = /^(?:[a-f0-9]+|0x[a-f0-9]+)$(?![\s\S])/;
export type NativeAuthoredProcessRow = {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  /** Positive POSIX getsid result, observed independently of ps sess. */
  readonly session: string | null;
  readonly state: "live" | "zombie";
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
/** Strict complete census: malformed, duplicate or truncated output is never absence. */
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
      state: (match[6]?.startsWith("Z") ? "zombie" : "live") as
        | "zombie"
        | "live",
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

/** Two complete observations preserve every row. Only irreversibly nonexecuting
 * Z rows may have unavailable SID; they must retain the same identity/state in
 * both snapshots. A disappearance, reuse, new zombie or state change refuses.
 * This is qualified no-live-members evidence, never whole session absence. */
export function mergeNativeAuthoredProcessCensuses(
  before: readonly NativeAuthoredProcessRow[],
  after: readonly NativeAuthoredProcessRow[]
): readonly NativeAuthoredProcessRow[] {
  const merged = new Map<number, NativeAuthoredProcessRow>();
  for (const row of [...before, ...after]) {
    if (row.state === "live" && row.session === null) {
      return refused();
    }
    const prior = merged.get(row.pid);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
      throw new Error(
        "Native process census identity changed; values omitted."
      );
    }
    merged.set(row.pid, row);
  }
  for (const row of merged.values()) {
    if (
      row.state === "zombie" &&
      !(
        before.some((item) => JSON.stringify(item) === JSON.stringify(row)) &&
        after.some((item) => JSON.stringify(item) === JSON.stringify(row))
      )
    ) {
      return refused();
    }
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
async function sessionRows(
  end: number,
  denied: ReadonlySet<number>
): Promise<readonly NativeAuthoredProcessRow[]> {
  const { rows, probe, session } = await readRows(end, denied);
  if (process.platform === "linux") {
    if (
      rows.some(
        (row) => typeof row.session !== "string" || !DECIMAL.test(row.session)
      )
    ) {
      return refused();
    }
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
      if (sid === null) {
        return await unavailableSession(row, end, denied);
      }
      result.push({ ...row, session: String(sid) });
    }
    return result;
  } finally {
    inspector.close();
  }
}
/** Complete read-only metadata, including explicit unresolved zombie rows. The
 * second observation brackets state/identity across SID lookup. A positively
 * disappeared live row may discard an entire attempt; its successor requires
 * two new complete observations within the original monotonic budget. Only
 * disappeared PIDs survive as denial facts: any reappearance refuses. Unknown
 * or changed membership refuses immediately. No saved PID signals. */
export async function readNativeAuthoredProcessCensus(
  timeoutMs = 3000
): Promise<readonly NativeAuthoredProcessRow[]> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
    return refused();
  }
  const end = performance.now() + timeoutMs;
  const denied = new Set<number>();
  while (performance.now() < end) {
    try {
      const before = await sessionRows(end, denied);
      const after = await sessionRows(end, denied);
      if (performance.now() >= end) {
        return refused();
      }
      const merged = mergeNativeAuthoredProcessCensuses(before, after);
      if (performance.now() >= end) {
        return refused();
      }
      return merged;
    } catch (error) {
      const disappeared =
        typeof error === "object" && error !== null
          ? disappearedCensuses.get(error)
          : undefined;
      if (
        disappeared === undefined ||
        denied.has(disappeared) ||
        performance.now() >= end
      ) {
        throw error;
      }
      denied.add(disappeared);
      // Never carry rows/SIDs from the failed attempt into a successful proof.
    }
  }
  return refused();
}

async function originalRow(pid: number): Promise<NativeAuthoredProcessRow> {
  const { rows } = await readRows(performance.now() + 3000);
  const row = rows.find((item) => item.pid === pid) ?? refused();
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
        (row.state === "live" &&
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
  remaining: () => number
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
    Math.min(3000, remaining())
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
