import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  isNativeHttpsLeaseRelease,
  isNativeHttpsOwnerConfiguration,
  type NativeHttpsLeaseIdentity,
  type NativeHttpsLeaseRelease,
  type NativeHttpsOwnerConfiguration,
  nativeHttpsOwnerRefused,
  sameNativeHttpsLease,
} from "./native-https-owner-protocol.ts";

export interface NativeHttpsFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly sha256: string;
}
export function nativeHttpsOwnerRoot(home: string): string {
  return join(home, "native-https", "shared-owner");
}
export function nativeHttpsLeaseReleasePath(
  home: string,
  identity: NativeHttpsLeaseIdentity
): string {
  return join(
    home,
    "native-https",
    "released-leases",
    identity.ownerGeneration,
    `${identity.leaseId}.json`
  );
}
export async function nativeHttpsReadRetiredOwner(
  home: string,
  generation: string
): Promise<NativeHttpsOwnerConfiguration> {
  for (const path of [
    home,
    join(home, "native-https"),
    join(home, "native-https", "released-leases"),
    join(home, "native-https", "released-leases", generation),
  ]) {
    await nativeHttpsPrivateDirectory(path);
  }
  const { bytes } = await nativeHttpsReadFile(
    join(
      home,
      "native-https",
      "released-leases",
      generation,
      "owner-retired.json"
    )
  );
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(value) ||
    value.retired !== true ||
    Object.keys(value).sort().join() !==
      "binding,ownerGeneration,retired,version"
  ) {
    throw nativeHttpsOwnerRefused();
  }
  const configuration = {
    version: value.version,
    ownerGeneration: value.ownerGeneration,
    binding: value.binding,
  };
  if (
    !isNativeHttpsOwnerConfiguration(configuration) ||
    configuration.ownerGeneration !== generation ||
    configuration.binding.runtime.home !== home
  ) {
    throw nativeHttpsOwnerRefused();
  }
  return configuration;
}
/** Written only after children close and every durable lease has retired. */
export async function nativeHttpsRecordRetiredOwner(
  configuration: NativeHttpsOwnerConfiguration
): Promise<void> {
  const home = configuration.binding.runtime.home;
  await nativeHttpsPrivateDirectory(
    join(home, "native-https", "released-leases"),
    true
  );
  await nativeHttpsPrivateDirectory(
    join(
      home,
      "native-https",
      "released-leases",
      configuration.ownerGeneration
    ),
    true
  );
  await nativeHttpsWriteNew(
    join(
      home,
      "native-https",
      "released-leases",
      configuration.ownerGeneration,
      "owner-retired.json"
    ),
    { ...configuration, retired: true }
  );
}
export async function nativeHttpsReadRelease(
  home: string,
  identity: NativeHttpsLeaseIdentity
): Promise<NativeHttpsLeaseRelease> {
  for (const path of [
    home,
    join(home, "native-https"),
    join(home, "native-https", "released-leases"),
    join(home, "native-https", "released-leases", identity.ownerGeneration),
  ]) {
    await nativeHttpsPrivateDirectory(path);
  }
  const { bytes } = await nativeHttpsReadFile(
    nativeHttpsLeaseReleasePath(home, identity)
  );
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !(
      isNativeHttpsLeaseRelease(value) &&
      sameNativeHttpsLease(value.identity, identity)
    ) ||
    value.binding.runtime.home !== home
  ) {
    throw nativeHttpsOwnerRefused();
  }
  return value;
}
export async function nativeHttpsRecordRelease(
  release: NativeHttpsLeaseRelease
): Promise<void> {
  const home = release.binding.runtime.home;
  await nativeHttpsPrivateDirectory(
    join(home, "native-https", "released-leases"),
    true
  );
  await nativeHttpsPrivateDirectory(
    join(
      home,
      "native-https",
      "released-leases",
      release.identity.ownerGeneration
    ),
    true
  );
  try {
    const previous = await nativeHttpsReadRelease(home, release.identity);
    if (
      !sameNativeHttpsLease(previous.identity, release.identity) ||
      JSON.stringify(previous.binding) !== JSON.stringify(release.binding)
    ) {
      throw nativeHttpsOwnerRefused();
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
    await nativeHttpsWriteNew(
      nativeHttpsLeaseReleasePath(home, release.identity),
      release
    );
  }
}
export async function nativeHttpsPrivateDirectory(
  path: string,
  create = false
): Promise<void> {
  if (create) {
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if (!(isRecord(error) && error.code === "EEXIST")) {
        throw error;
      }
    });
  }
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  ) {
    throw nativeHttpsOwnerRefused();
  }
}
class PublicationChanging extends Error {}

/** Hard-link publication briefly has two names. Retry observation only, never mutation. */
export async function nativeHttpsReadFile(
  path: string,
  limit = 16_384
): Promise<{ bytes: Buffer; identity: NativeHttpsFileIdentity }> {
  const deadline = Date.now() + 100;
  for (;;) {
    try {
      return await readStableFile(path, limit);
    } catch (error) {
      if (!(error instanceof PublicationChanging)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw nativeHttpsOwnerRefused();
      }
      await Bun.sleep(5);
    }
  }
}
async function readStableFile(
  path: string,
  limit = 16_384
): Promise<{ bytes: Buffer; identity: NativeHttpsFileIdentity }> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      (stat.nlink !== 1 && stat.nlink !== 2) ||
      stat.size < 1 ||
      stat.size > limit
    ) {
      throw nativeHttpsOwnerRefused();
    }
    if (stat.nlink === 2) {
      throw new PublicationChanging();
    }
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.length !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw nativeHttpsOwnerRefused();
    }
    if (after.ctimeMs !== stat.ctimeMs || after.nlink !== 1) {
      throw new PublicationChanging();
    }
    return {
      bytes,
      identity: {
        dev: stat.dev,
        ino: stat.ino,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  } finally {
    await file.close();
  }
}
export async function nativeHttpsWriteNew(
  path: string,
  value: unknown
): Promise<NativeHttpsFileIdentity> {
  const temporary = `${path}.${crypto.randomUUID()}.pending`;
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600
  );
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
    await file.close();
    await link(temporary, path);
  } finally {
    await file.close();
    await unlink(temporary);
  }
  const directory = await open(join(path, ".."), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return (await nativeHttpsReadFile(path)).identity;
}
/** Never unlink a replacement file, including one with identical JSON bytes. */
export async function nativeHttpsRemoveFile(
  path: string,
  identity: NativeHttpsFileIdentity
): Promise<void> {
  const current = await nativeHttpsReadFile(path);
  if (
    current.identity.dev !== identity.dev ||
    current.identity.ino !== identity.ino ||
    current.identity.sha256 !== identity.sha256
  ) {
    throw nativeHttpsOwnerRefused();
  }
  await unlink(path);
}
export async function nativeHttpsExecutableSha256(
  path: string
): Promise<string> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o022) !== 0 ||
      (stat.mode & 0o111) === 0 ||
      stat.size > 256 * 1024 * 1024 ||
      (await realpath(path)) !== path
    ) {
      throw nativeHttpsOwnerRefused();
    }
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    const after = await file.stat();
    if (
      after.ctimeMs !== stat.ctimeMs ||
      after.mtimeMs !== stat.mtimeMs ||
      after.size !== stat.size
    ) {
      throw nativeHttpsOwnerRefused();
    }
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}
