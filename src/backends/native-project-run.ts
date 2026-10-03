import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  isNativeProjectFinalizationToken,
  type NativeProjectFinalizationToken,
} from "./native-project-finalization.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const LIMIT = 8192;
const RECOVERY_SCHEMA = "hack.native-project-run-filesystem-recovery/v1";
// Equivalent to normalizeEnvConfigName(value) === value, with a bounded length.
const ENV_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AWS_PROFILE = /^[A-Za-z0-9_+=,.@-]{1,128}$/;
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const CONTROL = /[\x00-\x1f\x7f]/;
export type NativeProjectRun = {
  readonly run: string;
  readonly owner: string;
  readonly namespace: string;
  readonly planId: string;
  /** Absent in legacy mappings; null explicitly selects base-only values. */
  readonly effectiveEnvName?: string | null;
  /** Exact selected Compose profiles; absent legacy mappings must not guess. */
  readonly profiles?: readonly string[];
  /** Public startup selector only; null means no AWS adaptation. Never credentials. */
  readonly aws?: { readonly profile: string; readonly region?: string } | null;
};
export type NativeProjectRunScope = {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly nativeHome: string;
  readonly branch: string | null;
};
function refused(): Error {
  return new Error(
    "Native project run mapping is unsafe, changed, or owned by another run; inspect native state before recovery."
  );
}
function validAws(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      ["profile", "profile,region"].includes(
        Object.keys(value).sort().join()
      ) &&
      typeof value.profile === "string" &&
      AWS_PROFILE.test(value.profile) &&
      (!Object.hasOwn(value, "region") ||
        (typeof value.region === "string" &&
          value.region.length <= 64 &&
          AWS_REGION.test(value.region))))
  );
}
export function normalizeNativeProfiles(
  profiles: readonly string[] = []
): string[] {
  if (
    profiles.length > 64 ||
    Buffer.byteLength(JSON.stringify(profiles)) > 4096 ||
    profiles.some(
      (profile) =>
        typeof profile !== "string" ||
        !profile ||
        Buffer.byteLength(profile) > 256 ||
        CONTROL.test(profile)
    )
  ) {
    throw new Error(
      "Native profiles require at most 64 bounded nonempty names."
    );
  }
  return [...new Set(profiles)].sort();
}
function validProfiles(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  try {
    return (
      JSON.stringify(normalizeNativeProfiles(value)) === JSON.stringify(value)
    );
  } catch {
    return false;
  }
}
function valid(value: unknown): value is NativeProjectRun {
  return (
    isRecord(value) &&
    [
      "namespace,owner,planId,run",
      "effectiveEnvName,namespace,owner,planId,run",
      "aws,effectiveEnvName,namespace,owner,planId,run",
      "aws,effectiveEnvName,namespace,owner,planId,profiles,run",
    ].includes(Object.keys(value).sort().join()) &&
    (!Object.hasOwn(value, "aws") || validAws(value.aws)) &&
    (!Object.hasOwn(value, "profiles") || validProfiles(value.profiles)) &&
    (!Object.hasOwn(value, "effectiveEnvName") ||
      value.effectiveEnvName === null ||
      (typeof value.effectiveEnvName === "string" &&
        value.effectiveEnvName.length <= 128 &&
        ENV_NAME.test(value.effectiveEnvName))) &&
    typeof value.run === "string" &&
    HEX32.test(value.run) &&
    typeof value.owner === "string" &&
    HEX32.test(value.owner) &&
    typeof value.namespace === "string" &&
    HEX64.test(value.namespace) &&
    typeof value.planId === "string" &&
    HEX64.test(value.planId)
  );
}
async function directory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw refused();
  }
  return { dev: info.dev, ino: info.ino };
}
async function scope(opts: NativeProjectRunScope) {
  if (
    opts.branch !== null &&
    (!opts.branch || opts.branch.length > 256 || CONTROL.test(opts.branch))
  ) {
    throw refused();
  }
  const projectRoot = await realpath(opts.projectRoot);
  await directory(opts.projectDir);
  const projectDir = await realpath(opts.projectDir);
  const child = relative(projectRoot, projectDir);
  if (child !== ".hack" && child !== ".dev") {
    throw refused();
  }
  const nativeHome = await realpath(opts.nativeHome);
  return {
    projectRoot,
    projectDir,
    nativeHome,
    branch: opts.branch,
    rootIdentity: await directory(projectRoot),
    dirIdentity: await directory(projectDir),
    homeIdentity: await directory(nativeHome),
  };
}
async function read(path: string): Promise<unknown> {
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > LIMIT ||
      (stat.mode & 0o777) !== 0o600
    ) {
      throw refused();
    }
    const buffer = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size || bytesRead > LIMIT) {
      throw refused();
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead)
      )
    ) as unknown;
  } finally {
    await fd.close();
  }
}
async function write(path: string, value: string) {
  const fd = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await fd.writeFile(value);
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function sync(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function verifyIgnore(ignore: string) {
  const fd = await open(
    ignore,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size !== 2) {
      throw refused();
    }
    const bytes = Buffer.alloc(3);
    const result = await fd.read(bytes, 0, 3, 0);
    if (result.bytesRead !== 2 || bytes.subarray(0, 2).toString() !== "*\n") {
      throw refused();
    }
  } finally {
    await fd.close();
  }
}
async function paths(
  opts: NativeProjectRunScope,
  create: boolean,
  kind: "run" | "restart" = "run"
) {
  const identity = await scope(opts);
  const internal = join(identity.projectDir, ".internal");
  const root = join(internal, "native-runs");
  for (const path of [internal, root]) {
    if (create) {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") {
          throw error;
        }
      }
    }
    await directory(path);
  }
  const ignore = join(root, ".gitignore");
  if (create) {
    try {
      await write(ignore, "*\n");
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  try {
    await verifyIgnore(ignore);
  } catch {
    throw refused();
  }
  const key = createHash("sha256")
    .update(JSON.stringify(identity.branch))
    .digest("hex");
  const suffix = kind === "restart" ? ".restart" : "";
  return {
    identity,
    root,
    file: join(root, `${key}${suffix}.json`),
    lock: join(root, `${key}${suffix}.lock`),
  };
}

export type NativeRestartIntent = {
  readonly phase: "prepared" | "cleaned";
  readonly run: NativeProjectRun;
  readonly finalization: NativeProjectFinalizationToken;
};
/** Serialize cleanup and replacement hooks; uncertain abandoned ownership requires inspection. */
export async function withNativeRestartLock<T>(
  opts: NativeProjectRunScope,
  action: (release: () => Promise<void>) => Promise<T>
): Promise<T> {
  const p = await paths(opts, true, "restart");
  const lock = `${p.lock}.operation`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      "Native restart is already owned or was interrupted; inspect the pending restart before recovery."
    );
  }
  let released = false;
  const release = async () => {
    if (!released) {
      await rmdir(lock);
      released = true;
    }
  };
  try {
    return await action(release);
  } finally {
    await release();
  }
}
function restartRecord(value: unknown, identity: unknown): NativeRestartIntent {
  if (
    !(
      isRecord(value) && isNativeProjectFinalizationToken(value.finalization)
    ) ||
    (value.phase !== "prepared" && value.phase !== "cleaned")
  ) {
    throw refused();
  }
  const run = record(value, identity);
  const finalization = value.finalization;
  if (
    run.run !== finalization.run ||
    run.owner !== finalization.owner ||
    run.namespace !== finalization.namespace ||
    run.planId !== finalization.planId
  ) {
    throw refused();
  }
  return { phase: value.phase, run, finalization };
}
/** Persist the selected old owner before cleanup so a failed restart never falls back to fresh data. */
export async function saveNativeRestartIntent(
  opts: NativeProjectRunScope & { readonly intent: NativeRestartIntent }
): Promise<void> {
  const p = await paths(opts, true, "restart");
  const value = { version: 1, scope: p.identity, ...opts.intent };
  restartRecord(value, p.identity);
  await mkdir(p.lock, { mode: 0o700 });
  const temp = join(p.root, `${randomUUID()}.tmp`);
  try {
    await write(temp, JSON.stringify(value));
    await link(temp, p.file);
    await unlink(temp);
    await sync(p.root);
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
    await rmdir(p.lock);
  }
}
export async function loadNativeRestartIntent(
  opts: NativeProjectRunScope
): Promise<NativeRestartIntent | null> {
  await scope(opts);
  try {
    const p = await paths(opts, false, "restart");
    return restartRecord(await read(p.file), p.identity);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw refused();
  }
}
/** Only readiness from the exact replacement may retire its pending restart intent. */
export async function removeNativeRestartIntent(
  opts: NativeProjectRunScope & { readonly expected: NativeRestartIntent }
): Promise<void> {
  const p = await paths(opts, false, "restart");
  await mkdir(p.lock, { mode: 0o700 });
  try {
    const current = restartRecord(await read(p.file), p.identity);
    if (JSON.stringify(current) !== JSON.stringify(opts.expected)) {
      throw refused();
    }
    await unlink(p.file);
    await sync(p.root);
  } finally {
    await rmdir(p.lock);
  }
}
function record(value: unknown, identity: unknown): NativeProjectRun {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    JSON.stringify(value.scope) !== JSON.stringify(identity) ||
    !valid(value.run)
  ) {
    throw refused();
  }
  return value.run;
}

type DirectoryIdentity = { readonly dev: number; readonly ino: number };
type RunScopeIdentity = Awaited<ReturnType<typeof scope>>;
type RecoveryPaths = Awaited<ReturnType<typeof paths>>;

export type NativeProjectRunFilesystemInspection = {
  readonly schema: typeof RECOVERY_SCHEMA;
  readonly selectionSha256: string;
  readonly mappingSha256: string;
  readonly run: NativeProjectRun;
  readonly oldDevice: number;
  readonly newDevice: number;
  readonly qualification: "explicit-legacy-rebind-original-volume-continuity-unproven";
};

export type NativeProjectRunFilesystemRecovery =
  NativeProjectRunFilesystemInspection & {
    readonly repaired: true;
    readonly auditPath: string;
  };

function sameIdentity(
  value: unknown,
  expected: DirectoryIdentity,
  oldDevice: number
): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join() === "dev,ino" &&
    typeof value.dev === "number" &&
    Number.isSafeInteger(value.dev) &&
    value.dev === oldDevice &&
    value.ino === expected.ino
  );
}

async function readRecoveryFile(path: string): Promise<{
  bytes: Buffer;
  value: unknown;
  identity: DirectoryIdentity;
}> {
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const before = await fd.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > LIMIT ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600
    ) {
      throw refused();
    }
    const bytes = Buffer.alloc(before.size);
    const result = await fd.read(bytes, 0, bytes.length, 0);
    const after = await fd.stat();
    const named = await lstat(path);
    if (
      result.bytesRead !== bytes.length ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      after.nlink !== 1 ||
      after.uid !== process.getuid?.() ||
      (after.mode & 0o777) !== 0o600
    ) {
      throw refused();
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    return { bytes, value, identity: { dev: after.dev, ino: after.ino } };
  } finally {
    await fd.close();
  }
}

async function preserveRecoveryAudit(
  path: string,
  expected: string
): Promise<void> {
  const limit = LIMIT * 2 + 4096;
  if (Buffer.byteLength(expected) > limit) {
    throw refused();
  }
  try {
    await write(path, expected);
    return;
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const before = await fd.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size !== Buffer.byteLength(expected) ||
      before.size > limit
    ) {
      throw refused();
    }
    const bytes = Buffer.alloc(before.size);
    const read = await fd.read(bytes, 0, bytes.length, 0);
    const after = await fd.stat();
    const named = await lstat(path);
    if (
      read.bytesRead !== bytes.length ||
      !bytes.equals(Buffer.from(expected)) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      !named.isFile() ||
      named.nlink !== 1
    ) {
      throw refused();
    }
  } finally {
    await fd.close();
  }
}

function oldMapping(
  value: unknown,
  current: RunScopeIdentity
): {
  readonly oldDevice: number;
  readonly run: NativeProjectRun;
  readonly next: string;
} {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== "run,scope,version" ||
    value.version !== 1 ||
    !valid(value.run) ||
    !isRecord(value.scope) ||
    Object.keys(value.scope).sort().join() !==
      "branch,dirIdentity,homeIdentity,nativeHome,projectDir,projectRoot,rootIdentity"
  ) {
    throw refused();
  }
  const stored = value.scope;
  const oldRoot = stored.rootIdentity;
  if (
    !isRecord(oldRoot) ||
    typeof oldRoot.dev !== "number" ||
    !Number.isSafeInteger(oldRoot.dev) ||
    oldRoot.dev <= 0
  ) {
    throw refused();
  }
  const oldDevice = oldRoot.dev;
  if (
    oldDevice === current.rootIdentity.dev ||
    current.rootIdentity.dev !== current.dirIdentity.dev ||
    current.rootIdentity.dev !== current.homeIdentity.dev ||
    stored.projectRoot !== current.projectRoot ||
    stored.projectDir !== current.projectDir ||
    stored.nativeHome !== current.nativeHome ||
    stored.branch !== current.branch ||
    !sameIdentity(oldRoot, current.rootIdentity, oldDevice) ||
    !sameIdentity(stored.dirIdentity, current.dirIdentity, oldDevice) ||
    !sameIdentity(stored.homeIdentity, current.homeIdentity, oldDevice)
  ) {
    throw refused();
  }
  const next = JSON.stringify({ ...value, scope: current });
  if (
    Buffer.byteLength(next) > LIMIT ||
    JSON.stringify(value.run) !== JSON.stringify(JSON.parse(next).run)
  ) {
    throw refused();
  }
  return { oldDevice, run: value.run, next };
}

async function absentPath(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw refused();
  }
  throw refused();
}

async function recoveryLocksAbsent(p: RecoveryPaths): Promise<void> {
  const restartFile = `${p.file.slice(0, -5)}.restart.json`;
  const restartLock = `${p.lock.slice(0, -5)}.restart.lock`;
  await Promise.all([
    absentPath(p.lock),
    absentPath(`${p.lock}.operation`),
    absentPath(restartFile),
    absentPath(restartLock),
    absentPath(`${restartLock}.operation`),
  ]);
}

async function recoveryDirectories(p: RecoveryPaths): Promise<void> {
  for (const path of [
    p.identity.projectRoot,
    p.identity.projectDir,
    p.identity.nativeHome,
    join(p.identity.projectDir, ".internal"),
    p.root,
  ]) {
    const metadata = await lstat(path);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o022) !== 0 ||
      (path === p.root && (metadata.mode & 0o777) !== 0o700)
    ) {
      throw refused();
    }
  }
}

async function heldDirectory(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await fd.stat();
    if (
      !metadata.isDirectory() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      throw refused();
    }
    const verify = async () => {
      const named = await lstat(path);
      const held = await fd.stat();
      if (
        !named.isDirectory() ||
        named.isSymbolicLink() ||
        named.dev !== metadata.dev ||
        named.ino !== metadata.ino ||
        held.dev !== metadata.dev ||
        held.ino !== metadata.ino ||
        named.uid !== metadata.uid ||
        (named.mode & 0o777) !== 0o700
      ) {
        throw refused();
      }
    };
    await verify();
    return { verify, close: () => fd.close() };
  } catch (error) {
    await fd.close();
    throw error;
  }
}

async function releaseHeldDirectory(
  path: string,
  held: Awaited<ReturnType<typeof heldDirectory>>
) {
  try {
    await held.verify();
    await rmdir(path);
  } finally {
    await held.close();
  }
}

async function verifySelectedMappingPath(
  path: string,
  selected: Buffer,
  identity: DirectoryIdentity
): Promise<() => Promise<void>> {
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const before = await fd.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size !== selected.length ||
      before.dev !== identity.dev ||
      before.ino !== identity.ino
    ) {
      throw refused();
    }
    const bytes = Buffer.alloc(selected.length);
    const read = await fd.read(bytes, 0, bytes.length, 0);
    const after = await fd.stat();
    const named = await lstat(path);
    if (
      read.bytesRead !== bytes.length ||
      !bytes.equals(selected) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      named.nlink !== 1 ||
      named.uid !== process.getuid?.() ||
      (named.mode & 0o777) !== 0o600
    ) {
      throw refused();
    }
    return () => fd.close();
  } catch (error) {
    await fd.close();
    throw error;
  }
}

async function nativeRecoveryAuthority(opts: {
  readonly p: RecoveryPaths;
  readonly run: NativeProjectRun;
  readonly oldDevice: number;
  readonly runtime: NativeRuntimeSelection;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<void> {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const [graph, status] = await Promise.all([
    inspectNativeProjectGraph({
      runtime: opts.runtime,
      projectRoot: opts.p.identity.projectRoot,
      run: opts.run.run,
      invoke,
    }),
    invoke({
      runtime: opts.runtime,
      cwd: opts.p.identity.projectRoot,
      args: ["runtime", "status", "--json"],
      timeoutMs: 30_000,
    }),
  ]);
  const receipt = isRecord(graph) ? graph.receipt : undefined;
  const source = isRecord(receipt) ? receipt.source : undefined;
  const shared = isRecord(source) ? source.shared : undefined;
  const share = isRecord(status) ? status.project_share : undefined;
  if (
    !isRecord(graph) ||
    graph.journal_incomplete !== false ||
    !isRecord(receipt) ||
    receipt.run !== opts.run.run ||
    receipt.owner !== opts.run.owner ||
    receipt.namespace !== opts.run.namespace ||
    receipt.plan_id !== opts.run.planId ||
    !["ready-observed", "stopped-data-retained"].includes(
      String(receipt.phase)
    ) ||
    !isRecord(status) ||
    status.phase !== "running" ||
    status.process_alive !== true ||
    status.persistent_disks_identified !== true ||
    !isRecord(share) ||
    share.project !== opts.p.identity.projectRoot ||
    share.device !== opts.p.identity.rootIdentity.dev ||
    share.inode !== opts.p.identity.rootIdentity.ino ||
    share.unfiltered_source !== true ||
    !isRecord(shared) ||
    shared.project !== share.project ||
    shared.guest_path !== share.guest_path ||
    shared.inode !== share.inode ||
    shared.device !== opts.oldDevice ||
    shared.unfiltered_source !== true
  ) {
    throw refused();
  }
}

async function recoverySelection(opts: {
  readonly scope: NativeProjectRunScope;
  readonly runtime: NativeRuntimeSelection;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly heldLocks?: boolean;
}): Promise<{
  readonly inspection: NativeProjectRunFilesystemInspection;
  readonly p: RecoveryPaths;
  readonly bytes: Buffer;
  readonly fileIdentity: DirectoryIdentity;
  readonly next: string;
}> {
  const p = await paths(opts.scope, false);
  await recoveryDirectories(p);
  if (!opts.heldLocks) {
    await recoveryLocksAbsent(p);
  }
  const { bytes, value, identity } = await readRecoveryFile(p.file);
  const mapping = oldMapping(value, p.identity);
  await nativeRecoveryAuthority({
    p,
    run: mapping.run,
    oldDevice: mapping.oldDevice,
    runtime: opts.runtime,
    invoke: opts.invoke,
  });
  const mappingSha256 = createHash("sha256").update(bytes).digest("hex");
  const selected = {
    schema: RECOVERY_SCHEMA,
    mappingSha256,
    fileIdentity: identity,
    scope: p.identity,
    oldDevice: mapping.oldDevice,
    run: mapping.run,
  };
  const inspection: NativeProjectRunFilesystemInspection = {
    schema: RECOVERY_SCHEMA,
    selectionSha256: createHash("sha256")
      .update(JSON.stringify(selected))
      .digest("hex"),
    mappingSha256,
    run: mapping.run,
    oldDevice: mapping.oldDevice,
    newDevice: p.identity.rootIdentity.dev,
    qualification: "explicit-legacy-rebind-original-volume-continuity-unproven",
  };
  return { inspection, p, bytes, fileIdentity: identity, next: mapping.next };
}

/** Inspect an exact legacy device renumbering without changing frontend or native state. */
export async function inspectNativeProjectRunFilesystemRecovery(opts: {
  readonly scope: NativeProjectRunScope;
  readonly runtime: NativeRuntimeSelection;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<NativeProjectRunFilesystemInspection> {
  return (await recoverySelection(opts)).inspection;
}

/** Explicitly rebind only three mapping device numbers; graph history is untouched. */
export async function recoverNativeProjectRunFilesystem(opts: {
  readonly scope: NativeProjectRunScope;
  readonly runtime: NativeRuntimeSelection;
  readonly expectSelection: string;
  readonly acceptLegacyDeviceRebind: true;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<NativeProjectRunFilesystemRecovery> {
  if (
    !HEX64.test(opts.expectSelection) ||
    opts.acceptLegacyDeviceRebind !== true
  ) {
    throw refused();
  }
  const initial = await recoverySelection(opts);
  if (initial.inspection.selectionSha256 !== opts.expectSelection) {
    throw refused();
  }
  const restartLock = `${initial.p.lock.slice(0, -5)}.restart.lock.operation`;
  await mkdir(restartLock, { mode: 0o700 });
  const restartHeld = await heldDirectory(restartLock);
  try {
    await mkdir(initial.p.lock, { mode: 0o700 });
    const mappingHeld = await heldDirectory(initial.p.lock);
    try {
      const selected = await recoverySelection({ ...opts, heldLocks: true });
      if (
        selected.inspection.selectionSha256 !== opts.expectSelection ||
        selected.p.root !== initial.p.root ||
        selected.p.file !== initial.p.file ||
        !selected.bytes.equals(initial.bytes) ||
        selected.fileIdentity.dev !== initial.fileIdentity.dev ||
        selected.fileIdentity.ino !== initial.fileIdentity.ino
      ) {
        throw refused();
      }
      await absentPath(`${selected.p.file.slice(0, -5)}.restart.json`);
      const audit = `${selected.p.file.slice(0, -5)}.filesystem-recovery-${selected.inspection.mappingSha256}.json`;
      const auditText = JSON.stringify({
        version: 1,
        selectionSha256: selected.inspection.selectionSha256,
        mappingSha256: selected.inspection.mappingSha256,
        mapping: selected.bytes.toString("utf8"),
      });
      await preserveRecoveryAudit(audit, auditText);
      await sync(selected.p.root);
      const final = await recoverySelection({ ...opts, heldLocks: true });
      if (
        final.inspection.selectionSha256 !== opts.expectSelection ||
        !final.bytes.equals(selected.bytes) ||
        final.fileIdentity.dev !== selected.fileIdentity.dev ||
        final.fileIdentity.ino !== selected.fileIdentity.ino
      ) {
        throw refused();
      }
      const temporary = join(selected.p.root, `${randomUUID()}.tmp`);
      try {
        await write(temporary, selected.next);
        await Promise.all([restartHeld.verify(), mappingHeld.verify()]);
        const closeMapping = await verifySelectedMappingPath(
          selected.p.file,
          selected.bytes,
          selected.fileIdentity
        );
        try {
          await rename(temporary, selected.p.file);
        } finally {
          await closeMapping();
        }
        await sync(selected.p.root);
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if (!isRecord(error) || error.code !== "ENOENT") {
            throw error;
          }
        });
      }
      if (
        JSON.stringify(await loadNativeProjectRun(opts.scope)) !==
        JSON.stringify(selected.inspection.run)
      ) {
        throw refused();
      }
      return { ...selected.inspection, repaired: true, auditPath: audit };
    } finally {
      await releaseHeldDirectory(initial.p.lock, mappingHeld);
    }
  } finally {
    await releaseHeldDirectory(restartLock, restartHeld);
  }
}
/** Establish excluded metadata before source identity is reviewed. */
export async function prepareNativeProjectRunStorage(
  opts: NativeProjectRunScope
): Promise<void> {
  await paths(opts, true);
}
/** Read a mapping only; callers must still query native authority with every recorded identity. */
export async function loadNativeProjectRun(
  opts: NativeProjectRunScope
): Promise<NativeProjectRun | null> {
  try {
    await scope(opts);
  } catch {
    throw refused();
  }
  try {
    const p = await paths(opts, false);
    return record(await read(p.file), p.identity);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw refused();
  }
}
/** Publish a new owner once, or replace its exact stopped mapping after restore. */
export async function saveNativeProjectRun(
  opts: NativeProjectRunScope & {
    readonly run: NativeProjectRun;
    readonly expected?: NativeProjectRun;
  }
): Promise<void> {
  try {
    if (!valid(opts.run)) {
      throw refused();
    }
    const p = await paths(opts, true);
    await sync(p.root);
    await mkdir(p.lock, { mode: 0o700 });
    const temp = join(p.root, `${randomUUID()}.tmp`);
    try {
      if (opts.expected) {
        const current = record(await read(p.file), p.identity);
        if (
          JSON.stringify(current) !== JSON.stringify(opts.expected) ||
          current.run !== opts.run.run ||
          current.owner !== opts.run.owner ||
          current.namespace !== opts.run.namespace ||
          current.planId !== opts.run.planId
        ) {
          throw refused();
        }
      }
      await write(
        temp,
        JSON.stringify({ version: 1, scope: p.identity, run: opts.run })
      );
      if (opts.expected) {
        await rename(temp, p.file);
      } else {
        await link(temp, p.file);
        await unlink(temp);
      }
      await sync(p.root);
    } finally {
      await unlink(temp).catch((error: unknown) => {
        if (!isRecord(error) || error.code !== "ENOENT") {
          throw error;
        }
      });
      await rmdir(p.lock);
    }
  } catch {
    throw refused();
  }
}
/** Remove only after native cleanup is confirmed, comparing the exact recorded run. */
export async function removeNativeProjectRun(
  opts: NativeProjectRunScope & { readonly expected: NativeProjectRun }
): Promise<void> {
  try {
    const p = await paths(opts, false);
    await mkdir(p.lock, { mode: 0o700 });
    try {
      let current: NativeProjectRun;
      try {
        current = record(await read(p.file), p.identity);
      } catch (error) {
        // Another confirmed owner-side cleanup may already have retired this file.
        if (isRecord(error) && error.code === "ENOENT") {
          return;
        }
        throw error;
      }
      if (JSON.stringify(current) !== JSON.stringify(opts.expected)) {
        throw refused();
      }
      await unlink(p.file);
      await sync(p.root);
    } finally {
      await rmdir(p.lock);
    }
  } catch {
    throw refused();
  }
}

/** Record completion of down hooks as well as backend cleanup before a retry can resume. */
export async function completeNativeRestartCleanup(
  opts: NativeProjectRunScope & { readonly expected: NativeRestartIntent }
): Promise<NativeRestartIntent> {
  const p = await paths(opts, false, "restart");
  await mkdir(p.lock, { mode: 0o700 });
  const temp = join(p.root, `${randomUUID()}.tmp`);
  try {
    const current = restartRecord(await read(p.file), p.identity);
    if (JSON.stringify(current) !== JSON.stringify(opts.expected)) {
      throw refused();
    }
    const intent: NativeRestartIntent = { ...current, phase: "cleaned" };
    await write(
      temp,
      JSON.stringify({ version: 1, scope: p.identity, ...intent })
    );
    await rename(temp, p.file);
    await sync(p.root);
    return intent;
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
    await rmdir(p.lock);
  }
}
