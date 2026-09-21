import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { isRecord } from "../lib/guards.ts";

const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const LIMIT = 8192;
const CONTROL = /[\x00-\x1f\x7f]/;
export type NativeProjectRun = {
  readonly run: string;
  readonly owner: string;
  readonly namespace: string;
  readonly planId: string;
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
function valid(value: unknown): value is NativeProjectRun {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join() === "namespace,owner,planId,run" &&
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
async function paths(opts: NativeProjectRunScope, create: boolean) {
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
  return {
    identity,
    root,
    file: join(root, `${key}.json`),
    lock: join(root, `${key}.lock`),
  };
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
/** Publish once after authoritative graph admission; never overwrite an uncertain/live mapping. */
export async function saveNativeProjectRun(
  opts: NativeProjectRunScope & { readonly run: NativeProjectRun }
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
      await write(
        temp,
        JSON.stringify({ version: 1, scope: p.identity, run: opts.run })
      );
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
