import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  captureNativeFrontendBirth,
  isNativeFrontendBirth,
  type NativeFrontendIdentity,
  nativeFrontendGone,
} from "./native-frontend-identity.ts";
import {
  isNativeHttpsLeaseIdentity,
  type NativeHttpsLeaseIdentity,
} from "./native-https-owner.ts";
import type {
  NativeProjectRun,
  NativeProjectRunScope,
} from "./native-project-run.ts";

const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
type FinalizationIdentity = {
  readonly attempt: string;
  readonly scope: string;
  readonly run: string;
  readonly owner: string;
  readonly namespace: string;
  readonly planId: string;
};
export type NativeProjectFinalizationToken = FinalizationIdentity &
  (
    | {
        readonly version: 1;
      }
    | {
        readonly version: 2;
        /** Without a birth, only ESRCH proves exit. Birth comparisons are macOS-only. */
        readonly pid: number;
        readonly birth?: string;
        readonly httpsPort: number | null;
      }
    | {
        readonly version: 3;
        /** This frontend and its exact shared HTTPS lease must both be retired. */
        readonly pid: number;
        readonly birth?: string;
        readonly httpsPort: number;
        readonly httpsLease: NativeHttpsLeaseIdentity;
      }
  );
function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1;
}
function validPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 65_535
  );
}
function leaseMatchesRun(
  lease: NativeHttpsLeaseIdentity,
  run: NativeProjectRun
): boolean {
  return (
    lease.run === run.run &&
    lease.owner === run.owner &&
    lease.namespace === run.namespace &&
    lease.planId === run.planId
  );
}
function sameLease(
  a: NativeHttpsLeaseIdentity,
  b: NativeHttpsLeaseIdentity
): boolean {
  return (
    a.version === b.version &&
    a.ownerGeneration === b.ownerGeneration &&
    a.leaseId === b.leaseId &&
    a.run === b.run &&
    a.attempt === b.attempt &&
    a.owner === b.owner &&
    a.namespace === b.namespace &&
    a.planId === b.planId
  );
}
function validVersionFields(value: Record<string, unknown>): boolean {
  if (
    Object.hasOwn(value, "birth") &&
    (value.version === 1 || !isNativeFrontendBirth(value.birth))
  ) {
    return false;
  }
  const keys = Object.keys(value)
    .filter((key) => key !== "birth")
    .sort()
    .join();
  if (value.version === 1) {
    return keys === "attempt,namespace,owner,planId,run,scope,version";
  }
  if (value.version === 2) {
    return (
      keys ===
        "attempt,httpsPort,namespace,owner,pid,planId,run,scope,version" &&
      validPid(value.pid) &&
      (value.httpsPort === null || validPort(value.httpsPort))
    );
  }
  if (value.version !== 3) {
    return false;
  }
  const lease = value.httpsLease;
  return (
    keys ===
      "attempt,httpsLease,httpsPort,namespace,owner,pid,planId,run,scope,version" &&
    validPid(value.pid) &&
    validPort(value.httpsPort) &&
    isNativeHttpsLeaseIdentity(lease) &&
    lease.attempt === value.attempt &&
    lease.run === value.run &&
    lease.owner === value.owner &&
    lease.namespace === value.namespace &&
    lease.planId === value.planId
  );
}
export function isNativeProjectFinalizationToken(
  value: unknown
): value is NativeProjectFinalizationToken {
  return (
    isRecord(value) &&
    validVersionFields(value) &&
    [value.attempt, value.run, value.owner].every(
      (v) => typeof v === "string" && HEX32.test(v)
    ) &&
    [value.scope, value.namespace, value.planId].every(
      (v) => typeof v === "string" && HEX64.test(v)
    )
  );
}
function refused(): Error {
  return new ClosedCliError(
    "Native frontend finalization is unconfirmed or its ownership changed; no replacement owner may start."
  );
}
function same(
  a: NativeProjectFinalizationToken,
  b: NativeProjectFinalizationToken
): boolean {
  return (
    a.version === b.version &&
    (a.version === 1 ||
      (a.version === 2 &&
        b.version === 2 &&
        a.pid === b.pid &&
        a.birth === b.birth &&
        a.httpsPort === b.httpsPort) ||
      (a.version === 3 &&
        b.version === 3 &&
        a.pid === b.pid &&
        a.birth === b.birth &&
        a.httpsPort === b.httpsPort &&
        sameLease(a.httpsLease, b.httpsLease))) &&
    a.attempt === b.attempt &&
    a.scope === b.scope &&
    a.run === b.run &&
    a.owner === b.owner &&
    a.namespace === b.namespace &&
    a.planId === b.planId
  );
}
async function directory(path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") {
        throw refused();
      }
    }
  }
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw refused();
  }
}
async function selected(
  scope: NativeProjectRunScope,
  run: NativeProjectRun,
  create: boolean
) {
  if (
    !(
      HEX32.test(run.run) &&
      HEX32.test(run.owner) &&
      HEX64.test(run.namespace) &&
      HEX64.test(run.planId)
    )
  ) {
    throw refused();
  }
  const home = await realpath(scope.nativeHome);
  const identity = {
    home,
    projectRoot: await realpath(scope.projectRoot),
    projectDir: await realpath(scope.projectDir),
    branch: scope.branch,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  await directory(home, false);
  let root = home;
  for (const component of [
    ".hack-local",
    "frontend-finalization",
    hash,
    run.run,
  ]) {
    root = join(root, component);
    await directory(root, create);
  }
  return { root, hash };
}
async function read(
  path: string
): Promise<NativeProjectFinalizationToken | null> {
  const value = await readRecord(path);
  if (value === null) {
    return null;
  }
  if (!isNativeProjectFinalizationToken(value)) {
    throw refused();
  }
  return value;
}
/** One private, singly linked, bounded JSON record; absence is null. */
async function readRecord(path: string): Promise<unknown> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw refused();
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 4096
    ) {
      throw refused();
    }
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    const named = await lstat(path);
    if (
      bytesRead !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      named.dev !== stat.dev ||
      named.ino !== stat.ino ||
      named.isSymbolicLink()
    ) {
      throw refused();
    }
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}
async function write(root: string, name: string, token: unknown) {
  const temporary = join(root, `${randomBytes(16).toString("hex")}.tmp`);
  const file = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    try {
      await file.writeFile(JSON.stringify(token));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(root, name));
    const dir = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
async function locked<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(root, "operation.lock");
  await mkdir(lock, { mode: 0o700 });
  try {
    return await fn();
  } finally {
    await rmdir(lock);
  }
}
function matches(
  token: FinalizationIdentity,
  hash: string,
  run: NativeProjectRun
): boolean {
  return (
    token.scope === hash &&
    token.run === run.run &&
    token.owner === run.owner &&
    token.namespace === run.namespace &&
    token.planId === run.planId
  );
}
/** Register a fresh frontend lifetime before publishing its graph mapping. An old
 * incomplete lifetime refuses replacement, even when restoring the same graph run.
 */
export async function beginNativeProjectFinalization(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly httpsPort?: number | null;
  readonly httpsLease?: NativeHttpsLeaseIdentity;
}): Promise<{
  readonly token: NativeProjectFinalizationToken;
  readonly complete: () => Promise<void>;
}> {
  let sharedPort: number | null = null;
  if (opts.httpsLease !== undefined) {
    if (
      !(
        isNativeHttpsLeaseIdentity(opts.httpsLease) &&
        leaseMatchesRun(opts.httpsLease, opts.run) &&
        validPort(opts.httpsPort)
      )
    ) {
      throw refused();
    }
    sharedPort = opts.httpsPort;
  }
  const { root, hash } = await selected(opts.scope, opts.run, true);
  const birth = await captureNativeFrontendBirth();
  const identity = {
    scope: hash,
    run: opts.run.run,
    owner: opts.run.owner,
    namespace: opts.run.namespace,
    planId: opts.run.planId,
    pid: process.pid,
    ...(birth === undefined ? {} : { birth }),
  };
  const token: NativeProjectFinalizationToken =
    opts.httpsLease !== undefined && sharedPort !== null
      ? {
          ...identity,
          version: 3,
          attempt: opts.httpsLease.attempt,
          httpsPort: sharedPort,
          httpsLease: opts.httpsLease,
        }
      : {
          ...identity,
          version: 2,
          attempt: randomBytes(16).toString("hex"),
          httpsPort: opts.httpsPort ?? null,
        };
  if (!isNativeProjectFinalizationToken(token)) {
    throw refused();
  }
  await locked(root, async () => {
    const prior = await read(join(root, "active.json"));
    const completed = await read(join(root, "completed.json"));
    const recovered = await read(join(root, "recovered.json"));
    if (
      (prior &&
        !(
          matches(prior, hash, opts.run) &&
          ((completed && same(prior, completed)) ||
            (recovered && same(prior, recovered)))
        )) ||
      (!prior && (completed || recovered))
    ) {
      throw refused();
    }
    await write(root, "active.json", token);
  });
  return {
    token,
    complete: async () => {
      const current = await selected(opts.scope, opts.run, false);
      if (current.root !== root || current.hash !== hash) {
        throw refused();
      }
      await locked(root, async () => {
        const active = await read(join(root, "active.json"));
        if (!(active && same(active, token))) {
          throw refused();
        }
        await write(root, "completed.json", token);
      });
    },
  };
}
/** Explicit interrupted-owner recovery. A completed finalizer and a recovered
 * dead owner remain distinct durable facts. Legacy tokens require a previously
 * observed PID supplied by the operator and an additional process inventory
 * in verifyEffects; they cannot be silently upgraded to v2 identities.
 */
export async function recoverNativeProjectFinalization(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly token: NativeProjectFinalizationToken;
  readonly expectAttempt: string;
  readonly legacyPid?: number;
  readonly verifyEffects: () => Promise<void>;
  readonly isDead?: (pid: number) => boolean | Promise<boolean>;
}): Promise<void> {
  if (
    !isNativeProjectFinalizationToken(opts.token) ||
    opts.token.attempt !== opts.expectAttempt ||
    (opts.token.version === 1 && opts.legacyPid === undefined) ||
    (opts.token.version !== 1 && opts.legacyPid !== undefined)
  ) {
    throw refused();
  }
  const pid = opts.token.version === 1 ? opts.legacyPid : opts.token.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) {
    throw refused();
  }
  const { root, hash } = await selected(opts.scope, opts.run, false);
  if (!matches(opts.token, hash, opts.run)) {
    throw refused();
  }
  await locked(root, async () => {
    const active = await read(join(root, "active.json"));
    const completed = await read(join(root, "completed.json"));
    const recovered = await read(join(root, "recovered.json"));
    if (!(active && same(active, opts.token))) {
      throw refused();
    }
    if (
      (completed && same(completed, opts.token)) ||
      (recovered && same(recovered, opts.token))
    ) {
      return;
    }
    const dead = () =>
      opts.isDead
        ? opts.isDead(pid)
        : nativeFrontendGone(opts.token.version === 1 ? { pid } : opts.token);
    if (!(await dead())) {
      throw refused();
    }
    await opts.verifyEffects();
    // Recheck after asynchronous effects inspection, before durable publication.
    const current = await read(join(root, "active.json"));
    if (!(current && same(current, opts.token) && (await dead()))) {
      throw refused();
    }
    await write(root, "recovered.json", opts.token);
  });
}
/** Capture while the caller still holds the saved active mapping, before cleanup. */
export async function captureNativeProjectFinalization(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
}): Promise<NativeProjectFinalizationToken> {
  const { root, hash } = await selected(opts.scope, opts.run, false);
  const active = await read(join(root, "active.json"));
  if (!(active && matches(active, hash, opts.run))) {
    throw refused();
  }
  return active;
}
/** Completion attests only this exact frontend attempt's successful finalizers.
 * Missing/stale completion never proves shutdown. Polling has a bounded deadline.
 */
export async function waitNativeProjectFinalization(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly token: NativeProjectFinalizationToken;
  readonly timeoutMs?: number;
  /** Abandons this read-only wait; it changes no finalization state. */
  readonly signal?: AbortSignal;
  readonly isGone?: typeof nativeFrontendGone;
}): Promise<void> {
  const timeout = opts.timeoutMs ?? 150_000;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 300_000 ||
    !isNativeProjectFinalizationToken(opts.token)
  ) {
    throw refused();
  }
  const { root, hash } = await selected(opts.scope, opts.run, false);
  if (!matches(opts.token, hash, opts.run)) {
    throw refused();
  }
  const end = performance.now() + timeout;
  const acknowledged = async () => {
    const active = await read(join(root, "active.json"));
    if (!(active && same(active, opts.token))) {
      throw refused();
    }
    const completed = await read(join(root, "completed.json"));
    const recovered = await read(join(root, "recovered.json"));
    if (
      (completed && same(completed, opts.token)) ||
      (recovered && same(recovered, opts.token))
    ) {
      return true;
    }
    return false;
  };
  let nextBirthRead = 0;
  while (true) {
    if (await acknowledged()) {
      return;
    }
    if (performance.now() >= end || opts.signal?.aborted) {
      throw refused();
    }
    const inspectBirth = performance.now() >= nextBirthRead;
    if (inspectBirth) {
      nextBirthRead = performance.now() + 1000;
    }
    if (
      opts.token.version !== 1 &&
      (await (opts.isGone ?? nativeFrontendGone)(opts.token, { inspectBirth }))
    ) {
      // A clean frontend can publish completion and exit after the earlier
      // reads. Its exit is not evidence that its finalizer failed.
      if (await acknowledged()) {
        return;
      }
      throw refused();
    }
    await Bun.sleep(Math.min(100, Math.max(1, end - performance.now())));
  }
}

/**
 * What a native home's own frontend records say about one run's latest lifetime,
 * read without changing anything:
 * - `completed`: that lifetime acknowledged confirmed graph cleanup, HTTPS
 *   retirement and down hooks (a clean stop). Nothing else proves it.
 * - `live`: its frontend may still own resources. A recorded macOS birth can
 *   distinguish PID reuse; unreadable identity and legacy PID reuse remain live.
 * - `interrupted`: its frontend exited without acknowledging cleanup.
 * - `unproven`: no readable lifetime, a legacy token without a PID, or an
 *   explicitly recovered dead owner whose cleanup this record does not attest.
 */
export type NativeProjectFinalizationLifetime =
  | { readonly state: "completed"; readonly attempt: string }
  | { readonly state: "live"; readonly pid: number }
  | { readonly state: "interrupted"; readonly pid: number }
  | { readonly state: "unproven" };

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isRecord(error) && error.code === "ESRCH");
  }
}
async function frontendAlive(
  identity: NativeFrontendIdentity
): Promise<boolean> {
  return !(await nativeFrontendGone(identity));
}

/**
 * A retained startup's admission: present from just before its last run-mapping check
 * (so before any runtime effect) until it registers its own frontend lifetime. While
 * it exists, the run's latest lifetime record is not the whole truth.
 */
type FinalizationAdmission = FinalizationIdentity & {
  readonly version: 1;
  readonly pid: number;
};
const ADMISSION = "admission.json";
function isAdmission(value: unknown): value is FinalizationAdmission {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join() ===
      "attempt,namespace,owner,pid,planId,run,scope,version" &&
    value.version === 1 &&
    validPid(value.pid) &&
    [value.attempt, value.run, value.owner].every(
      (v) => typeof v === "string" && HEX32.test(v)
    ) &&
    [value.scope, value.namespace, value.planId].every(
      (v) => typeof v === "string" && HEX64.test(v)
    )
  );
}
async function readAdmission(
  root: string
): Promise<FinalizationAdmission | null> {
  const value = await readRecord(join(root, ADMISSION));
  if (value !== null && !isAdmission(value)) {
    throw refused();
  }
  return value;
}

/**
 * Admit a retained startup of `run` in this native home before its last mapping
 * check and any runtime effect. Under the run's finalization lock, so a release of
 * the mapping from another home either completed first (the caller's mapping check
 * then refuses) or sees this admission and refuses. Another live admission refuses.
 * `retire` removes only this admission: after the new lifetime is registered, or
 * when startup ends before any runtime effect. Otherwise it stays as evidence of an
 * interrupted startup until a later admission of this home replaces it.
 */
export async function admitNativeProjectFinalization(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
}): Promise<{ readonly retire: () => Promise<void> }> {
  const { root, hash } = await selected(opts.scope, opts.run, true);
  const admission: FinalizationAdmission = {
    version: 1,
    attempt: randomBytes(16).toString("hex"),
    scope: hash,
    run: opts.run.run,
    owner: opts.run.owner,
    namespace: opts.run.namespace,
    planId: opts.run.planId,
    pid: process.pid,
  };
  await locked(root, async () => {
    const prior = await readAdmission(root);
    if (prior && prior.pid !== process.pid && processExists(prior.pid)) {
      throw refused();
    }
    await write(root, ADMISSION, admission);
  });
  let retired = false;
  return {
    retire: async () => {
      if (retired) {
        return;
      }
      await locked(root, async () => {
        const current = await readAdmission(root);
        if (current?.attempt === admission.attempt) {
          await unlink(join(root, ADMISSION));
          const dir = await open(
            root,
            constants.O_RDONLY | constants.O_NOFOLLOW
          );
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        }
      });
      retired = true;
    },
  };
}

async function lifetimeIn(
  root: string,
  hash: string,
  run: NativeProjectRun,
  alive: (identity: NativeFrontendIdentity) => boolean | Promise<boolean>
): Promise<NativeProjectFinalizationLifetime> {
  const admission = await readAdmission(root);
  if (admission) {
    // A startup is (or was, until interrupted) restoring this run; its records
    // below may still describe the previous lifetime.
    if (!matches(admission, hash, run)) {
      return { state: "unproven" };
    }
    return (await alive(admission))
      ? { state: "live", pid: admission.pid }
      : { state: "interrupted", pid: admission.pid };
  }
  const active = await read(join(root, "active.json"));
  if (!(active && matches(active, hash, run))) {
    return { state: "unproven" };
  }
  const completed = await read(join(root, "completed.json"));
  if (completed && same(active, completed)) {
    return { state: "completed", attempt: active.attempt };
  }
  if (active.version === 1) {
    return { state: "unproven" };
  }
  if (await alive(active)) {
    return { state: "live", pid: active.pid };
  }
  const recovered = await read(join(root, "recovered.json"));
  return recovered && same(active, recovered)
    ? { state: "unproven" }
    : { state: "interrupted", pid: active.pid };
}

/**
 * Classify the latest frontend lifetime of `run` under `scope.nativeHome`, which may
 * be another native home than the caller's own. Unreadable or unsafe records are
 * `unproven`, never an error, so callers can always name the owning home.
 */
export async function inspectNativeProjectFinalizationLifetime(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly isAlive?: (pid: number) => boolean;
}): Promise<NativeProjectFinalizationLifetime> {
  const isAlive = opts.isAlive;
  try {
    const { root, hash } = await selected(opts.scope, opts.run, false);
    return await lifetimeIn(
      root,
      hash,
      opts.run,
      isAlive ? (identity) => isAlive(identity.pid) : frontendAlive
    );
  } catch {
    return { state: "unproven" };
  }
}

/**
 * Run `action` while holding the home's finalization operation lock for `run`, and
 * only while its latest lifetime is still the exact completed `attempt`. A frontend
 * of that home cannot begin, complete or recover a lifetime for this run meanwhile.
 */
export async function withCompletedNativeProjectFinalization<T>(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly attempt: string;
  readonly action: () => Promise<T>;
}): Promise<T> {
  if (!HEX32.test(opts.attempt)) {
    throw refused();
  }
  const { root, hash } = await selected(opts.scope, opts.run, false);
  return await locked(root, async () => {
    const lifetime = await lifetimeIn(root, hash, opts.run, frontendAlive);
    if (lifetime.state !== "completed" || lifetime.attempt !== opts.attempt) {
      throw refused();
    }
    return await opts.action();
  });
}
