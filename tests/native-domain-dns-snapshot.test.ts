import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStableNativeDnsFile } from "../src/lib/native-domain-dns-snapshot.ts";

test("native DNS inspection accepts a bounded regular file and a missing path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hack-native-dns-read-"));
  try {
    const path = join(directory, "claim.conf");
    await writeFile(path, "address=/.v5.hack.gy/127.0.0.1\n");
    expect(await readStableNativeDnsFile(path)).toBe(
      "address=/.v5.hack.gy/127.0.0.1\n"
    );
    expect(
      await readStableNativeDnsFile(join(directory, "missing"))
    ).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native DNS inspection refuses a symlink and oversized configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hack-native-dns-read-"));
  try {
    const regular = join(directory, "regular.conf");
    const linked = join(directory, "linked.conf");
    await writeFile(regular, "address=/.v5.hack.gy/127.0.0.1\n");
    await symlink(regular, linked);
    await expect(readStableNativeDnsFile(linked)).rejects.toThrow();
    await writeFile(regular, "x".repeat(1_048_577));
    await expect(readStableNativeDnsFile(regular)).rejects.toThrow(
      "bounded regular file"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
