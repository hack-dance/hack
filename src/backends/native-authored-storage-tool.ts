import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isRecord } from "../lib/guards.ts";

export const NATIVE_STORAGE_TOOL_FILE = "hack-storage-root-witness";
export const NATIVE_STORAGE_TOOL_MANIFEST = "native-storage-tool.json";
const LIMIT = 2 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;

function refused(): Error {
  return new Error(
    "Native persistent storage requires the matching candidate bundle's Linux ARM64 witness tool and manifest; rebuild the candidate bundle. No helper was executed. Values omitted."
  );
}

/** Bundle metadata pins bytes only; kernel ABI and application acceptance are separate gates. */
export type NativeStorageToolManifest = {
  readonly version: 1;
  readonly kind: "native-storage-root-witness";
  readonly platform: "linux";
  readonly architecture: "arm64";
  readonly file: typeof NATIVE_STORAGE_TOOL_FILE;
  readonly sha256: string;
  readonly bytes: number;
  readonly sourceRevision: string;
};

export function parseNativeStorageToolManifest(
  value: unknown
): NativeStorageToolManifest {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "architecture,bytes,file,kind,platform,sha256,sourceRevision,version" ||
    value.version !== 1 ||
    value.kind !== "native-storage-root-witness" ||
    value.platform !== "linux" ||
    value.architecture !== "arm64" ||
    value.file !== NATIVE_STORAGE_TOOL_FILE ||
    typeof value.sha256 !== "string" ||
    !HEX.test(value.sha256) ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 64 ||
    value.bytes > LIMIT ||
    typeof value.sourceRevision !== "string" ||
    !REVISION.test(value.sourceRevision)
  ) {
    throw refused();
  }
  return Object.freeze({
    version: 1,
    kind: "native-storage-root-witness",
    platform: "linux",
    architecture: "arm64",
    file: NATIVE_STORAGE_TOOL_FILE,
    sha256: value.sha256,
    bytes: value.bytes,
    sourceRevision: value.sourceRevision,
  });
}

/** Shared byte contract for packaging and admission; this does not execute the ELF. */
export function nativeStorageToolManifest(
  bytes: Uint8Array,
  sourceRevision: string
): NativeStorageToolManifest {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    data.length < 64 ||
    data.length > LIMIT ||
    !data.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) ||
    data.readUInt16LE(18) !== 183
  ) {
    throw refused();
  }
  return parseNativeStorageToolManifest({
    version: 1,
    kind: "native-storage-root-witness",
    platform: "linux",
    architecture: "arm64",
    file: NATIVE_STORAGE_TOOL_FILE,
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
    sourceRevision,
  });
}

/** Select actual mounts, not unused storage declarations or inactive workloads. */
export function nativeAuthoredStorageToolRequired(
  plan: Readonly<Record<string, unknown>>
): boolean {
  return [plan.services, plan.jobs].some(
    (group) =>
      isRecord(group) &&
      Object.values(group).some(
        (workload) =>
          isRecord(workload) &&
          Array.isArray(workload.mounts) &&
          workload.mounts.some(
            (mount) => isRecord(mount) && Object.hasOwn(mount, "storage")
          )
      )
  );
}

function same(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size
  );
}
async function held(path: string, limit: number, executable: boolean) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const identity = await file.stat();
    const uid = process.getuid?.();
    if (
      !identity.isFile() ||
      uid === undefined ||
      identity.uid !== uid ||
      identity.nlink !== 1 ||
      (identity.mode & 0o022) !== 0 ||
      (executable && (identity.mode & 0o100) === 0) ||
      identity.size < 1 ||
      identity.size > limit
    ) {
      throw refused();
    }
    const read = async (): Promise<Buffer> => {
      if (
        !(
          same(identity, await file.stat()) && same(identity, await lstat(path))
        )
      ) {
        throw refused();
      }
      const buffer = Buffer.alloc(identity.size + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          used,
          buffer.length - used,
          used
        );
        if (bytesRead === 0) {
          break;
        }
        used += bytesRead;
      }
      if (
        used !== identity.size ||
        !same(identity, await file.stat()) ||
        !same(identity, await lstat(path))
      ) {
        throw refused();
      }
      return buffer.subarray(0, used);
    };
    const bytes = await read();
    return {
      bytes,
      close: () => file.close(),
      fresh: async () => {
        if (!(await read()).equals(bytes)) {
          throw refused();
        }
      },
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export type NativeAuthoredStorageTool = {
  readonly path: string;
  readonly digest: string;
  readonly assertFresh: () => Promise<void>;
  readonly close: () => Promise<void>;
};

/**
 * Resolve only the explicitly selected native binary's sibling bundle. Held reads
 * reject leaf symlinks, hardlinks, files writable by other users and byte-identical replacements. Rust
 * independently reads the captured path/digest before provider admission. No fetch,
 * host execution or emulation is attempted, and saved cleanup needs no host tool.
 */
export async function resolveNativeAuthoredStorageTool(
  binary: string
): Promise<NativeAuthoredStorageTool> {
  let manifest: Awaited<ReturnType<typeof held>> | undefined;
  let tool: Awaited<ReturnType<typeof held>> | undefined;
  try {
    if (!isAbsolute(binary)) {
      throw refused();
    }
    const parent = await realpath(dirname(binary));
    const directory = await lstat(parent);
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o777) !== 0o700
    ) {
      throw refused();
    }
    manifest = await held(
      join(parent, NATIVE_STORAGE_TOOL_MANIFEST),
      4096,
      false
    );
    const selected = parseNativeStorageToolManifest(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes)
      )
    );
    const path = join(parent, selected.file);
    tool = await held(path, LIMIT, true);
    const observed = nativeStorageToolManifest(
      tool.bytes,
      selected.sourceRevision
    );
    if (
      observed.bytes !== selected.bytes ||
      observed.sha256 !== selected.sha256
    ) {
      throw refused();
    }
    const savedManifest = manifest;
    const savedTool = tool;
    let closed = false;
    const assertFresh = async () => {
      if (
        closed ||
        !same(directory, await lstat(parent)) ||
        (await realpath(dirname(binary))) !== parent
      ) {
        throw refused();
      }
      await savedManifest.fresh();
      await savedTool.fresh();
      if (!same(directory, await lstat(parent))) {
        throw refused();
      }
    };
    await assertFresh();
    return Object.freeze({
      path,
      digest: selected.sha256,
      assertFresh,
      close: async () => {
        if (!closed) {
          closed = true;
          await Promise.all([savedManifest.close(), savedTool.close()]);
        }
      },
    });
  } catch {
    await Promise.allSettled([manifest?.close(), tool?.close()]);
    throw refused();
  }
}
