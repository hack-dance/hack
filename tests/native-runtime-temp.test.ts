import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  nativeCombinedTempDirectory,
  sweepAbandonedNativeCombinedDirectories,
} from "../src/lib/native-runtime-temp.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hack-combined-sweep-"));
  roots.push(path);
  return path;
}

async function combined(
  parent: string,
  name: string,
  files: readonly string[] = ["compose.json"]
): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 });
  for (const file of files) {
    await writeFile(join(path, file), "{}", { mode: 0o600 });
  }
  return path;
}

test("the combined directory name records this process", async () => {
  const path = await nativeCombinedTempDirectory();
  roots.push(path);
  expect(basename(path)).toMatch(
    new RegExp(`^hack-native-combined-${process.pid}-[A-Za-z0-9]{6}$`)
  );
});

test("a killed append's combined file is removed by the next run", async () => {
  const parent = await root();
  const dead = await combined(parent, "hack-native-combined-41-AbC123");
  const live = await combined(parent, "hack-native-combined-42-AbC123");
  const own = await combined(
    parent,
    `hack-native-combined-${process.pid}-AbC123`
  );
  // Something else in the directory: not only the combined file.
  await combined(parent, "hack-native-combined-41-Other1", [
    "compose.json",
    "notes",
  ]);
  // A symlink with a matching name is never followed or removed.
  await symlink(dead, join(parent, "hack-native-combined-41-Link12"));
  await combined(parent, "hack-native-review-41-AbC123");
  const legacyOld = await combined(parent, "hack-native-combined-Old123");
  const legacyNew = await combined(parent, "hack-native-combined-New123");
  const now = Date.now();
  const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);
  await utimes(legacyOld, twoDaysAgo, twoDaysAgo);

  const removed = await sweepAbandonedNativeCombinedDirectories({
    root: parent,
    alive: (pid) => pid === 42,
    now,
  });

  expect([...removed].sort()).toEqual([dead, legacyOld].sort());
  expect((await readdir(parent)).sort()).toEqual(
    [
      basename(live),
      basename(own),
      basename(legacyNew),
      "hack-native-combined-41-Link12",
      "hack-native-combined-41-Other1",
      "hack-native-review-41-AbC123",
    ].sort()
  );
});

test("a missing temp root is not an error", async () => {
  const parent = await root();
  expect(
    await sweepAbandonedNativeCombinedDirectories({
      root: join(parent, "missing"),
    })
  ).toEqual([]);
});
