import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeFileUnknownStopWrapper,
  normalizeNativeFileObservation,
  observeNativeFileFixtureMembers,
} from "./e2e/scenarios/native-config-files.ts";

test("metadata normalization preserves optional mount names, complete rows, duplicates, counts and engine identity", () => {
  const bind = {
    type: "bind",
    name: null,
    source: "/synthetic/private",
    target: "/target",
    rw: false,
    extra: "preserved",
  };
  const volume = {
    type: "volume",
    name: "synthetic-volume",
    source: "/synthetic/data",
    target: "/data",
    rw: true,
  };
  const before = {
    id: "a".repeat(64),
    name: "fixture",
    image: `sha256:${"b".repeat(64)}`,
    createdAt: "original-birth",
    running: false,
    mounts: [volume, bind, bind],
    networks: [
      { name: "z", id: "2" },
      { name: "a", id: "1" },
    ],
  };
  const normalized = normalizeNativeFileObservation(before);
  expect(
    normalizeNativeFileObservation({
      ...before,
      mounts: [bind, volume, bind],
      networks: [...before.networks].reverse(),
    })
  ).toEqual(normalized);
  expect(normalized.mounts).toHaveLength(3);
  expect(before.mounts).toEqual([volume, bind, bind]);
  for (const changed of [
    { ...before, mounts: [volume, bind] },
    { ...before, mounts: [volume, { ...bind, rw: true }, bind] },
    { ...before, mounts: [volume, { ...bind, source: "/other" }, bind] },
    { ...before, createdAt: "replacement-birth" },
    { ...before, running: true },
    { ...before, id: "c".repeat(64) },
  ]) {
    expect(normalizeNativeFileObservation(changed)).not.toEqual(normalized);
  }
});

test("unknown-stop delegation preserves a multiplexed Docker executable name instead of executing its canonical shared tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-file-argv0-"));
  const shared = join(root, "shared-tools"),
    docker = join(root, "docker"),
    wrapper = join(root, "wrapper");
  try {
    await writeFile(
      shared,
      '#!/bin/sh\ncase "$0" in */docker) printf delegated;; *) exit 71;; esac\n',
      { mode: 0o700 }
    );
    await symlink(shared, docker);
    for (const [executable, code, output] of [
      [docker, 0, "delegated"],
      [await realpath(docker), 71, ""],
    ] as const) {
      await writeFile(
        wrapper,
        nativeFileUnknownStopWrapper({
          executable,
          bun: process.execPath,
          marker: join(root, "marker"),
        }),
        { mode: 0o700 }
      );
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", wrapper, "version"],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 2000 }
      );
      const [actual, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(actual).toBe(code);
      expect(stdout).toBe(output);
      expect(stderr).toBe("");
      expect(await Bun.file(join(root, "marker")).exists()).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("actual private member observation distinguishes same-mode content drift and same-byte inode replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-file-evidence-"));
  const member = join(root, "member");
  try {
    await writeFile(member, Buffer.from([0, 255, 3]), { mode: 0o444 });
    await chmod(member, 0o444);
    const original = await observeNativeFileFixtureMembers([member]);
    await chmod(member, 0o600);
    await writeFile(member, Buffer.from([0, 254, 3]));
    await chmod(member, 0o444);
    const changed = await observeNativeFileFixtureMembers([member]);
    expect(changed[0]?.mode).toBe(original[0]?.mode);
    expect(changed[0]?.ino).toBe(original[0]?.ino);
    expect(changed).not.toEqual(original);
    await rename(member, join(root, "original"));
    await writeFile(member, Buffer.from([0, 255, 3]), { mode: 0o444 });
    await chmod(member, 0o444);
    const replaced = await observeNativeFileFixtureMembers([member]);
    expect(replaced[0]?.digest).toBe(original[0]?.digest);
    expect(replaced[0]?.mode).toBe(original[0]?.mode);
    expect(replaced).not.toEqual(original);
    await chmod(member, 0o600);
    await writeFile(member, Buffer.alloc(0));
    await chmod(member, 0o444);
    expect(await observeNativeFileFixtureMembers([member])).not.toEqual(
      original
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
