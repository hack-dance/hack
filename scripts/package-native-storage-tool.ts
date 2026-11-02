import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  NATIVE_STORAGE_TOOL_FILE,
  NATIVE_STORAGE_TOOL_MANIFEST,
  nativeStorageToolManifest,
} from "../src/backends/native-authored-storage-tool.ts";

/** Package existing bytes only; no build or helper execution occurs in this module. */
export async function packageNativeStorageTool(opts: {
  readonly directory: string;
  readonly sourceRevision: string;
}): Promise<void> {
  if (!isAbsolute(opts.directory)) {
    throw new Error(
      "Storage tool packaging requires an absolute private bundle directory."
    );
  }
  const directory = await lstat(opts.directory);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      "Storage tool packaging requires an owned private bundle directory."
    );
  }
  const path = join(opts.directory, NATIVE_STORAGE_TOOL_FILE);
  const input = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0 ||
      (before.mode & 0o100) === 0 ||
      before.size < 64 ||
      before.size > 2 * 1024 * 1024
    ) {
      throw new Error("Storage tool packaging refused artifact metadata.");
    }
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await input.read(
        bytes,
        used,
        bytes.length - used,
        used
      );
      if (bytesRead === 0) {
        break;
      }
      used += bytesRead;
    }
    const after = await input.stat();
    const named = await lstat(path);
    for (const actual of [after, named]) {
      if (
        !actual.isFile() ||
        actual.dev !== before.dev ||
        actual.ino !== before.ino ||
        actual.uid !== before.uid ||
        actual.gid !== before.gid ||
        actual.mode !== before.mode ||
        actual.nlink !== 1 ||
        actual.size !== before.size ||
        used !== before.size
      ) {
        throw new Error(
          "Storage tool packaging refused changed artifact identity."
        );
      }
    }
    const manifest = nativeStorageToolManifest(
      bytes.subarray(0, used),
      opts.sourceRevision
    );
    const output = await open(
      join(opts.directory, NATIVE_STORAGE_TOOL_MANIFEST),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600
    );
    try {
      await output.writeFile(`${JSON.stringify(manifest)}\n`);
      await output.sync();
    } finally {
      await output.close();
    }
    const parent = await open(
      opts.directory,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK
    );
    try {
      const actual = await parent.stat();
      if (
        actual.dev !== directory.dev ||
        actual.ino !== directory.ino ||
        actual.mode !== directory.mode ||
        actual.uid !== directory.uid
      ) {
        throw new Error(
          "Storage tool packaging refused changed bundle identity."
        );
      }
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await input.close();
  }
}

if (import.meta.main) {
  const [directory, sourceRevision, ...extra] = process.argv.slice(2);
  if (!(directory && sourceRevision) || extra.length !== 0) {
    throw new Error(
      "Usage: package-native-storage-tool.ts /absolute/bundle source-head"
    );
  }
  await packageNativeStorageTool({ directory, sourceRevision });
}
