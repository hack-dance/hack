import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { migrationRefusal, readMigrationFile } from "./env-migration-files.ts";
import { isRecord } from "./guards.ts";
import { replacePrivateFileAtomic } from "./private-file.ts";

const DIRECTORY = /^payloads-[a-f0-9-]{36}$/;
const NAME = /^[0-9]+\.payload$/;
const SHA = /^[a-f0-9]{64}$/;

/** An exclusive directory gets a value-free ownership receipt before any payload bytes. */
export async function stageMigrationPayloads(input: {
  readonly journalPath: string;
  readonly projectRoot: string;
  readonly files: readonly { readonly text: string; readonly sha256: string }[];
}): Promise<readonly string[]> {
  const directory = join(
    dirname(input.journalPath),
    `payloads-${randomUUID()}`
  );
  await mkdir(directory, { mode: 0o700 });
  const entries = input.files.map((file, index) => ({
    name: `${index}.payload`,
    sha256: file.sha256,
  }));
  await replacePrivateFileAtomic({
    path: join(directory, "receipt.json"),
    staging: "sibling",
    directories: [directory],
    text: JSON.stringify({
      version: 1,
      kind: "hack-env-migration-payloads",
      projectRoot: input.projectRoot,
      entries,
    }),
    mode: 0o600,
    refusal: migrationRefusal,
  });
  const paths: string[] = [];
  for (const [index, file] of input.files.entries()) {
    const path = join(directory, `${index}.payload`);
    await replacePrivateFileAtomic({
      path,
      staging: "sibling",
      directories: [directory],
      text: file.text,
      mode: 0o600,
      refusal: migrationRefusal,
    });
    paths.push(path);
  }
  return paths;
}

async function privateOwned(
  path: string,
  directory: boolean
): Promise<boolean> {
  const info = await lstat(path);
  return (
    !info.isSymbolicLink() &&
    (directory ? info.isDirectory() : info.isFile() && info.nlink === 1) &&
    info.uid === process.getuid?.() &&
    (info.mode & 0o077) === 0
  );
}

async function removeOwnedDirectory(
  directory: string,
  projectRoot: string
): Promise<boolean> {
  if (!(await privateOwned(directory, true))) {
    return false;
  }
  const receipt = join(directory, "receipt.json");
  if (!(await privateOwned(receipt, false))) {
    return false;
  }
  const original = await readMigrationFile(receipt);
  const raw: unknown = JSON.parse(original.text ?? "null");
  if (
    !(
      isRecord(raw) &&
      raw.version === 1 &&
      raw.kind === "hack-env-migration-payloads" &&
      raw.projectRoot === projectRoot &&
      Array.isArray(raw.entries)
    )
  ) {
    return false;
  }
  const entries: { name: string; sha256: string }[] = [];
  for (const entry of raw.entries) {
    if (
      !(
        isRecord(entry) &&
        typeof entry.name === "string" &&
        NAME.test(entry.name) &&
        typeof entry.sha256 === "string" &&
        SHA.test(entry.sha256)
      )
    ) {
      return false;
    }
    entries.push({ name: entry.name, sha256: entry.sha256 });
  }
  const names = await readdir(directory);
  if (
    names.some(
      (name) =>
        name !== "receipt.json" && !entries.some((entry) => entry.name === name)
    )
  ) {
    return false;
  }
  for (const entry of entries) {
    if (!names.includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (
      !(await privateOwned(path, false)) ||
      (await readMigrationFile(path)).state.sha256 !== entry.sha256
    ) {
      return false;
    }
  }
  // Only recognized, private staging artifacts are removed. Unknown or edited
  // entries keep the whole directory; snapshots and project keys are excluded.
  for (const name of names.filter((name) => name !== "receipt.json")) {
    await unlink(join(directory, name));
  }
  if (
    (await readMigrationFile(receipt)).state.sha256 !== original.state.sha256
  ) {
    return false;
  }
  await unlink(receipt);
  await rmdir(directory);
  return true;
}

/** Sweep completed stages and pre-journal orphans while the project journal lock is held. */
export async function purgeMigrationPayloads(input: {
  readonly journalPath: string;
  readonly projectRoot: string;
  readonly retain: readonly string[];
}): Promise<boolean> {
  let complete = true;
  for (const name of await readdir(dirname(input.journalPath))) {
    if (!DIRECTORY.test(name)) {
      continue;
    }
    const directory = join(dirname(input.journalPath), name);
    if (input.retain.some((path) => dirname(path) === directory)) {
      continue;
    }
    const removed = await removeOwnedDirectory(
      directory,
      input.projectRoot
    ).catch(() => false);
    complete = removed && complete;
  }
  return complete;
}
