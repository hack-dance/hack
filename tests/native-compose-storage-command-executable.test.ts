import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeComposeStorageCommandExecutableReader } from "../src/lib/native-compose-storage-command-executable.ts";

let root: string;
let path: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "command-executable-")));
  path = join(root, "docker");
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A reader whose clock treats every file as settled, counting content reads. */
function reader(opts: { readonly settled?: boolean } = {}) {
  let digests = 0;
  const read = createNativeComposeStorageCommandExecutableReader({
    now: opts.settled === false ? Date.now : () => Date.now() + 60_000,
    digest: async (file, size) => {
      digests++;
      const bytes = Buffer.alloc(size);
      await file.read(bytes, 0, size, 0);
      return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    },
  });
  return { read, digests: () => digests };
}

test("an unchanged stat identity reuses the digest and still returns the full identity", async () => {
  const { read, digests } = reader();
  const first = await read(path);
  expect(await read(path)).toEqual(first);
  expect(await read(path)).toEqual(first);
  expect(digests()).toBe(1);
  expect(first).toMatchObject({
    path,
    hash: new Bun.CryptoHasher("sha256")
      .update(await readFile(path))
      .digest("hex"),
  });
});
test("replacing the executable between reads is a new identity and is re-read", async () => {
  const { read, digests } = reader();
  const first = await read(path);
  // Same bytes, new inode: the recorded identity no longer matches.
  await rename(path, join(root, "original"));
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const same = await read(path);
  expect(same.ino).not.toBe(first.ino);
  expect(same.hash).toBe(first.hash);
  // Different bytes behind the same path: a different digest.
  await rename(path, join(root, "second"));
  await writeFile(path, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
  const replaced = await read(path);
  expect(replaced.hash).not.toBe(first.hash);
  expect(digests()).toBe(3);
});
test("same-size in-place tamper with restored mtime is re-read through ctime", async () => {
  const { read, digests } = reader();
  const first = await read(path);
  const before = await Bun.file(path).stat();
  const bytes = await readFile(path, "utf8");
  await writeFile(path, bytes.replace("exit 0", "exit 9"));
  await utimes(path, before.atime, before.mtime);
  const tampered = await read(path);
  expect([tampered.ino, tampered.size]).toEqual([first.ino, first.size]);
  expect(tampered.hash).not.toBe(first.hash);
  expect(digests()).toBe(2);
});
test("mode changes are re-read and group or other writable files still refuse", async () => {
  const { read, digests } = reader();
  const first = await read(path);
  await chmod(path, 0o500);
  expect((await read(path)).mode).not.toBe(first.mode);
  expect(digests()).toBe(2);
  await chmod(path, 0o720);
  await expect(read(path)).rejects.toThrow("values omitted");
  await chmod(path, 0o700);
  await link(path, join(root, "second-link"));
  await expect(read(path)).rejects.toThrow("values omitted");
});
test("a racily fresh executable is never cached", async () => {
  const { read, digests } = reader({ settled: false });
  await read(path);
  await read(path);
  await read(path);
  expect(digests()).toBe(3);
});
test("a changed canonical target is a different cache entry", async () => {
  const { read, digests } = reader();
  const other = join(root, "other");
  await writeFile(other, "#!/bin/sh\nexit 3\n", { mode: 0o700 });
  const alias = join(root, "alias");
  await symlink(path, alias);
  const first = await read(alias);
  expect(first.path).toBe(path);
  await rm(alias);
  await symlink(other, alias);
  const second = await read(alias);
  expect(second.path).toBe(other);
  expect(second.hash).not.toBe(first.hash);
  expect(digests()).toBe(2);
});
