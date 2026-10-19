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
 * - Starters for one helper are serialized by an exclusive lock in the
 *   caller's private state directory; only one of them may spawn.
 * - A listener is only ever adopted after its identity endpoint names the
 *   expected helper and upstream. Anything else on the port is refused and
 *   left running: this module never signals a process it cannot prove it owns.
 * - Ownership is a persisted PID plus process birth time. A claim whose PID is
 *   gone or now belongs to a different process (PID reuse) is stale and is
 *   discarded without signalling anything.
 * - A child is spawned behind an exec gate: it waits on stdin until its claim
 *   is durable. If the starter dies first, the gate reads EOF and exits, so a
 *   spawned helper is never left running without a claim.
 * - Readiness is the identity endpoint answering for the expected helper, not
 *   process liveness. Retries back off and are bounded by one deadline;
 *   cancellation stops the owned child and removes its claim.
 * - Release removes one holder. Only when no holder remains is an owned helper
 *   stopped, through its birth-verified process tree. Adopted helpers are
 *   never signalled.
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
    "The persisted shared helper claim is unreadable or belongs to another configuration; inspect and release it before retrying.",
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
  /** Claim and lock name; `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`. */
  readonly name: string;
  /** Disabled helpers take no lock, write no claim and start no child. */
  readonly enabled: boolean;
  /** Caller-owned private directory for the claim and lock. */
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
      readonly reason: Extract<
        SharedHostFailure,
        | "claim-invalid"
        | "census-unavailable"
        | "lock-unavailable"
        | "cancelled"
      >;
      readonly message: string;
    };

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
  | { readonly kind: "absent" }
  | { readonly kind: "unidentified" }
  | { readonly kind: "foreign" }
  | { readonly kind: "wrong-upstream" }
  | { readonly kind: "match"; readonly pid: number | null }
  | { readonly kind: "cancelled" };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_CLAIM_BYTES = 8192;
const MAX_IDENTITY_BYTES = 4096;
const MAX_HOLDERS = 256;
const STOP_POLL_MS = 50;
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

function failed(reason: SharedHostFailure): SharedHostEnsureResult {
  return { state: "failed", reason, message: FAILURE_MESSAGES[reason] };
}

function releaseFailed(
  reason: Extract<
    SharedHostFailure,
    "claim-invalid" | "census-unavailable" | "lock-unavailable" | "cancelled"
  >
): SharedHostReleaseResult {
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
    });
  } catch {
    return { kind: "invalid" };
  }
  if (file === null) {
    return { kind: "absent" };
  }
  if (file.text.length > MAX_CLAIM_BYTES || (file.mode & 0o077) !== 0) {
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
 * A census is usable only when it observed this process; an empty or failed
 * `ps` must never be read as "every claimed process is gone".
 */
async function readCensus(): Promise<readonly ProcessIdentityRow[] | null> {
  const rows = await readProcessIdentities();
  return rows.some((row) => row.pid === process.pid) ? rows : null;
}

function isLive(
  census: readonly ProcessIdentityRow[],
  claim: { readonly pid: number; readonly birth: string }
): boolean {
  return census.some(
    (row) => row.pid === claim.pid && row.birth === claim.birth
  );
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
  const signals = [AbortSignal.timeout(opts.timeoutMs)];
  if (opts.signal) {
    signals.push(opts.signal);
  }
  let response: Response;
  try {
    response = await fetch(`${endpointFor(opts.port)}${opts.identityPath}`, {
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
  } catch (error: unknown) {
    if (opts.signal?.aborted) {
      return { kind: "cancelled" };
    }
    // Only a refused connection proves no listener; a timeout or reset means
    // something holds the port without answering as the helper.
    return isRecord(error) && error.code === "ECONNREFUSED"
      ? { kind: "absent" }
      : { kind: "unidentified" };
  }
  const text = await readBounded(response);
  if (opts.signal?.aborted) {
    return { kind: "cancelled" };
  }
  if (response.status !== 200 || text === null) {
    return { kind: "unidentified" };
  }
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
  if (body.helper !== opts.expected.helper) {
    return { kind: "foreign" };
  }
  if (body.upstream !== opts.expected.upstream) {
    return { kind: "wrong-upstream" };
  }
  const pid =
    typeof body.pid === "number" && Number.isSafeInteger(body.pid)
      ? body.pid
      : null;
  return { kind: "match", pid };
}

/**
 * Stop a birth-verified process tree: TERM, bounded grace, then KILL for the
 * members that still carry their captured birth time. Nothing is signalled
 * when the root no longer matches its claim.
 */
export async function stopVerifiedSharedHostProcess(opts: {
  readonly pid: number;
  readonly birth: string;
  readonly graceMs: number;
}): Promise<"stopped" | "absent" | "unconfirmed" | "census-unavailable"> {
  const census = await readCensus();
  if (census === null) {
    return "census-unavailable";
  }
  if (!isLive(census, opts)) {
    return "absent";
  }
  const tree = selectProcessTree(census, opts.pid);
  const remaining = async (): Promise<ProcessIdentityRow[] | null> => {
    const live = await readCensus();
    if (live === null) {
      return null;
    }
    return tree.filter((row) => isLive(live, row));
  };
  await signalVerifiedProcessTree(tree, "SIGTERM");
  const termDeadline = performance.now() + opts.graceMs;
  let left = await remaining();
  while (left !== null && left.length > 0 && performance.now() < termDeadline) {
    await delay(STOP_POLL_MS);
    left = await remaining();
  }
  if (left !== null && left.length === 0) {
    return "stopped";
  }
  await signalVerifiedProcessTree(left ?? tree, "SIGKILL");
  const killDeadline = performance.now() + 1000;
  left = await remaining();
  while (left !== null && left.length > 0 && performance.now() < killDeadline) {
    await delay(STOP_POLL_MS);
    left = await remaining();
  }
  return left !== null && left.length === 0 ? "stopped" : "unconfirmed";
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

async function ensureLocked(
  context: EnsureContext
): Promise<SharedHostEnsureResult> {
  const { spec, holder } = context;
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
  if (read.kind === "claim") {
    const claim = read.claim;
    if (claim.port !== spec.port) {
      return failed("claim-invalid");
    }
    if (claim.ownership === "owned" && isLive(census, claim)) {
      await context.observe("claim-reused");
      const outcome = await awaitReadiness(context, claim);
      if (outcome.kind === "failed") {
        // Other holders may depend on it: a reused helper is never stopped here.
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
    if (claim.ownership === "owned") {
      // Dead or reused PID: the claim no longer proves ownership of anything.
      await context.observe("claim-stale");
    }
    carried = claim.holders;
  }

  const existing = await probeSharedHostIdentity({
    port: spec.port,
    identityPath: spec.identityPath,
    expected: spec.expected,
    timeoutMs: Math.min(spec.probeTimeoutMs, Math.max(1, remainingMs(context))),
    signal: context.signal,
  });
  switch (existing.kind) {
    case "cancelled":
      return failed("cancelled");
    case "foreign":
    case "unidentified":
      return failed("foreign-listener");
    case "wrong-upstream":
      return failed("wrong-upstream");
    case "match":
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
      break;
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
  await context.observe("spawned");
  const closeGate = () => {
    try {
      child.stdin.end();
    } catch {
      // Already closed; the gate treats EOF as "do not run".
    }
  };
  const census = await readCensus();
  const row = census?.find((entry) => entry.pid === child.pid);
  if (!row) {
    closeGate();
    return failed(census === null ? "census-unavailable" : "spawn-failed");
  }
  const owned = { pid: row.pid, birth: row.birth };
  const holders = withHolder(carried, holder);
  try {
    await writeClaim(spec, {
      version: 1,
      helper: spec.name,
      port: spec.port,
      ownership: "owned",
      phase: "starting",
      pid: owned.pid,
      birth: owned.birth,
      holders,
    });
  } catch {
    closeGate();
    return failed("claim-invalid");
  }
  await context.observe("claimed");
  if (context.signal?.aborted) {
    closeGate();
    await removeClaim(spec);
    return failed("cancelled");
  }
  try {
    child.stdin.write("open\n");
    await child.stdin.flush();
  } finally {
    closeGate();
  }
  await context.observe("gate-opened");
  const outcome = await awaitReadiness(context, owned);
  if (outcome.kind === "failed") {
    const stopped = await stopVerifiedSharedHostProcess({
      ...owned,
      graceMs: 1000,
    });
    // Keep the claim when the stop is unproven, so the process stays recorded.
    if (stopped === "stopped" || stopped === "absent") {
      await removeClaim(spec);
    }
    await context.observe("stopped-after-failure");
    return failed(outcome.reason);
  }
  await writeClaim(spec, {
    version: 1,
    helper: spec.name,
    port: spec.port,
    ownership: "owned",
    phase: "ready",
    pid: owned.pid,
    birth: owned.birth,
    holders,
  });
  await context.observe("ready");
  return {
    state: "ready",
    ownership: "owned",
    endpoint: endpointFor(spec.port),
    pid: owned.pid,
    spawned: true,
  };
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

/**
 * Make the shared helper ready for `holder`, adopting an identity-verified
 * helper, reusing the owned one, or starting it under an exact claim.
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
      await observer?.(event);
    },
    deadline: performance.now() + opts.spec.deadlineMs,
  };
  try {
    await prepareStateDir(opts.spec.stateDir);
  } catch {
    return failed("claim-invalid");
  }
  try {
    return await withProjectsRegistryLock({
      lockPath: lockPath(opts.spec),
      label: "shared host helper",
      timeoutMs: opts.spec.deadlineMs,
      signal: opts.signal,
      run: () => ensureLocked(context),
    });
  } catch (error: unknown) {
    if (isAbort(error, opts.signal)) {
      return failed("cancelled");
    }
    if (error instanceof ClaimRefusal) {
      return failed("claim-invalid");
    }
    return failed("lock-unavailable");
  }
}

/**
 * Drop `holder`. The last holder of an owned helper stops it through its
 * birth-verified tree; adopted helpers and stale claims are never signalled.
 */
export async function releaseSharedHostHelper(opts: {
  readonly spec: Pick<SharedHostHelperSpec, "name" | "stateDir">;
  readonly holder: string;
  readonly graceMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<SharedHostReleaseResult> {
  if (!NAME.test(opts.spec.name)) {
    throw new Error("Invalid shared host helper specification");
  }
  assertHolder(opts.holder);
  try {
    await prepareStateDir(opts.spec.stateDir);
  } catch {
    return releaseFailed("claim-invalid");
  }
  try {
    return await withProjectsRegistryLock({
      lockPath: lockPath(opts.spec),
      label: "shared host helper",
      timeoutMs: opts.timeoutMs ?? 10_000,
      signal: opts.signal,
      run: () => releaseLocked(opts),
    });
  } catch (error: unknown) {
    if (isAbort(error, opts.signal)) {
      return releaseFailed("cancelled");
    }
    if (error instanceof ClaimRefusal) {
      return releaseFailed("claim-invalid");
    }
    return releaseFailed("lock-unavailable");
  }
}

async function releaseLocked(opts: {
  readonly spec: Pick<SharedHostHelperSpec, "name" | "stateDir">;
  readonly holder: string;
  readonly graceMs?: number;
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
    graceMs: opts.graceMs ?? 2000,
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
