import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const CHECKSUM_LINE = /^([a-f0-9]{64}) {2}([A-Za-z0-9._/-]+)$/;
/** Every release payload file must be named once by the inner release checksum list. */
export async function verifyReleaseDirectory(root: string) {
  const lines = (await readFile(join(root, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n");
  const expected = new Map<string, string>();
  for (const line of lines) {
    const match = CHECKSUM_LINE.exec(line);
    const name = match?.[2];
    if (
      !(match?.[1] && name) ||
      name.startsWith("/") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      name === "SHA256SUMS" ||
      expected.has(name)
    ) {
      throw new Error(
        "Invalid release checksum inventory; installation unchanged."
      );
    }
    expected.set(name, match[1]);
  }
  if (!expected.has("hack")) {
    throw new Error(
      "Release checksum inventory omits hack; installation unchanged."
    );
  }
  const found = new Set<string>();
  const walk = async (path: string) => {
    for (const item of await readdir(path)) {
      const file = join(path, item);
      const info = await lstat(file);
      if (info.isDirectory()) {
        await walk(file);
      } else if (info.isFile()) {
        const name = relative(root, file);
        if (name === "SHA256SUMS") {
          continue;
        }
        const hash = createHash("sha256");
        const reader = Bun.file(file).stream().getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            hash.update(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        if (expected.get(name) !== hash.digest("hex")) {
          throw new Error(
            "Release payload checksum mismatch; installation unchanged."
          );
        }
        found.add(name);
      } else {
        throw new Error(
          "Release contains a link or special file; installation unchanged."
        );
      }
    }
  };
  await walk(root);
  if (found.size !== expected.size) {
    throw new Error("Release payload is incomplete; installation unchanged.");
  }
}
