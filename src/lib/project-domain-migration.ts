import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { isRecord } from "./guards.ts";
import { planProjectDomainMigration } from "./project-domain-plan.ts";

const FILES = ["hack.config.json", "docker-compose.yml"] as const;
const LIMIT = 1024 * 1024;
const JOURNAL_LIMIT = 6 * LIMIT;
const STAGING_FILE = /^write-[a-f0-9]{24}\.tmp$/;
const HASH = /^[a-f0-9]{64}$/;
type Identity = {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly hash: string;
};
type Saved = {
  readonly name: (typeof FILES)[number];
  readonly before: string;
  readonly after: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly mode: number;
};
export type ProjectDomainMigrationPreview = ReturnType<
  typeof planProjectDomainMigration
> & {
  readonly projectDir: string;
  readonly directory: { readonly dev: number; readonly ino: number };
  readonly files: readonly Identity[];
};
function failure(): Error {
  return new Error(
    "Project domain migration refused: unsafe, changed, incomplete, or conflicting local state; review or roll back the owned migration first"
  );
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function missing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
async function directory(path: string) {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split("/").filter(Boolean)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw failure();
    }
  }
  return await lstat(absolute);
}
async function syncDir(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function read(path: string, limit = LIMIT) {
  const entry = await lstat(path);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.size > limit
  ) {
    throw failure();
  }
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat();
    if (
      !before.isFile() ||
      (before.mode & 0o7000) !== 0 ||
      before.nlink !== 1 ||
      before.size > limit ||
      before.dev !== entry.dev ||
      before.ino !== entry.ino
    ) {
      throw failure();
    }
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await fd.read(buffer, size, buffer.length - size, size);
      if (result.bytesRead === 0) {
        break;
      }
      size += result.bytesRead;
    }
    const after = await fd.stat();
    if (
      size > limit ||
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw failure();
    }
    const bytes = buffer.subarray(0, size);
    return {
      bytes,
      identity: {
        dev: before.dev,
        ino: before.ino,
        mode: before.mode & 0o7777,
        hash: hash(bytes),
      },
    };
  } finally {
    await fd.close();
  }
}
async function current(projectDir: string) {
  await directory(projectDir);
  return await Promise.all(FILES.map((name) => read(join(projectDir, name))));
}
function text(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failure();
  }
}

export async function previewProjectDomainMigration(opts: {
  readonly projectDir: string;
  readonly claimedHosts?: readonly string[];
}): Promise<ProjectDomainMigrationPreview> {
  try {
    const projectDir = resolve(opts.projectDir);
    const info = await directory(projectDir);
    const values = await current(projectDir);
    const config = values[0],
      compose = values[1];
    if (!(config && compose)) {
      throw failure();
    }
    const plan = planProjectDomainMigration({
      configText: text(config.bytes),
      composeText: text(compose.bytes),
      claimedHosts: opts.claimedHosts,
    });
    return {
      ...plan,
      projectDir,
      directory: { dev: info.dev, ino: info.ino },
      files: values.map((value) => value.identity),
    };
  } catch {
    throw failure();
  }
}
/** Recover only a published owner proven absent; PID reuse or unreadable state refuses. */
async function recoverLock(lock: string) {
  const info = await directory(lock);
  const ownerPath = join(lock, "owner.json");
  const owner = await read(ownerPath, 1024);
  const parsed: unknown = JSON.parse(text(owner.bytes));
  if (
    !(isRecord(parsed) && Number.isSafeInteger(parsed.pid)) ||
    typeof parsed.pid !== "number" ||
    parsed.pid <= 0 ||
    owner.identity.mode !== 0o600 ||
    (await readdir(lock)).join() !== "owner.json"
  ) {
    throw failure();
  }
  try {
    process.kill(parsed.pid, 0);
    throw failure();
  } catch (error) {
    if (!isRecord(error) || error.code !== "ESRCH") {
      throw failure();
    }
  }
  const again = await directory(lock);
  const latest = await read(ownerPath, 1024);
  if (
    again.dev !== info.dev ||
    again.ino !== info.ino ||
    JSON.stringify(latest.identity) !== JSON.stringify(owner.identity)
  ) {
    throw failure();
  }
  await unlink(ownerPath);
  await rmdir(lock);
}
async function verifyLockOwnership(
  lock: string,
  ownership: {
    directory: Awaited<ReturnType<typeof directory>>;
    owner: Awaited<ReturnType<typeof read>>;
  }
) {
  const latestDirectory = await directory(lock);
  const latestOwner = await read(join(lock, "owner.json"), 1024);
  if (
    latestDirectory.dev !== ownership.directory.dev ||
    latestDirectory.ino !== ownership.directory.ino ||
    JSON.stringify(latestOwner.identity) !==
      JSON.stringify(ownership.owner.identity)
  ) {
    throw failure();
  }
}
async function withLock<T>(
  projectDir: string,
  action: (internal: string) => Promise<T>,
  recover = false
): Promise<T> {
  await directory(projectDir);
  const internal = join(projectDir, ".internal");
  try {
    await mkdir(internal, { mode: 0o700 });
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  await directory(internal);
  const lock = join(internal, "domain-migration.lock");
  const guard = join(internal, "domain-migration.recovery-lock");
  if (recover) {
    await mkdir(guard, { mode: 0o700 });
  }
  let ownership: {
    directory: Awaited<ReturnType<typeof directory>>;
    owner: Awaited<ReturnType<typeof read>>;
  };
  try {
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (!(recover && isRecord(error)) || error.code !== "EEXIST") {
        throw error;
      }
      await recoverLock(lock);
      await mkdir(lock, { mode: 0o700 });
    }
    await writeExclusive(
      join(lock, "owner.json"),
      Buffer.from(JSON.stringify({ pid: process.pid })),
      0o600
    );
    await syncDir(lock);
    ownership = {
      directory: await directory(lock),
      owner: await read(join(lock, "owner.json"), 1024),
    };
  } finally {
    if (recover) {
      await rmdir(guard);
    }
  }
  try {
    return await action(internal);
  } finally {
    await verifyLockOwnership(lock, ownership);
    await unlink(join(lock, "owner.json"));
    await rmdir(lock);
  }
}

async function writeExclusive(path: string, bytes: Buffer, mode: number) {
  const fd = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await fd.writeFile(bytes);
    await fd.chmod(mode);
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function replace(
  projectDir: string,
  name: string,
  bytes: Buffer,
  mode: number,
  expected: Identity | undefined
) {
  await directory(projectDir);
  const temporary = join(
    join(projectDir, ".internal/domain-migration/staging"),
    `write-${randomBytes(12).toString("hex")}.tmp`
  );
  try {
    await writeExclusive(temporary, bytes, mode);
    const latest = await read(join(projectDir, name));
    if (
      !expected ||
      JSON.stringify(latest.identity) !== JSON.stringify(expected)
    ) {
      throw failure();
    }
    await rename(temporary, join(projectDir, name));
    await syncDir(projectDir);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!missing(error)) {
        throw error;
      }
    });
  }
}
export async function applyProjectDomainMigration(opts: {
  readonly projectDir: string;
  readonly plan: ProjectDomainMigrationPreview;
}): Promise<void> {
  try {
    const projectDir = resolve(opts.projectDir);
    if (projectDir !== opts.plan.projectDir) {
      throw failure();
    }
    await withLock(projectDir, async (internal) => {
      const info = await directory(projectDir);
      if (
        info.dev !== opts.plan.directory.dev ||
        info.ino !== opts.plan.directory.ino
      ) {
        throw failure();
      }
      const values = await current(projectDir);
      if (
        values.some(
          (value, index) =>
            JSON.stringify(value.identity) !==
            JSON.stringify(opts.plan.files[index])
        )
      ) {
        throw failure();
      }
      const output = [opts.plan.configText, opts.plan.composeText];
      const saved: Saved[] = values.map((value, index) => {
        const name = FILES[index],
          after = output[index];
        if (
          !name ||
          typeof after !== "string" ||
          Buffer.byteLength(after) > LIMIT
        ) {
          throw failure();
        }
        const bytes = Buffer.from(after);
        return {
          name,
          before: value.bytes.toString("base64"),
          after: bytes.toString("base64"),
          beforeHash: value.identity.hash,
          afterHash: hash(bytes),
          mode: value.identity.mode,
        };
      });
      const journal = join(internal, "domain-migration");
      await mkdir(journal, { mode: 0o700 });
      // Publish and sync the ignore rule before any potentially sensitive bytes.
      await writeExclusive(
        join(journal, ".gitignore"),
        Buffer.from("*\n"),
        0o600
      );
      await syncDir(journal);
      await mkdir(join(journal, "staging"), { mode: 0o700 });
      await writeExclusive(
        join(journal, "record.json"),
        Buffer.from(
          JSON.stringify({
            version: 1,
            projectDir,
            directory: opts.plan.directory,
            files: saved,
          })
        ),
        0o600
      );
      await syncDir(journal);
      await syncDir(internal);
      // The durable record precedes every target write; no stale plan may start mutation.
      const again = await current(projectDir);
      if (
        again.some(
          (value, index) =>
            JSON.stringify(value.identity) !==
            JSON.stringify(opts.plan.files[index])
        )
      ) {
        throw failure();
      }
      for (const [index, file] of saved.entries()) {
        await replace(
          projectDir,
          file.name,
          Buffer.from(file.after, "base64"),
          file.mode,
          again[index]?.identity
        );
      }
    });
  } catch {
    throw failure();
  }
}
function savedFiles(value: unknown): Saved[] {
  if (!Array.isArray(value) || value.length !== FILES.length) {
    throw failure();
  }
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      entry.name !== FILES[index] ||
      typeof entry.before !== "string" ||
      typeof entry.after !== "string" ||
      typeof entry.beforeHash !== "string" ||
      typeof entry.afterHash !== "string" ||
      !HASH.test(entry.beforeHash) ||
      !HASH.test(entry.afterHash) ||
      typeof entry.mode !== "number" ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    ) {
      throw failure();
    }
    for (const [encoded, expected] of [
      [entry.before, entry.beforeHash],
      [entry.after, entry.afterHash],
    ]) {
      if (encoded === undefined || expected === undefined) {
        throw failure();
      }
      const bytes = Buffer.from(encoded, "base64");
      if (
        bytes.length > LIMIT ||
        bytes.toString("base64") !== encoded ||
        hash(bytes) !== expected
      ) {
        throw failure();
      }
    }
    return {
      name: FILES[index] ?? "hack.config.json",
      before: entry.before,
      after: entry.after,
      beforeHash: entry.beforeHash,
      afterHash: entry.afterHash,
      mode: entry.mode,
    };
  });
}
async function validateStaging(journal: string): Promise<string[]> {
  const ignore = await read(join(journal, ".gitignore"), 16);
  if (ignore.identity.mode !== 0o600 || text(ignore.bytes) !== "*\n") {
    throw failure();
  }
  const staging = join(journal, "staging");
  const info = await directory(staging);
  if ((info.mode & 0o777) !== 0o700) {
    throw failure();
  }
  const names = await readdir(staging);
  if (names.length > 16) {
    throw failure();
  }
  for (const name of names) {
    if (!STAGING_FILE.test(name)) {
      throw failure();
    }
    await read(join(staging, name));
  }
  return names;
}
export async function rollbackProjectDomainMigration(opts: {
  readonly projectDir: string;
}): Promise<void> {
  try {
    const projectDir = resolve(opts.projectDir);
    await withLock(
      projectDir,
      async (internal) => {
        const journal = join(internal, "domain-migration");
        const journalInfo = await directory(journal);
        if (
          (journalInfo.mode & 0o777) !== 0o700 ||
          (await readdir(journal)).sort().join() !==
            ".gitignore,record.json,staging"
        ) {
          throw failure();
        }
        await validateStaging(journal);
        const record = await read(join(journal, "record.json"), JOURNAL_LIMIT);
        if (record.identity.mode !== 0o600) {
          throw failure();
        }
        const parsed: unknown = JSON.parse(text(record.bytes));
        const info = await directory(projectDir);
        if (
          !isRecord(parsed) ||
          parsed.version !== 1 ||
          parsed.projectDir !== projectDir ||
          !isRecord(parsed.directory) ||
          parsed.directory.dev !== info.dev ||
          parsed.directory.ino !== info.ino
        ) {
          throw failure();
        }
        const files = savedFiles(parsed.files);
        const values = await current(projectDir);
        if (
          files.some((file, index) => {
            const value = values[index];
            return (
              !value ||
              value.identity.mode !== file.mode ||
              ![file.beforeHash, file.afterHash].includes(value.identity.hash)
            );
          })
        ) {
          throw failure();
        }
        for (const [index, file] of files.entries()) {
          await replace(
            projectDir,
            file.name,
            Buffer.from(file.before, "base64"),
            file.mode,
            values[index]?.identity
          );
        }
        // Revalidate before removing only files admitted as owned staging residue.
        const residues = await validateStaging(journal);
        for (const name of residues) {
          await unlink(join(journal, "staging", name));
        }
        await rmdir(join(journal, "staging"));
        await unlink(join(journal, "record.json"));
        await unlink(join(journal, ".gitignore"));
        await rmdir(journal);
        await syncDir(internal);
      },
      true
    );
  } catch {
    throw failure();
  }
}
