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

const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const LIMIT = 8192;
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
