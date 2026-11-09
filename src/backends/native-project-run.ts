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
import { basename, isAbsolute, join, relative } from "node:path";
import { ClosedCliError, HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  inspectNativeProjectFinalizationLifetime,
  isNativeProjectFinalizationToken,
  type NativeProjectFinalizationToken,
  withCompletedNativeProjectFinalization,
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
const FOREIGN_SCHEMA = "hack.native-project-run-foreign-home/v1";
const SCOPE_KEYS =
  "branch,dirIdentity,homeIdentity,nativeHome,projectDir,projectRoot,rootIdentity";
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
  /** Public gcloud ADC adapter selector; absent means none. Never credential data. */
  readonly gcloud?: { readonly mode: "file" };
  /**
   * Present when startup reviewed public runtime host metadata into this graph.
   * Retained restores must add it again; absent legacy graphs never gain it.
   */
  readonly runtimeMetadata?: true;
  /**
   * Present only when startup selected a named env while the project had no managed
   * env file, so that env selected only the per-env native files. Absent mappings
   * started with managed env files (or are legacy): a later missing file refuses.
   */
  readonly unmanagedEnvironment?: true;
  /**
   * Present only when startup selected a named env while the project had managed env
   * files but not that env's overlay, so the base values applied. The overlay must
   * still be absent; one that appears later is a changed selection.
   */
  readonly baseOnlyEnvironment?: true;
};
/** The startup environment markers a run mapping can carry; at most one is set. */
export type NativeRunEnvironmentMarkers = Pick<
  NativeProjectRun,
  "unmanagedEnvironment" | "baseOnlyEnvironment"
>;
function isOverlay(envName: string, path: string): boolean {
  return [
    `hack.env.${envName}.yaml`,
    `hack.env.${envName}.local.yaml`,
  ].includes(basename(path));
}
function overlayPresent(
  envName: string,
  environmentFiles: readonly string[]
): boolean {
  return environmentFiles.some((path) => isOverlay(envName, path));
}
/**
 * The marker a fresh startup records for its selection: none for a base selection or
 * a named env whose overlay exists, `unmanagedEnvironment` without any managed env
 * file, and `baseOnlyEnvironment` when managed env files exist but not the overlay.
 */
export function nativeRunEnvironmentMarkers(opts: {
  readonly effectiveEnvName: string | null;
  readonly environmentFiles: readonly string[];
}): NativeRunEnvironmentMarkers {
  const selected = opts.effectiveEnvName;
  if (selected === null) {
    return {};
  }
  if (opts.environmentFiles.length === 0) {
    return { unmanagedEnvironment: true };
  }
  return overlayPresent(selected, opts.environmentFiles)
    ? {}
    : { baseOnlyEnvironment: true };
}
/** A managed env file that appeared or was removed since a run started. */
export type NativeRunEnvironmentChange = {
  readonly change: "appeared" | "removed";
  /** Project-relative file name(s) only; never contents. */
  readonly file: string;
};
type ChangedPath =
  | { readonly change: "appeared"; readonly path: string }
  | { readonly change: "removed"; readonly envName: string };
/** The one comparison behind both exported checks; undefined means unchanged. */
function changedEnvironmentFile(opts: {
  readonly run: NativeRunEnvironmentMarkers & { readonly envName: string };
  readonly environmentFiles: readonly string[];
}): ChangedPath | undefined {
  const { envName } = opts.run;
  const overlay = opts.environmentFiles.find((path) =>
    isOverlay(envName, path)
  );
  if (opts.run.unmanagedEnvironment === true) {
    const appeared = overlay ?? opts.environmentFiles[0];
    return appeared === undefined
      ? undefined
      : { change: "appeared", path: appeared };
  }
  if (opts.run.baseOnlyEnvironment === true) {
    return overlay === undefined
      ? undefined
      : { change: "appeared", path: overlay };
  }
  return overlay === undefined ? { change: "removed", envName } : undefined;
}
/**
 * Whether the managed env files a run's recorded selection needs are unchanged. A base
 * selection needs none. A named selection needs its overlay (`hack.env.<env>.yaml` or
 * `hack.env.<env>.local.yaml`), except a run recorded as started without any managed
 * env file (there must still be none) or without the overlay (it must still be
 * absent). A legacy mapping without a recorded selection never qualifies.
 */
export function nativeRunEnvironmentAvailable(opts: {
  readonly run: Pick<
    NativeProjectRun,
    "effectiveEnvName" | "unmanagedEnvironment" | "baseOnlyEnvironment"
  >;
  readonly environmentFiles: readonly string[];
}): boolean {
  const selected = opts.run.effectiveEnvName;
  if (selected === undefined) {
    return false;
  }
  return (
    selected === null ||
    changedEnvironmentFile({
      run: { ...opts.run, envName: selected },
      environmentFiles: opts.environmentFiles,
    }) === undefined
  );
}
/**
 * The managed env file whose appearance or removal changed a recorded named selection,
 * named relative to the project root (a file outside it by its base name), or
 * undefined when nothing changed or the selection is a base or legacy one.
 */
export function nativeRunEnvironmentChange(opts: {
  readonly run: Pick<
    NativeProjectRun,
    "effectiveEnvName" | "unmanagedEnvironment" | "baseOnlyEnvironment"
  >;
  readonly environmentFiles: readonly string[];
  readonly projectRoot: string;
  readonly projectDir: string;
}): NativeRunEnvironmentChange | undefined {
  const selected = opts.run.effectiveEnvName;
  if (selected === undefined || selected === null) {
    return undefined;
  }
  const changed = changedEnvironmentFile({
    run: { ...opts.run, envName: selected },
    environmentFiles: opts.environmentFiles,
  });
  if (changed === undefined) {
    return undefined;
  }
  const label = (path: string) => {
    const name = relative(opts.projectRoot, path);
    return name === "" || name.startsWith("..") || isAbsolute(name)
      ? basename(path)
      : name;
  };
  if (changed.change === "appeared") {
    return { change: "appeared", file: label(changed.path) };
  }
  const overlay = label(
    join(opts.projectDir, `hack.env.${changed.envName}.yaml`)
  );
  const local = label(
    join(opts.projectDir, `hack.env.${changed.envName}.local.yaml`)
  );
  return { change: "removed", file: `${overlay} or ${local}` };
}
/**
 * How to apply a changed env file set: start again with the files as they are now. A
 * removed overlay can also be restored to keep the run; a project with down hooks needs
 * it restored for `hack down`, which runs them with the values the run started with.
 */
export function nativeRunEnvironmentRemedy(opts: {
  readonly change: NativeRunEnvironmentChange;
  /** The command the caller refused, e.g. `hack restart`. */
  readonly retry: string;
}): string {
  return opts.change.change === "appeared"
    ? "Run hack down, then hack up, to start with it"
    : `Restore it and run ${opts.retry} again, or run hack down (with it restored if the project has down hooks), then hack up, to start without it`;
}
/** "<file> appeared since this run started" or "<file> was removed since ..." */
export function describeNativeRunEnvironmentChange(
  change: NativeRunEnvironmentChange
): string {
  return change.change === "appeared"
    ? `${change.file} appeared since this run started`
    : `${change.file} was removed since this run started`;
}
export type NativeProjectRunScope = {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly nativeHome: string;
  readonly branch: string | null;
};
/** Integrity or ownership refusal of the saved mapping: closed, no stack. */
function refused(): Error {
  return new ClosedCliError(
    "Native project run mapping is unsafe, changed, or owned by another run; inspect native state before recovery."
  );
}
function validGcloud(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).join() === "mode" &&
    value.mode === "file"
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
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: "Native profiles require at most 64 bounded nonempty names.",
    });
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
/** Mapping key sets written before the startup selectors were complete. */
const LEGACY_KEY_SETS = [
  "namespace,owner,planId,run",
  "effectiveEnvName,namespace,owner,planId,run",
  "aws,effectiveEnvName,namespace,owner,planId,run",
];
/** A complete mapping holds these keys plus any of {@link OPTIONAL_KEYS}. */
const SELECTED_KEYS =
  "aws,effectiveEnvName,namespace,owner,planId,profiles,run";
const OPTIONAL_KEYS = new Set([
  "baseOnlyEnvironment",
  "gcloud",
  "runtimeMetadata",
  "unmanagedEnvironment",
]);
function validKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    LEGACY_KEY_SETS.includes(keys.join()) ||
    keys.filter((key) => !OPTIONAL_KEYS.has(key)).join() === SELECTED_KEYS
  );
}
function validEnvironmentMarkers(value: Record<string, unknown>): boolean {
  const unmanaged = Object.hasOwn(value, "unmanagedEnvironment");
  const baseOnly = Object.hasOwn(value, "baseOnlyEnvironment");
  return (
    !(unmanaged && baseOnly) &&
    (!unmanaged || value.unmanagedEnvironment === true) &&
    (!baseOnly || value.baseOnlyEnvironment === true) &&
    (!(unmanaged || baseOnly) || typeof value.effectiveEnvName === "string")
  );
}
function valid(value: unknown): value is NativeProjectRun {
  return (
    isRecord(value) &&
    validKeys(value) &&
    (!Object.hasOwn(value, "gcloud") || validGcloud(value.gcloud)) &&
    (!Object.hasOwn(value, "runtimeMetadata") ||
      value.runtimeMetadata === true) &&
    validEnvironmentMarkers(value) &&
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
  kind: "run" | "restart" | "down-hooks" = "run"
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
  const suffix = kind === "run" ? "" : `.${kind}`;
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
/**
 * The private directory and the operation lock path shared by restart,
 * filesystem recovery and data removal. Creates the excluded directory.
 */
export async function nativeRestartOperationLock(
  opts: NativeProjectRunScope
): Promise<{ readonly root: string; readonly lock: string }> {
  const p = await paths(opts, true, "restart");
  return { root: p.root, lock: `${p.lock}.operation` };
}
/** Serialize cleanup and replacement hooks; uncertain abandoned ownership requires inspection. */
export async function withNativeRestartLock<T>(
  opts: NativeProjectRunScope,
  action: (release: () => Promise<void>) => Promise<T>
): Promise<T> {
  const { lock } = await nativeRestartOperationLock(opts);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new ClosedCliError(
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
    Object.keys(value.scope).sort().join() !== SCOPE_KEYS
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

export type NativeProjectRunCurrentInspection = {
  readonly schema: typeof CURRENT_SCHEMA;
  readonly state: "current";
  readonly mappingSha256: string;
  readonly run: NativeProjectRun;
  /** Absent when the native graph cannot be read, for example while the pool is stopped. */
  readonly graph: {
    readonly phase: string;
    readonly ownershipMatches: boolean;
  } | null;
  readonly repairRequired: false;
};

const CURRENT_SCHEMA = "hack.native-project-run-mapping-inspection/v1";
const GRAPH_PHASE = /^[a-z][a-z-]{0,63}$/;

async function currentGraph(opts: {
  readonly projectRoot: string;
  readonly run: NativeProjectRun;
  readonly runtime: NativeRuntimeSelection;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<NativeProjectRunCurrentInspection["graph"]> {
  let observed: unknown;
  try {
    observed = await inspectNativeProjectGraph({
      runtime: opts.runtime,
      projectRoot: opts.projectRoot,
      run: opts.run.run,
      invoke: opts.invoke ?? invokeNativeRuntime,
    });
  } catch {
    return null;
  }
  const receipt = isRecord(observed) ? observed.receipt : undefined;
  if (
    !(
      isRecord(receipt) &&
      typeof receipt.phase === "string" &&
      GRAPH_PHASE.test(receipt.phase)
    )
  ) {
    return null;
  }
  return {
    phase: receipt.phase,
    ownershipMatches:
      isRecord(observed) &&
      observed.journal_incomplete === false &&
      receipt.run === opts.run.run &&
      receipt.owner === opts.run.owner &&
      receipt.namespace === opts.run.namespace &&
      receipt.plan_id === opts.run.planId,
  };
}

/**
 * Read-only Doctor inspection of the saved run mapping. A mapping that still
 * matches this checkout is reported with its native graph phase and whether the
 * graph's ownership matches it; nothing needs repair. Only a mapping whose scope
 * no longer matches falls through to the foreign-home inspection (only the native
 * home differs) and then to the explicit legacy device-rebind inspection, which
 * refuses every other difference.
 */
export async function inspectNativeProjectRunMapping(opts: {
  readonly scope: NativeProjectRunScope;
  readonly runtime: NativeRuntimeSelection;
  readonly invoke?: typeof invokeNativeRuntime;
  /** Test seam for the owning home's frontend PID check. */
  readonly isAlive?: (pid: number) => boolean;
}): Promise<
  | NativeProjectRunCurrentInspection
  | NativeProjectRunFilesystemInspection
  | NativeProjectRunForeignHomeInspection
> {
  const p = await paths(opts.scope, false);
  await recoveryDirectories(p);
  const { bytes, value } = await readRecoveryFile(p.file);
  let run: NativeProjectRun;
  try {
    run = record(value, p.identity);
  } catch {
    const foreign = await foreignHomeSelection({
      scope: opts.scope,
      isAlive: opts.isAlive,
    }).catch(() => undefined);
    return (
      foreign?.inspection ??
      (await inspectNativeProjectRunFilesystemRecovery(opts))
    );
  }
  return {
    schema: CURRENT_SCHEMA,
    state: "current",
    mappingSha256: createHash("sha256").update(bytes).digest("hex"),
    run,
    graph: await currentGraph({
      projectRoot: p.identity.projectRoot,
      run,
      runtime: opts.runtime,
      invoke: opts.invoke,
    }),
    repairRequired: false,
  };
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
/**
 * A run mapping that another native home wrote for this exact checkout and
 * instance. Each launcher version has its own native home, so an upgrade leaves the
 * previous version's mapping behind. Its graph and retained data live only in that
 * home; this home can neither restore nor stop it.
 */
export type NativeProjectRunForeignHomeInspection = {
  readonly schema: typeof FOREIGN_SCHEMA;
  readonly state: "foreign-home";
  /** The owning native home, as recorded and still at that path and identity. */
  readonly ownerHome: string;
  /**
   * The owning home's latest frontend lifetime for this run: `stopped` only when it
   * acknowledged confirmed cleanup (`NativeProjectFinalizationLifetime`).
   */
  readonly owner: "stopped" | "live" | "interrupted" | "unproven";
  /** The owning frontend's PID for a live or interrupted owner. */
  readonly ownerPid: number | null;
  readonly run: NativeProjectRun;
  readonly mappingSha256: string;
  /** Present only for a cleanly stopped owner; `release` requires it exactly. */
  readonly selectionSha256: string | null;
};

export type NativeProjectRunForeignHomeRelease =
  NativeProjectRunForeignHomeInspection & {
    readonly released: true;
    readonly auditPath: string;
  };

const HOME_LIMIT = 4096;

function directoryIdentity(value: unknown): DirectoryIdentity | undefined {
  return isRecord(value) &&
    Object.keys(value).sort().join() === "dev,ino" &&
    typeof value.dev === "number" &&
    Number.isSafeInteger(value.dev) &&
    typeof value.ino === "number" &&
    Number.isSafeInteger(value.ino)
    ? { dev: value.dev, ino: value.ino }
    : undefined;
}

function sameDirectory(value: unknown, expected: DirectoryIdentity): boolean {
  const identity = directoryIdentity(value);
  return identity?.dev === expected.dev && identity.ino === expected.ino;
}

/**
 * The mapping's owning home when the stored scope differs from this checkout in its
 * native home only: the same canonical project root and directory, their exact
 * identities, and the same instance. Any other difference is not a foreign home.
 */
function foreignHomeMapping(
  value: unknown,
  current: RunScopeIdentity
):
  | {
      readonly ownerHome: string;
      readonly ownerIdentity: DirectoryIdentity;
      readonly run: NativeProjectRun;
    }
  | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== "run,scope,version" ||
    value.version !== 1 ||
    !valid(value.run) ||
    !isRecord(value.scope) ||
    Object.keys(value.scope).sort().join() !== SCOPE_KEYS
  ) {
    return undefined;
  }
  const stored = value.scope;
  const home = stored.nativeHome;
  const ownerIdentity = directoryIdentity(stored.homeIdentity);
  if (
    typeof home !== "string" ||
    !isAbsolute(home) ||
    home.length > HOME_LIMIT ||
    CONTROL.test(home) ||
    home === current.nativeHome ||
    ownerIdentity === undefined ||
    stored.projectRoot !== current.projectRoot ||
    stored.projectDir !== current.projectDir ||
    stored.branch !== current.branch ||
    !sameDirectory(stored.rootIdentity, current.rootIdentity) ||
    !sameDirectory(stored.dirIdentity, current.dirIdentity)
  ) {
    return undefined;
  }
  return { ownerHome: home, ownerIdentity, run: value.run };
}

/** The recorded home is still that exact canonical directory. */
async function ownerHomeMatches(
  home: string,
  identity: DirectoryIdentity
): Promise<boolean> {
  try {
    const info = await lstat(home);
    return (
      info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.dev === identity.dev &&
      info.ino === identity.ino &&
      (await realpath(home)) === home
    );
  } catch {
    return false;
  }
}

async function foreignHomeSelection(opts: {
  readonly scope: NativeProjectRunScope;
  readonly isAlive?: (pid: number) => boolean;
}): Promise<
  | {
      readonly inspection: NativeProjectRunForeignHomeInspection;
      readonly p: RecoveryPaths;
      readonly bytes: Buffer;
      readonly fileIdentity: DirectoryIdentity;
      readonly ownerScope: NativeProjectRunScope;
      readonly attempt: string | null;
    }
  | undefined
> {
  const p = await paths(opts.scope, false);
  await recoveryDirectories(p);
  const { bytes, value, identity } = await readRecoveryFile(p.file);
  const foreign = foreignHomeMapping(value, p.identity);
  if (foreign === undefined) {
    return undefined;
  }
  const ownerScope = { ...opts.scope, nativeHome: foreign.ownerHome };
  const lifetime = (await ownerHomeMatches(
    foreign.ownerHome,
    foreign.ownerIdentity
  ))
    ? await inspectNativeProjectFinalizationLifetime({
        scope: ownerScope,
        run: foreign.run,
        isAlive: opts.isAlive,
      })
    : ({ state: "unproven" } as const);
  const mappingSha256 = createHash("sha256").update(bytes).digest("hex");
  const attempt = lifetime.state === "completed" ? lifetime.attempt : null;
  const selectionSha256 =
    attempt === null
      ? null
      : createHash("sha256")
          .update(
            JSON.stringify({
              schema: FOREIGN_SCHEMA,
              mappingSha256,
              fileIdentity: identity,
              scope: p.identity,
              ownerHome: foreign.ownerHome,
              ownerIdentity: foreign.ownerIdentity,
              run: foreign.run,
              attempt,
            })
          )
          .digest("hex");
  return {
    inspection: {
      schema: FOREIGN_SCHEMA,
      state: "foreign-home",
      ownerHome: foreign.ownerHome,
      owner: lifetime.state === "completed" ? "stopped" : lifetime.state,
      ownerPid:
        lifetime.state === "live" || lifetime.state === "interrupted"
          ? lifetime.pid
          : null,
      run: foreign.run,
      mappingSha256,
      selectionSha256,
    },
    p,
    bytes,
    fileIdentity: identity,
    ownerScope,
    attempt,
  };
}

/** The doctor command that releases a stopped foreign-home mapping from this home. */
export function nativeForeignHomeReleaseCommand(opts: {
  readonly selectionSha256: string;
  readonly branch: string | null;
}): string {
  const branch = opts.branch === null ? "" : ` --branch ${opts.branch}`;
  return `hack doctor --native-run-mapping release --expect-selection ${opts.selectionSha256}${branch}`;
}

/** The refusal sentence for a foreign-home mapping: names the owning home and the way out. */
export function describeNativeForeignHomeMapping(opts: {
  readonly inspection: NativeProjectRunForeignHomeInspection;
  readonly branch: string | null;
}): string {
  const { inspection } = opts;
  const where = `run ${inspection.run.run} in another native home (${inspection.ownerHome})`;
  const stopThere = "run hack down with the Hack version that owns that home";
  if (inspection.owner === "stopped" && inspection.selectionSha256 !== null) {
    return (
      `Native project run mapping belongs to ${where}, which stopped it cleanly; its retained data stays in that home. ` +
      `To start this instance from this native home, release the mapping with ${nativeForeignHomeReleaseCommand(
        {
          selectionSha256: inspection.selectionSha256,
          branch: opts.branch,
        }
      )}, or ${stopThere}.`
    );
  }
  if (inspection.owner === "live") {
    return (
      `Native project run mapping is owned by live ${where}, frontend pid ${inspection.ownerPid}. ` +
      `Stop it first: press Ctrl-C in that hack up, or ${stopThere}; then retry here.`
    );
  }
  if (inspection.owner === "interrupted") {
    return (
      `Native project run mapping belongs to ${where}, whose frontend (pid ${inspection.ownerPid}) exited without confirming cleanup. ` +
      "With the Hack version that owns that home, inspect it with hack doctor --native-cleanup inspect, then run hack down; then retry here."
    );
  }
  return (
    `Native project run mapping belongs to ${where}, and its clean stop cannot be proven from this home. ` +
    `Before using this home, ${stopThere}.`
  );
}

async function foreignHomeRefusal(
  scope: NativeProjectRunScope
): Promise<Error | undefined> {
  try {
    const selected = await foreignHomeSelection({ scope });
    return selected
      ? new ClosedCliError(
          describeNativeForeignHomeMapping({
            inspection: selected.inspection,
            branch: scope.branch,
          })
        )
      : undefined;
  } catch {
    return undefined;
  }
}

/** The kind tag of the value-free down-hook journal beside the run mapping. */
const DOWN_HOOK_KIND = "hack.native-project-down-hooks";

function pendingDownHooks(): Error {
  return new ClosedCliError(
    "Native project run mapping from another native home has down hooks that are owed, unknown or not this run's; it was not released. Run hack down with the Hack version that owns that home first."
  );
}

/**
 * No down hook is owed for the selected run: its journal is absent, or it is a
 * completed record of exactly this run (a successful stop keeps that terminal
 * record rather than removing it). An owed, started (unknown), failed, unreadable or
 * another run's record refuses. The journal's own writers hold its lock, which the
 * caller checks separately.
 */
async function downHooksSettled(path: string, run: string): Promise<void> {
  let value: unknown;
  try {
    value = (await readRecoveryFile(path)).value;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw pendingDownHooks();
  }
  if (
    !(
      isRecord(value) &&
      Object.keys(value).sort().join() ===
        "generation,kind,run,state,version" &&
      value.version === 1 &&
      value.kind === DOWN_HOOK_KIND &&
      value.run === run &&
      typeof value.generation === "string" &&
      HEX32.test(value.generation) &&
      value.state === "complete"
    )
  ) {
    throw pendingDownHooks();
  }
}

/**
 * Release a mapping that another native home left after a clean stop, so this home
 * can start the instance afresh. Ownership is proved, never assumed: the stored scope
 * differs only in its native home, that home is still the recorded directory, and
 * its frontend records show the run's latest lifetime acknowledged confirmed cleanup.
 * A down-hook journal must be absent or this run's completed record.
 * The owning home's finalization lock is held throughout, so it cannot begin a new
 * lifetime meanwhile. Pending restart or down-hook state refuses. The exact mapping
 * bytes are kept in an audit file; the owning home's graph and data are untouched.
 */
export async function releaseNativeProjectRunForeignHome(opts: {
  readonly scope: NativeProjectRunScope;
  readonly expectSelection: string;
}): Promise<NativeProjectRunForeignHomeRelease> {
  if (!HEX64.test(opts.expectSelection)) {
    throw refused();
  }
  const initial = await foreignHomeSelection({ scope: opts.scope });
  if (initial === undefined) {
    throw refused();
  }
  if (initial.attempt === null) {
    throw new ClosedCliError(
      describeNativeForeignHomeMapping({
        inspection: initial.inspection,
        branch: opts.scope.branch,
      })
    );
  }
  if (initial.inspection.selectionSha256 !== opts.expectSelection) {
    throw refused();
  }
  const attempt = initial.attempt;
  await recoveryLocksAbsent(initial.p);
  const base = initial.p.file.slice(0, -5);
  const restartLock = `${initial.p.lock.slice(0, -5)}.restart.lock.operation`;
  await mkdir(restartLock, { mode: 0o700 });
  const restartHeld = await heldDirectory(restartLock);
  try {
    await mkdir(initial.p.lock, { mode: 0o700 });
    const mappingHeld = await heldDirectory(initial.p.lock);
    try {
      return await withCompletedNativeProjectFinalization({
        scope: initial.ownerScope,
        run: initial.inspection.run,
        attempt,
        action: async () => {
          const selected = await foreignHomeSelection({ scope: opts.scope });
          if (
            selected === undefined ||
            selected.inspection.selectionSha256 !== opts.expectSelection ||
            selected.p.file !== initial.p.file ||
            !selected.bytes.equals(initial.bytes) ||
            selected.fileIdentity.dev !== initial.fileIdentity.dev ||
            selected.fileIdentity.ino !== initial.fileIdentity.ino
          ) {
            throw refused();
          }
          await Promise.all([
            absentPath(`${base}.restart.json`),
            downHooksSettled(
              `${base}.down-hooks.json`,
              selected.inspection.run.run
            ),
            absentPath(`${base}.down-hooks.lock`),
          ]);
          const audit = `${base}.foreign-home-release-${selected.inspection.mappingSha256}.json`;
          await preserveRecoveryAudit(
            audit,
            JSON.stringify({
              version: 1,
              schema: FOREIGN_SCHEMA,
              selectionSha256: opts.expectSelection,
              mappingSha256: selected.inspection.mappingSha256,
              ownerHome: selected.inspection.ownerHome,
              mapping: selected.bytes.toString("utf8"),
            })
          );
          await sync(selected.p.root);
          await Promise.all([restartHeld.verify(), mappingHeld.verify()]);
          const closeMapping = await verifySelectedMappingPath(
            selected.p.file,
            selected.bytes,
            selected.fileIdentity
          );
          try {
            await unlink(selected.p.file);
          } finally {
            await closeMapping();
          }
          await sync(selected.p.root);
          await absentPath(selected.p.file);
          return { ...selected.inspection, released: true, auditPath: audit };
        },
      });
    } finally {
      await releaseHeldDirectory(initial.p.lock, mappingHeld);
    }
  } finally {
    await releaseHeldDirectory(restartLock, restartHeld);
  }
}

/**
 * Private paths of the value-free down-hook journal beside the run mapping,
 * under the same scope, directory and ignore-file checks. Missing storage
 * surfaces as the raw ENOENT error; callers treat it as "no journal".
 */
export async function nativeProjectDownHookPaths(
  opts: NativeProjectRunScope,
  create: boolean
): Promise<{
  readonly root: string;
  readonly file: string;
  readonly lock: string;
}> {
  const p = await paths(opts, create, "down-hooks");
  return { root: p.root, file: p.file, lock: p.lock };
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
  let stored: { readonly value: unknown; readonly identity: RunScopeIdentity };
  try {
    const p = await paths(opts, false);
    stored = { value: await read(p.file), identity: p.identity };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw refused();
  }
  try {
    return record(stored.value, stored.identity);
  } catch {
    // Only a mapping that differs in nothing but its native home gets a named refusal.
    throw (await foreignHomeRefusal(opts)) ?? refused();
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
