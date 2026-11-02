import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./guards.ts";
import {
  readReplaceablePrivateFile,
  replacePrivateFileAtomic,
} from "./private-file.ts";
import {
  type ProcessIdentityRow,
  readProcessIdentities,
  selectProcessTree,
  signalVerifiedProcessTree,
} from "./process-tree.ts";
import { inspectListeningTcpPorts } from "./project-lifecycle-singleton.ts";
import { withProjectsRegistryLock } from "./projects-registry-lock.ts";

/**
 * Ownership-safe lifecycle for one shared host helper: a long-lived local
 * process (proxy, tunnel, issuer bridge) that several branches or clients use
 * through one fixed loopback port.
 *
 * Contract (see docs/reference/shared-host-lifecycle.md):
 * - Ownership is `owned` (Hack started it and holds an exact process claim),
 *   `adopted` (an identity-verified helper someone else started) or `disabled`
 *   (no lock, no claim, no child). Phases are `starting`, `ready` and `failed`.
 * - Starters for one helper are serialized by an exclusive lock next to its
 *   claim; only one of them may spawn. Every client of one helper port must
 *   therefore use the same `stateDir` and `name` (see
 *   {@link SharedHostHelperSpec.stateDir}).
 * - A listener is only ever adopted after its identity endpoint names the
 *   expected helper and upstream. Anything else on the port is refused and
 *   left running: this module never signals a process it cannot prove it owns.
 * - Ownership is a persisted PID plus process birth time (`ps lstart`, read in
 *   UTC so clients with different time zones agree). A claim whose PID is
 *   gone, an unreaped zombie, or now belongs to a different process (PID
 *   reuse) is stale and is discarded without signalling anything. A stale
 *   claim whose PID still answers as the helper is uncertain: it is kept,
 *   never adopted.
 * - A child is spawned behind an exec gate: it waits on stdin until its claim
 *   is durable. If the starter dies first, the gate reads EOF and exits, so a
 *   spawned helper is never left running without a claim.
 * - Readiness is the identity endpoint answering for the expected helper, not
 *   process liveness. Retries back off and are bounded by one deadline that
 *   also covers the lock wait; cancellation stops the owned child and removes
 *   its claim. A `starting` claim found under the lock has lost its starter;
 *   if that helper still cannot become ready, it is stopped.
 * - Release removes one holder. Only when no holder remains is an owned helper
 *   stopped, through its birth-verified process tree. Adopted helpers are
 *   never signalled.
 * - `stopped` means the exit of every member of the captured tree was
 *   observed within one bounded wait: TERM grace, then
 *   {@link SHARED_HOST_KILL_CONFIRM_MS} after KILL. Exit is observed when the
 *   PID is gone from the census or is a zombie (exited, not yet reaped).
 *   Anything still running under that PID, even with a different birth time,
 *   is not exit. When the wait ends without that proof, the result is
 *   `stop-unconfirmed` and the claim is kept.
 *
 * Diagnostics are closed: every failure is one of {@link SharedHostFailure}
 * with a fixed message that never includes paths, argv, env or response
 * bodies.
 */

export type SharedHostOwnership = "owned" | "adopted" | "disabled";
export type SharedHostPhase = "starting" | "ready" | "failed";

export type SharedHostFailure =
  | "foreign-listener"
  | "wrong-upstream"
  | "claim-invalid"
  | "state-unavailable"
  | "census-unavailable"
  | "lock-unavailable"
  | "port-probe-failed"
  | "spawn-failed"
  | "child-exited"
  | "deadline"
  | "cancelled";

const FAILURE_MESSAGES: Readonly<Record<SharedHostFailure, string>> = {
  "foreign-listener":
    "The shared helper port is held by a process that is not the expected helper; it was left running.",
  "wrong-upstream":
    "The shared helper on this port serves a different upstream; it was left running.",
  "claim-invalid":
    "The persisted shared helper claim is unreadable, uncertain or belongs to another configuration; inspect and release it before retrying.",
  "state-unavailable":
    "The shared helper state directory could not be read or written.",
  "census-unavailable":
    "The process census is unavailable, so helper ownership cannot be verified.",
  "lock-unavailable":
    "Another starter holds the shared helper lock beyond the deadline.",
  "port-probe-failed": "The shared helper port could not be inspected.",
  "spawn-failed": "The shared helper could not be started.",
  "child-exited": "The shared helper exited before it became ready.",
  deadline: "The shared helper did not become ready before the deadline.",
  cancelled: "Shared helper startup was cancelled.",
};

/** Fixed, value-free message for a closed failure reason. */
export function sharedHostFailureMessage(reason: SharedHostFailure): string {
  return FAILURE_MESSAGES[reason];
}

/** Identity a helper must report at its identity endpoint. */
export type SharedHostIdentity = {
  /** Stable helper kind, for example `issuer-bridge`. */
  readonly helper: string;
  /** The upstream this branch requires the helper to serve. */
  readonly upstream: string;
};

export type SharedHostHelperSpec = {
  /**
   * Claim and lock name; `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`. Every client of
   * one helper port must use the same name (see {@link stateDir}).
   */
  readonly name: string;
  /** Disabled helpers take no lock, write no claim and start no child. */
  readonly enabled: boolean;
  /**
   * Private (owner-only) directory that holds this helper's claim and lock.
   *
   * It is shared, not per caller: every branch or client that uses the helper
   * on `port` must pass the same `stateDir` and `name`. The claim and lock are
   * the only coordination between clients, and nothing here can see a claim in
   * another directory. A client with a different `stateDir` or `name` takes a
   * different lock and finds no claim. If the running owned helper answers its
   * identity check, that client adopts it, so the owner's last release stops a
   * helper this client still holds, and their starts are not serialized.
   * Derive both values from the helper and its port, never from the branch.
   */
  readonly stateDir: string;
  /** Loopback port the helper serves. */
  readonly port: number;
  /** Absolute path of the JSON identity endpoint, for example `/__hack/identity`. */
  readonly identityPath: string;
  readonly expected: SharedHostIdentity;
  /** Helper argv; executed directly, never through a shell string. */
  readonly command: readonly string[];
  readonly cwd: string;
  /** Complete child environment. The runner environment is never inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** One bound for lock wait, spawn and readiness. */
  readonly deadlineMs: number;
  readonly backoff: { readonly initialMs: number; readonly maxMs: number };
  /** Per-request bound for one identity probe. */
  readonly probeTimeoutMs: number;
};

export type SharedHostEnsureResult =
  | { readonly state: "disabled"; readonly ownership: "disabled" }
  | {
      readonly state: "ready";
      readonly ownership: "owned" | "adopted";
      readonly endpoint: string;
      /** Present for owned helpers only. */
      readonly pid?: number;
      readonly spawned: boolean;
    }
  | {
      readonly state: "failed";
      readonly reason: SharedHostFailure;
      readonly message: string;
    };

/** Closed progress events. The observer is awaited (a test and UI seam). */
export type SharedHostEvent =
  | "lock-waiting"
  | "lock-acquired"
  | "claim-stale"
  | "claim-reused"
  | "adopted"
  | "spawned"
  | "claimed"
  | "gate-opened"
  | "probe-retry"
  | "ready"
  | "stopped-after-failure";

export type SharedHostReleaseResult =
  | {
      readonly state:
        | "absent"
        | "retained"
        | "released-adopted"
        | "stale-cleared"
        | "stopped"
        | "stop-unconfirmed";
    }
  | {
      readonly state: "failed";
      readonly reason: ReleaseFailure;
      readonly message: string;
    };

type ReleaseFailure = Extract<
  SharedHostFailure,
  | "claim-invalid"
  | "state-unavailable"
  | "census-unavailable"
  | "lock-unavailable"
  | "cancelled"
>;

type OwnedClaim = {
  readonly version: 1;
  readonly helper: string;
  readonly port: number;
  readonly ownership: "owned";
  readonly phase: "starting" | "ready";
  readonly pid: number;
  readonly birth: string;
  readonly holders: readonly string[];
};
type AdoptedClaim = {
  readonly version: 1;
  readonly helper: string;
  readonly port: number;
  readonly ownership: "adopted";
  readonly holders: readonly string[];
};
type Claim = OwnedClaim | AdoptedClaim;

type ProbeObservation =
  /** The connection failed (refused, reset or unreachable). */
  | { readonly kind: "no-answer" }
  | { readonly kind: "unidentified" }
  /** The listener did not answer within this probe's own timeout. */
  | { readonly kind: "timeout" }
  | { readonly kind: "foreign" }
  | { readonly kind: "wrong-upstream" }
  | { readonly kind: "match"; readonly pid: number | null }
  | { readonly kind: "cancelled" };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_CLAIM_BYTES = 8192;
const MAX_IDENTITY_BYTES = 4096;
const MAX_HOLDERS = 256;
const STOP_POLL_MS = 50;
/** TERM grace used by {@link releaseSharedHostHelper} when `graceMs` is omitted. */
export const SHARED_HOST_RELEASE_GRACE_MS = 2000;
/** TERM grace used when a start fails and Hack stops the helper it started. */
const FAILED_START_GRACE_MS = 1000;
/**
 * How long a stop waits, after KILL, to observe the exit of every member of
 * the captured tree before it reports `unconfirmed`. The whole stop is bounded
 * by the TERM grace plus this wait (plus one census per poll).
 */
export const SHARED_HOST_KILL_CONFIRM_MS = 1000;
/**
 * Exec gate: the helper argv runs only after the starter writes `open`. EOF
 * (starter lost before its claim was durable) exits without running it. `exec`
 * keeps the PID and birth time recorded in the claim.
 */
const GATE_SCRIPT =
  'IFS= read -r hack_gate || exit 0; [ "$hack_gate" = open ] || exit 0; exec "$@" </dev/null';

class ClaimRefusal extends Error {
  constructor() {
    super(FAILURE_MESSAGES["claim-invalid"]);
  }
}

/** Carries an error thrown by the caller's observer; it is rethrown as is. */
class ObserverError extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super("shared host observer failed");
    this.original = original;
  }
}

/**
 * Wraps an error thrown while the helper lock is held, so it is never
 * reported as a lock acquisition failure.
 */
class LockedRunError extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super("shared host locked operation failed");
    this.original = original;
  }
}

async function runLocked<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    throw new LockedRunError(error);
  }
}

function failed(reason: SharedHostFailure): SharedHostEnsureResult {
  return { state: "failed", reason, message: FAILURE_MESSAGES[reason] };
}

function releaseFailed(reason: ReleaseFailure): SharedHostReleaseResult {
  return { state: "failed", reason, message: FAILURE_MESSAGES[reason] };
}

function assertSpec(spec: SharedHostHelperSpec): void {
  const valid =
    NAME.test(spec.name) &&
    Number.isInteger(spec.port) &&
    spec.port > 0 &&
    spec.port <= 65_535 &&
    spec.identityPath.startsWith("/") &&
    spec.command.length > 0 &&
    spec.deadlineMs > 0 &&
    spec.probeTimeoutMs > 0 &&
    spec.backoff.initialMs > 0 &&
    spec.backoff.maxMs >= spec.backoff.initialMs;
  if (!valid) {
    throw new Error("Invalid shared host helper specification");
  }
}

function assertHolder(holder: string): void {
  if (!NAME.test(holder)) {
    throw new Error("Invalid shared host helper holder");
  }
}

function claimPath(spec: Pick<SharedHostHelperSpec, "name" | "stateDir">) {
  return join(spec.stateDir, `${spec.name}.claim.json`);
}

function lockPath(spec: Pick<SharedHostHelperSpec, "name" | "stateDir">) {
  return join(spec.stateDir, `${spec.name}.lock`);
}

function endpointFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function parseHolders(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > MAX_HOLDERS ||
    !value.every((entry) => typeof entry === "string" && NAME.test(entry)) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return value as string[];
}

/** Strict v1 claim parser; any other shape is an uncertain receipt. */
export function parseSharedHostClaim(text: string): Claim | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  const holders = parseHolders(value.holders);
  const port = value.port;
  if (
    holders === null ||
    typeof value.helper !== "string" ||
    !NAME.test(value.helper) ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65_535
  ) {
    return null;
  }
  if (value.ownership === "adopted") {
    return exactKeys(value, [
      "version",
      "helper",
      "port",
      "ownership",
      "holders",
    ])
      ? {
          version: 1,
          helper: value.helper,
          port,
          ownership: "adopted",
          holders,
        }
      : null;
  }
  const pid = value.pid;
  if (
    value.ownership !== "owned" ||
    !exactKeys(value, [
      "version",
      "helper",
      "port",
      "ownership",
      "phase",
      "pid",
      "birth",
      "holders",
    ]) ||
    (value.phase !== "starting" && value.phase !== "ready") ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    typeof value.birth !== "string" ||
    value.birth.length === 0 ||
    value.birth.length > 64
  ) {
    return null;
  }
  return {
    version: 1,
    helper: value.helper,
    port,
    ownership: "owned",
    phase: value.phase,
    pid,
    birth: value.birth,
    holders,
  };
}

type ClaimRead =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "claim"; readonly claim: Claim };

async function readClaim(
  spec: Pick<SharedHostHelperSpec, "name" | "stateDir">
): Promise<ClaimRead> {
  let file: Awaited<ReturnType<typeof readReplaceablePrivateFile>>;
  try {
    file = await readReplaceablePrivateFile({
      path: claimPath(spec),
      directories: [spec.stateDir],
      refusal: () => new ClaimRefusal(),
      maxBytes: MAX_CLAIM_BYTES,
    });
  } catch {
    return { kind: "invalid" };
  }
  if (file === null) {
    return { kind: "absent" };
  }
  // Only an owner-only receipt is trusted; group/world access makes it uncertain.
  if ((file.mode & 0o077) !== 0) {
    return { kind: "invalid" };
  }
  const claim = parseSharedHostClaim(file.text);
  if (claim === null || claim.helper !== spec.name) {
    return { kind: "invalid" };
  }
  return { kind: "claim", claim };
}

async function writeClaim(
  spec: Pick<SharedHostHelperSpec, "name" | "stateDir">,
  claim: Claim
): Promise<void> {
  await replacePrivateFileAtomic({
    path: claimPath(spec),
    directories: [spec.stateDir],
    refusal: () => new ClaimRefusal(),
    text: `${JSON.stringify(claim)}\n`,
  });
}

async function removeClaim(
  spec: Pick<SharedHostHelperSpec, "name" | "stateDir">
): Promise<void> {
  try {
    await unlink(claimPath(spec));
  } catch (error: unknown) {
    if (!(isRecord(error) && error.code === "ENOENT")) {
      throw error;
    }
  }
}

/**
 * The process census and signal boundary. Production callers omit it and get
 * {@link systemProcesses}; tests replace it to simulate states real processes
 * cannot produce portably, such as a process that stays in the census after
 * SIGKILL.
 */
export type SharedHostProcesses = {
  /** Every process row, including zombies; `[]` when `ps` failed. */
  readonly census: () => Promise<readonly ProcessIdentityRow[]>;
  /** Signal the members of a captured tree that still carry their birth. */
  readonly signalTree: (
    tree: readonly ProcessIdentityRow[],
    signal: NodeJS.Signals
  ) => Promise<void>;
};

const systemProcesses: SharedHostProcesses = {
  census: readProcessIdentities,
  signalTree: signalVerifiedProcessTree,
};

/**
 * A census is usable only when it observed this process; an empty or failed
 * `ps` must never be read as "every claimed process is gone".
 *
 * Zombies are left out: an exited process that its parent has not reaped yet
 * runs no code, holds no listener or open file, and cannot be stopped any
 * further. Its PID cannot be reused until it is reaped, so treating it as
 * exited can never confuse it with another process. Counting it as live would
 * report a finished stop as unconfirmed, and would make a `ready` claim whose
 * helper crashed under a suspended (for example Ctrl-Z) starter look live, so
 * no other client could restart that helper until the starter resumed.
 */
async function readCensus(
  processes: SharedHostProcesses = systemProcesses
): Promise<readonly ProcessIdentityRow[] | null> {
  const rows = await processes.census();
  if (!rows.some((row) => row.pid === process.pid)) {
    return null;
  }
  return rows.filter((row) => !row.zombie);
}

/**
 * The liveness rule for a claimed process: the census shows this exact PID
 * and birth, and the row is not a zombie. A zombie has exited (see
 * {@link readCensus}), so it never counts as running. This is the one
 * predicate Hack and its fixtures use, so a Linux zombie waiting for a slow
 * reaper reads the same way everywhere.
 */
export function isSharedHostProcessRunning(
  census: readonly ProcessIdentityRow[],
  identity: { readonly pid: number; readonly birth: string }
): boolean {
  return census.some(
    (row) =>
      row.pid === identity.pid && row.birth === identity.birth && !row.zombie
  );
}

const isLive = isSharedHostProcessRunning;

/**
 * Exit of a signalled tree member is observed only when its PID is gone from
 * the census or is a zombie. The same PID running with another birth time is
 * not proof: Linux `lstart` can drift with the wall clock, so it may be the
 * same process. PID reuse inside one stop wait is not plausible, so this
 * costs nothing but an honest `unconfirmed` in that case.
 */
function exitObserved(
  census: readonly ProcessIdentityRow[],
  member: ProcessIdentityRow
): boolean {
  return !census.some((row) => row.pid === member.pid && !row.zombie);
}

async function readBounded(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_IDENTITY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks)
    );
  } catch {
    return null;
  }
}

/** Classify the listener on the helper port by its identity endpoint. */
export async function probeSharedHostIdentity(opts: {
  readonly port: number;
  readonly identityPath: string;
  readonly expected: SharedHostIdentity;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ProbeObservation> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signals = [timeout];
  if (opts.signal) {
    signals.push(opts.signal);
  }
  let response: Response;
  try {
    response = await fetch(`${endpointFor(opts.port)}${opts.identityPath}`, {
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
  } catch {
    if (opts.signal?.aborted) {
      return { kind: "cancelled" };
    }
    if (timeout.aborted) {
      return { kind: "timeout" };
    }
    // The refused-connection error code differs by platform and runtime, so a
    // transport error alone never proves absence: the caller confirms it with
    // a loopback bind probe before spawning.
    return { kind: "no-answer" };
  }
  const text = await readBounded(response);
  if (opts.signal?.aborted) {
    return { kind: "cancelled" };
  }
  if (text === null && timeout.aborted) {
    return { kind: "timeout" };
  }
  if (response.status !== 200 || text === null) {
    return { kind: "unidentified" };
  }
  return classifyIdentity(text, opts.expected);
}

function classifyIdentity(
  text: string,
  expected: SharedHostIdentity
): ProbeObservation {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "unidentified" };
  }
  if (
    !isRecord(body) ||
    typeof body.helper !== "string" ||
    typeof body.upstream !== "string"
  ) {
    return { kind: "unidentified" };
  }
  if (body.helper !== expected.helper) {
    return { kind: "foreign" };
  }
  if (body.upstream !== expected.upstream) {
    return { kind: "wrong-upstream" };
  }
  const pid =
    typeof body.pid === "number" && Number.isSafeInteger(body.pid)
      ? body.pid
      : null;
  return { kind: "match", pid };
}

/**
 * Stop a birth-verified process tree: TERM, `graceMs` to observe every
 * member's exit, then KILL for the members still running (each signal
 * re-checks the birth time) and {@link SHARED_HOST_KILL_CONFIRM_MS} more.
 * Nothing is signalled when the root no longer matches its claim.
 *
 * `stopped` is returned only after a census observed every member exited
 * (see {@link exitObserved}); a zombie counts as exited, a running PID never
 * does. A census that fails during the wait proves nothing, so polling goes
 * on until the deadline. Otherwise the result is `unconfirmed`.
 */
export async function stopVerifiedSharedHostProcess(opts: {
  readonly pid: number;
  readonly birth: string;
  readonly graceMs: number;
  readonly processes?: SharedHostProcesses;
}): Promise<"stopped" | "absent" | "unconfirmed" | "census-unavailable"> {
  const processes = opts.processes ?? systemProcesses;
  const census = await readCensus(processes);
  if (census === null) {
    return "census-unavailable";
  }
  if (!isLive(census, opts)) {
    return "absent";
  }
  const tree = selectProcessTree(census, opts.pid);
  const remaining = async (): Promise<ProcessIdentityRow[] | null> => {
    const live = await readCensus(processes);
    if (live === null) {
      return null;
    }
    return tree.filter((row) => !exitObserved(live, row));
  };
  const awaitExit = async (waitMs: number) => {
    const deadline = performance.now() + waitMs;
    let left = await remaining();
    while ((left === null || left.length > 0) && performance.now() < deadline) {
      await delay(STOP_POLL_MS);
      left = await remaining();
    }
    return left;
  };
  await processes.signalTree(tree, "SIGTERM");
  const afterTerm = await awaitExit(opts.graceMs);
  if (afterTerm !== null && afterTerm.length === 0) {
    return "stopped";
  }
  await processes.signalTree(afterTerm ?? tree, "SIGKILL");
  const afterKill = await awaitExit(SHARED_HOST_KILL_CONFIRM_MS);
  return afterKill !== null && afterKill.length === 0
    ? "stopped"
    : "unconfirmed";
}

function withHolder(holders: readonly string[], holder: string): string[] {
  return holders.includes(holder) ? [...holders] : [...holders, holder];
}

type EnsureContext = {
  readonly spec: SharedHostHelperSpec;
  readonly holder: string;
  readonly signal?: AbortSignal;
  readonly observe: (event: SharedHostEvent) => Promise<void>;
  readonly deadline: number;
};

function remainingMs(context: EnsureContext): number {
  return context.deadline - performance.now();
}

type ReadinessOutcome =
  | { readonly kind: "ready" }
  | {
      readonly kind: "failed";
      readonly reason: Extract<
        SharedHostFailure,
        | "foreign-listener"
        | "wrong-upstream"
        | "child-exited"
        | "deadline"
        | "cancelled"
        | "census-unavailable"
      >;
    };

/**
 * Probe until the identity endpoint answers for the expected helper and, when
 * it reports a PID, for the owned process. Liveness alone is never readiness.
 */
async function awaitReadiness(
  context: EnsureContext,
  owned: { readonly pid: number; readonly birth: string }
): Promise<ReadinessOutcome> {
  const { spec } = context;
  let wait = spec.backoff.initialMs;
  while (true) {
    if (context.signal?.aborted) {
      return { kind: "failed", reason: "cancelled" };
    }
    const census = await readCensus();
    if (census === null) {
      return { kind: "failed", reason: "census-unavailable" };
    }
    if (!isLive(census, owned)) {
      return { kind: "failed", reason: "child-exited" };
    }
    const left = remainingMs(context);
    if (left <= 0) {
      return { kind: "failed", reason: "deadline" };
    }
    const probe = await probeSharedHostIdentity({
      port: spec.port,
      identityPath: spec.identityPath,
      expected: spec.expected,
      timeoutMs: Math.min(spec.probeTimeoutMs, left),
      signal: context.signal,
    });
    switch (probe.kind) {
      case "cancelled":
        return { kind: "failed", reason: "cancelled" };
      case "wrong-upstream":
        return { kind: "failed", reason: "wrong-upstream" };
      case "foreign":
        return { kind: "failed", reason: "foreign-listener" };
      case "match":
        if (probe.pid === null || probe.pid === owned.pid) {
          return { kind: "ready" };
        }
        return { kind: "failed", reason: "foreign-listener" };
      default:
        break;
    }
    const sleep = Math.min(wait, remainingMs(context));
    if (sleep <= 0) {
      return { kind: "failed", reason: "deadline" };
    }
    await context.observe("probe-retry");
    try {
      await delay(sleep, undefined, { signal: context.signal });
    } catch {
      return { kind: "failed", reason: "cancelled" };
    }
    wait = Math.min(wait * 2, spec.backoff.maxMs);
  }
}

type OwnedIdentity = { readonly pid: number; readonly birth: string };

/**
 * Readiness failures after which an owned helper that never reached `ready` is
 * stopped. `cancelled` and `census-unavailable` leave it recorded instead: a
 * cancelled caller or a blind census is not evidence that the start failed.
 */
const ABANDONED_START_FAILURES: ReadonlySet<SharedHostFailure> = new Set([
  "child-exited",
  "deadline",
  "foreign-listener",
  "wrong-upstream",
]);

/**
 * Stop an owned helper whose start failed and forget its claim. When the stop
 * cannot be confirmed the claim is kept, so the process stays recorded.
 */
async function stopFailedStart(opts: {
  readonly context: EnsureContext;
  readonly owned: OwnedIdentity;
  readonly notify: boolean;
}): Promise<void> {
  const stopped = await stopVerifiedSharedHostProcess({
    ...opts.owned,
    graceMs: FAILED_START_GRACE_MS,
  });
  if (stopped === "stopped" || stopped === "absent") {
    await removeClaim(opts.context.spec);
  }
  if (opts.notify) {
    await opts.context.observe("stopped-after-failure");
  }
}

/**
 * Reuse a live owned helper. A `ready` helper may serve other holders, so a
 * failed readiness check never stops it. A `starting` claim seen under the
 * lock has no live starter (a starter holds the lock until its helper is
 * ready or stopped), so a helper that still cannot become ready is an
 * abandoned start and is stopped through its birth-verified tree.
 */
async function reuseOwned(
  context: EnsureContext,
  claim: OwnedClaim
): Promise<SharedHostEnsureResult> {
  const { spec, holder } = context;
  await context.observe("claim-reused");
  const outcome = await awaitReadiness(context, claim);
  if (outcome.kind === "failed") {
    if (
      claim.phase === "starting" &&
      ABANDONED_START_FAILURES.has(outcome.reason)
    ) {
      await stopFailedStart({ context, owned: claim, notify: true });
    }
    return failed(outcome.reason);
  }
  await writeClaim(spec, {
    ...claim,
    phase: "ready",
    holders: withHolder(claim.holders, holder),
  });
  await context.observe("ready");
  return {
    state: "ready",
    ownership: "owned",
    endpoint: endpointFor(spec.port),
    pid: claim.pid,
    spawned: false,
  };
}

async function ensureLocked(
  context: EnsureContext
): Promise<SharedHostEnsureResult> {
  const { spec } = context;
  await context.observe("lock-acquired");
  const census = await readCensus();
  if (census === null) {
    return failed("census-unavailable");
  }
  const read = await readClaim(spec);
  if (read.kind === "invalid") {
    return failed("claim-invalid");
  }
  let carried: readonly string[] = [];
  let staleOwned: OwnedClaim | null = null;
  if (read.kind === "claim") {
    const claim = read.claim;
    if (claim.port !== spec.port) {
      return failed("claim-invalid");
    }
    if (claim.ownership === "owned" && isLive(census, claim)) {
      return await reuseOwned(context, claim);
    }
    if (claim.ownership === "owned") {
      // Dead or reused PID: the claim no longer proves ownership of anything.
      await context.observe("claim-stale");
      staleOwned = claim;
    }
    carried = claim.holders;
  }
  const settled = await adoptOrRefuse(context, { carried, staleOwned });
  if (settled !== null) {
    return settled;
  }
  try {
    const occupied = await inspectListeningTcpPorts({ ports: [spec.port] });
    if (occupied.length > 0) {
      return failed("foreign-listener");
    }
  } catch {
    return failed("port-probe-failed");
  }
  if (read.kind === "claim") {
    await removeClaim(spec);
  }
  return await spawnOwned(context, carried);
}

/**
 * Probe the helper port when no live owned claim exists. Returns the final
 * result (adopted, refused, deadline or cancelled), or null when nothing
 * answers and the caller may spawn.
 */
async function adoptOrRefuse(
  context: EnsureContext,
  prior: {
    readonly carried: readonly string[];
    readonly staleOwned: OwnedClaim | null;
  }
): Promise<SharedHostEnsureResult | null> {
  const { spec, holder } = context;
  const { carried, staleOwned } = prior;
  // The lock wait shares the deadline; never start a probe after it passed.
  const left = remainingMs(context);
  if (left <= 0) {
    return failed("deadline");
  }
  const cutByDeadline = left < spec.probeTimeoutMs;
  const existing = await probeSharedHostIdentity({
    port: spec.port,
    identityPath: spec.identityPath,
    expected: spec.expected,
    timeoutMs: cutByDeadline ? left : spec.probeTimeoutMs,
    signal: context.signal,
  });
  switch (existing.kind) {
    case "cancelled":
      return failed("cancelled");
    case "timeout":
      // A probe cut short by the deadline proves nothing about the listener;
      // one that used its full timeout met a listener that does not answer.
      return failed(cutByDeadline ? "deadline" : "foreign-listener");
    case "unidentified":
    case "foreign":
      return failed("foreign-listener");
    case "wrong-upstream":
      return failed("wrong-upstream");
    case "match":
      if (staleOwned !== null && existing.pid === staleOwned.pid) {
        // The claimed PID answers as the helper, but its birth no longer
        // matches: ownership is uncertain. Adopting it would drop the owned
        // record (and a later release would leak the helper); stopping it
        // could signal a stranger. Keep the claim and fail closed.
        return failed("claim-invalid");
      }
      await writeClaim(spec, {
        version: 1,
        helper: spec.name,
        port: spec.port,
        ownership: "adopted",
        holders: withHolder(carried, holder),
      });
      await context.observe("adopted");
      return {
        state: "ready",
        ownership: "adopted",
        endpoint: endpointFor(spec.port),
        spawned: false,
      };
    default:
      return null;
  }
}

async function spawnOwned(
  context: EnsureContext,
  carried: readonly string[]
): Promise<SharedHostEnsureResult> {
  const { spec, holder } = context;
  let child: Bun.Subprocess<"pipe", "ignore", "ignore">;
  try {
    child = Bun.spawn(
      ["/bin/sh", "-c", GATE_SCRIPT, "hack-shared-host-gate", ...spec.command],
      {
        cwd: spec.cwd,
        env: { ...spec.env },
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
        // A new session keeps terminal signals for the starter away from a
        // helper that other branches share.
        detached: true,
      }
    );
  } catch {
    return failed("spawn-failed");
  }
  child.unref();
  const closeGate = () => {
    try {
      child.stdin.end();
    } catch {
      // Already closed; the gate treats EOF as "do not run".
    }
  };
  let owned: OwnedIdentity | null = null;
  let gateOpened = false;
  try {
    await context.observe("spawned");
    const census = await readCensus();
    const row = census?.find((entry) => entry.pid === child.pid);
    if (!row) {
      closeGate();
      return failed(census === null ? "census-unavailable" : "spawn-failed");
    }
    const identity: OwnedIdentity = { pid: row.pid, birth: row.birth };
    const holders = withHolder(carried, holder);
    await writeClaim(spec, {
      version: 1,
      helper: spec.name,
      port: spec.port,
      ownership: "owned",
      phase: "starting",
      pid: identity.pid,
      birth: identity.birth,
      holders,
    });
    owned = identity;
    await context.observe("claimed");
    if (context.signal?.aborted) {
      closeGate();
      await removeClaim(spec);
      return failed("cancelled");
    }
    gateOpened = true;
    try {
      child.stdin.write("open\n");
      await child.stdin.flush();
    } catch {
      // The gate died before it could run the helper.
      closeGate();
      await stopFailedStart({ context, owned: identity, notify: false });
      return failed("spawn-failed");
    }
    closeGate();
    await context.observe("gate-opened");
    const outcome = await awaitReadiness(context, identity);
    if (outcome.kind === "failed") {
      await stopFailedStart({ context, owned: identity, notify: true });
      return failed(outcome.reason);
    }
    await writeClaim(spec, {
      version: 1,
      helper: spec.name,
      port: spec.port,
      ownership: "owned",
      phase: "ready",
      pid: identity.pid,
      birth: identity.birth,
      holders,
    });
    await context.observe("ready");
    return {
      state: "ready",
      ownership: "owned",
      endpoint: endpointFor(spec.port),
      pid: identity.pid,
      spawned: true,
    };
  } catch (error: unknown) {
    // An observer or a state write failed. Never leave a gate waiting while
    // this starter lives, nor a running helper the caller was not handed.
    closeGate();
    if (owned !== null) {
      const recorded = owned;
      await (gateOpened
        ? stopFailedStart({ context, owned: recorded, notify: false })
        : removeClaim(spec)
      ).catch(() => undefined);
    }
    throw error;
  }
}

async function prepareStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function hasErrorCode(error: unknown): boolean {
  return isRecord(error) && typeof error.code === "string";
}

/**
 * Map an error to a closed reason. A caller's observer error is rethrown
 * unchanged; errors raised while the lock is held are never `lock-unavailable`.
 */
function classifyFailure(
  error: unknown,
  signal: AbortSignal | undefined
): ReleaseFailure {
  if (error instanceof ObserverError) {
    throw error.original;
  }
  if (error instanceof LockedRunError) {
    const inner = error.original;
    if (inner instanceof ObserverError) {
      throw inner.original;
    }
    if (inner instanceof ClaimRefusal) {
      return "claim-invalid";
    }
    return isAbort(inner, signal) ? "cancelled" : "state-unavailable";
  }
  if (isAbort(error, signal)) {
    return "cancelled";
  }
  // The lock times out with a plain error; a filesystem error carries a code.
  return hasErrorCode(error) ? "state-unavailable" : "lock-unavailable";
}

/**
 * Make the shared helper ready for `holder`, adopting an identity-verified
 * helper, reusing the owned one, or starting it under an exact claim.
 *
 * An error thrown by `observe` propagates unchanged after cleanup: a gate that
 * has not opened is closed and its claim removed, and a helper started by this
 * call is stopped. A holder recorded before the error stays recorded.
 */
export async function ensureSharedHostHelper(opts: {
  readonly spec: SharedHostHelperSpec;
  readonly holder: string;
  readonly signal?: AbortSignal;
  readonly observe?: (event: SharedHostEvent) => void | Promise<void>;
}): Promise<SharedHostEnsureResult> {
  assertSpec(opts.spec);
  assertHolder(opts.holder);
  if (!opts.spec.enabled) {
    return { state: "disabled", ownership: "disabled" };
  }
  if (opts.signal?.aborted) {
    return failed("cancelled");
  }
  const observer = opts.observe;
  const context: EnsureContext = {
    spec: opts.spec,
    holder: opts.holder,
    signal: opts.signal,
    observe: async (event) => {
      try {
        await observer?.(event);
      } catch (error: unknown) {
        throw new ObserverError(error);
      }
    },
    deadline: performance.now() + opts.spec.deadlineMs,
  };
  try {
    await prepareStateDir(opts.spec.stateDir);
  } catch {
    return failed("state-unavailable");
  }
  try {
    await context.observe("lock-waiting");
    return await withProjectsRegistryLock({
      lockPath: lockPath(opts.spec),
      label: "shared host helper",
      timeoutMs: opts.spec.deadlineMs,
      signal: opts.signal,
      run: () => runLocked(() => ensureLocked(context)),
    });
  } catch (error: unknown) {
    return failed(classifyFailure(error, opts.signal));
  }
}

/**
 * Drop `holder`. The last holder of an owned helper stops it through its
 * birth-verified tree; adopted helpers and stale claims are never signalled.
 * Releasing a holder that is not recorded changes nothing and reports
 * `retained` while other holders remain.
 */
export async function releaseSharedHostHelper(opts: {
  readonly spec: Pick<SharedHostHelperSpec, "name" | "stateDir">;
  readonly holder: string;
  readonly graceMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Test seam for the census and signals; production callers omit it. */
  readonly processes?: SharedHostProcesses;
}): Promise<SharedHostReleaseResult> {
  if (!NAME.test(opts.spec.name)) {
    throw new Error("Invalid shared host helper specification");
  }
  assertHolder(opts.holder);
  try {
    await prepareStateDir(opts.spec.stateDir);
  } catch {
    return releaseFailed("state-unavailable");
  }
  try {
    return await withProjectsRegistryLock({
      lockPath: lockPath(opts.spec),
      label: "shared host helper",
      timeoutMs: opts.timeoutMs ?? 10_000,
      signal: opts.signal,
      run: () => runLocked(() => releaseLocked(opts)),
    });
  } catch (error: unknown) {
    return releaseFailed(classifyFailure(error, opts.signal));
  }
}

async function releaseLocked(opts: {
  readonly spec: Pick<SharedHostHelperSpec, "name" | "stateDir">;
  readonly holder: string;
  readonly graceMs?: number;
  readonly processes?: SharedHostProcesses;
}): Promise<SharedHostReleaseResult> {
  const read = await readClaim(opts.spec);
  if (read.kind === "absent") {
    return { state: "absent" };
  }
  if (read.kind === "invalid") {
    return releaseFailed("claim-invalid");
  }
  const claim = read.claim;
  const holders = claim.holders.filter((entry) => entry !== opts.holder);
  if (holders.length > 0) {
    await writeClaim(opts.spec, { ...claim, holders });
    return { state: "retained" };
  }
  if (claim.ownership === "adopted") {
    await removeClaim(opts.spec);
    return { state: "released-adopted" };
  }
  const stopped = await stopVerifiedSharedHostProcess({
    pid: claim.pid,
    birth: claim.birth,
    graceMs: opts.graceMs ?? SHARED_HOST_RELEASE_GRACE_MS,
    processes: opts.processes,
  });
  switch (stopped) {
    case "census-unavailable":
      return releaseFailed("census-unavailable");
    case "unconfirmed":
      await writeClaim(opts.spec, { ...claim, holders });
      return { state: "stop-unconfirmed" };
    case "absent":
      await removeClaim(opts.spec);
      return { state: "stale-cleared" };
    default:
      await removeClaim(opts.spec);
      return { state: "stopped" };
  }
}
