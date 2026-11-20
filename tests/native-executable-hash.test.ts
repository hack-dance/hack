import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  link,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeExecutableDigests } from "../src/backends/native-executable-hash.ts";

/**
 * Walks the transitions of `tests/models/tla/executable-digest-cache`
 * (`DigestCache.tla`): CacheHit, WriteInPlace, Replace, BeginRead/FinishRead
 * with and without the racy guard, and refusal. The clock is injected: a
 * test cannot age a file's change time, so "later" means a clock that reads
 * ahead of it.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

class Refused extends Error {}
const refused = () => new Refused("refused");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
/** A clock that reads well past the racy window after every write. */
const later = () => nowNs() + 60_000_000_000n;

async function executable(content: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-exe-")));
  roots.push(root);
  const path = join(root, "tool");
  await writeFile(path, content, { mode: 0o755 });
  return { root, path };
}

test("an unchanged executable is read once per process (CacheHit)", async () => {
  const { path } = await executable("version-a");
  const digests = createNativeExecutableDigests({ nowNs: later });
  expect(await digests.sha256(path, { refused })).toBe(sha("version-a"));
  expect(await digests.sha256(path, { refused })).toBe(sha("version-a"));
  expect(await digests.sha256(path, { refused })).toBe(sha("version-a"));
  expect(digests.reads()).toBe(1);
});

test("an in-place same-size write is read again (WriteInPlace)", async () => {
  const { path } = await executable("version-a");
  const digests = createNativeExecutableDigests({ nowNs: later });
  expect(await digests.sha256(path, { refused })).toBe(sha("version-a"));
  await Bun.sleep(5);
  await writeFile(path, "version-b");
  expect(await digests.sha256(path, { refused })).toBe(sha("version-b"));
  expect(digests.reads()).toBe(2);
});

test("a replaced executable is read again (Replace)", async () => {
  const { root, path } = await executable("version-a");
  const digests = createNativeExecutableDigests({ nowNs: later });
  expect(await digests.sha256(path, { refused })).toBe(sha("version-a"));
  const next = join(root, "tool.next");
  await writeFile(next, "version-b", { mode: 0o755 });
  await rename(next, path);
  expect(await digests.sha256(path, { refused })).toBe(sha("version-b"));
  expect(digests.reads()).toBe(2);
});

test("a file changed within the racy window is hashed but not cached (RacyGuard)", async () => {
  const { path } = await executable("version-a");
  // The real clock: the file was just written.
  const digests = createNativeExecutableDigests({ nowNs });
  expect(await digests.sha256(path, { refused })).toBe(sha("version-a"));
  expect(await digests.sha256(path, { refused })).toBe(sha("version-a"));
  expect(digests.reads()).toBe(2);
});

test("a fresh check always reads the file", async () => {
  const { path } = await executable("version-a");
  const digests = createNativeExecutableDigests({ nowNs: later });
  await digests.sha256(path, { refused });
  expect(await digests.sha256(path, { refused, fresh: true })).toBe(
    sha("version-a")
  );
  expect(digests.reads()).toBe(2);
});

test("a cached executable still gets every check on a fresh stat", async () => {
  const { root, path } = await executable("version-a");
  const digests = createNativeExecutableDigests({ nowNs: later });
  await digests.sha256(path, { refused });
  await chmod(path, 0o775);
  await expect(digests.sha256(path, { refused })).rejects.toBeInstanceOf(
    Refused
  );
  await chmod(path, 0o644);
  await expect(digests.sha256(path, { refused })).rejects.toBeInstanceOf(
    Refused
  );
  await chmod(path, 0o755);
  const link = join(root, "tool-link");
  await symlink(path, link);
  await expect(digests.sha256(link, { refused })).rejects.toThrow();
});

test("a multi-buffer executable hashes like a single read", async () => {
  // Larger than two 4 MiB read buffers, with a short final chunk.
  const content = "0123456789abcdef".repeat(600_001);
  const { path } = await executable(content);
  const digests = createNativeExecutableDigests({ nowNs: later });
  expect(await digests.sha256(path, { refused })).toBe(sha(content));
});

test("an empty executable hashes as empty input", async () => {
  const { path } = await executable("");
  const digests = createNativeExecutableDigests({ nowNs: later });
  expect(await digests.sha256(path, { refused })).toBe(sha(""));
});

test("a file that changes during the read is refused and not cached (RefuseRead)", async () => {
  const { path } = await executable("version-a");
  let change: (() => Promise<void>) | undefined = async () => {
    await Bun.sleep(5);
    await writeFile(path, "version-b");
  };
  const digests = createNativeExecutableDigests({
    nowNs: later,
    afterRead: async () => {
      const once = change;
      change = undefined;
      await once?.();
    },
  });
  await expect(digests.sha256(path, { refused })).rejects.toBeInstanceOf(
    Refused
  );
  expect(await digests.sha256(path, { refused })).toBe(sha("version-b"));
  expect(digests.reads()).toBe(2);
});

test("a file that grows during the read is refused", async () => {
  const { path } = await executable("version-a");
  const digests = createNativeExecutableDigests({
    nowNs: later,
    afterRead: () => appendFile(path, "-more"),
  });
  await expect(digests.sha256(path, { refused })).rejects.toBeInstanceOf(
    Refused
  );
});

test("a single-link check refuses a hard-linked or empty executable, cached or not", async () => {
  const { root, path } = await executable("version-a");
  const digests = createNativeExecutableDigests({ nowNs: later });
  expect(await digests.sha256(path, { refused, singleLink: true })).toBe(
    sha("version-a")
  );
  // A second hard link appears after the digest was cached.
  await link(path, join(root, "second-link"));
  await expect(
    digests.sha256(path, { refused, singleLink: true })
  ).rejects.toBeInstanceOf(Refused);
  // Callers without the rule still accept it.
  expect(await digests.sha256(path, { refused })).toBe(sha("version-a"));
  const empty = await executable("");
  await expect(
    digests.sha256(empty.path, { refused, singleLink: true })
  ).rejects.toBeInstanceOf(Refused);
});
