import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HeldDirectory,
  holdDirectory,
  recheckDirectories,
} from "../src/lib/native-compose-private-state.ts";

const roots: string[] = [];
const held: HeldDirectory[] = [];
afterEach(async () => {
  await Promise.all(held.splice(0).map((directory) => directory.file.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function tree(...paths: readonly string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-recheck-")));
  roots.push(root);
  for (const path of paths) {
    await mkdir(join(root, path), { recursive: true });
  }
  return root;
}
async function hold(...paths: readonly string[]) {
  const directories: HeldDirectory[] = [];
  for (const path of paths) {
    const directory = await holdDirectory(path, false);
    held.push(directory);
    directories.push(directory);
  }
  return directories;
}
async function realpathCalls(run: () => Promise<void>) {
  const original = fs.realpath;
  let calls = 0;
  const spy = spyOn(fs, "realpath").mockImplementation(((
    ...args: Parameters<typeof original>
  ) => {
    calls++;
    return original(...args);
  }) as typeof original);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return calls;
}

test("a held chain proves canonical paths with one realpath at its deepest directory", async () => {
  const root = await tree("p/a/b/c", "p/a/bc");
  const chain = await hold(
    join(root, "p/a"),
    join(root, "p/a/b"),
    join(root, "p/a/b/c")
  );
  expect(await realpathCalls(() => recheckDirectories(chain))).toBe(1);
  // A name that only shares a string prefix is not beneath its neighbour.
  const prefixOnly = await hold(join(root, "p/a/b"), join(root, "p/a/bc"));
  expect(await realpathCalls(() => recheckDirectories(prefixOnly))).toBe(2);
});

test("a symlink above a held chain still refuses through its deepest directory", async () => {
  const root = await tree("p/a/b");
  const chain = await hold(join(root, "p/a"), join(root, "p/a/b"));
  // Each held path still lstats to its held inode; only a canonical-path
  // check can see the substituted symlink component above them.
  await rename(join(root, "p"), join(root, "moved"));
  await symlink(join(root, "moved"), join(root, "p"));
  for (const batch of [chain, [chain[0] as HeldDirectory]]) {
    await expect(recheckDirectories(batch)).rejects.toMatchObject({
      code: "E_NATIVE_COMPOSE_STATE",
    });
  }
});

test("a held ancestor replaced by a symlink refuses", async () => {
  const root = await tree("p/a/b");
  const chain = await hold(join(root, "p/a"), join(root, "p/a/b"));
  await rename(join(root, "p/a"), join(root, "p/moved"));
  await symlink(join(root, "p/moved"), join(root, "p/a"));
  await expect(recheckDirectories(chain)).rejects.toMatchObject({
    code: "E_NATIVE_COMPOSE_STATE",
  });
});
