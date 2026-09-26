import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const LIMIT = 65_536;
function refused(): Error {
  return new Error(
    "Native selection requires a bounded, unchanged regular JSON file; values omitted."
  );
}
/** Selection files contain public intent, never credentials or durable process authority. */
export async function readNativeSelection(path: string): Promise<unknown> {
  if (!isAbsolute(path)) {
    throw refused();
  }
  try {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size === 0 ||
        before.size > LIMIT
      ) {
        throw refused();
      }
      const buffer = Buffer.alloc(LIMIT + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const after = await file.stat();
      if (
        bytesRead !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        throw refused();
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, bytesRead)
        )
      );
    } finally {
      await file.close();
    }
  } catch {
    throw refused();
  }
}
