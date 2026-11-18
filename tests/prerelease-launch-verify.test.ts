import { afterEach, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../scripts/installer/channel.ts";
import { digest, hash, jsonBytes } from "../scripts/installer/integrity.ts";
import { restoreEnv } from "./helpers/env.ts";

/**
 * A `hack-next` launch hashes every file of the selected candidate. It used
 * to do that twice per call: once in the validation inside `lock()` and once
 * more in `run()`. These tests hold the launch to one verification and show
 * that every path that did not just verify under the lock still does.
 */
const VERSION = "5.0.0-next.1";
const roots: string[] = [];
const previousBackend = process.env.HACK_RUNTIME_BACKEND;

afterEach(() => {
  restoreEnv("HACK_RUNTIME_BACKEND", previousBackend);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function installedChannel(): Promise<{
  readonly root: string;
  readonly source: string;
  readonly open: () => Channel;
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hack-launch-verify-")));
  roots.push(root);
  const source = join(root, "source-manager");
  writeFileSync(source, "manager-one");
  const hooks = { signatures: () => undefined, quiescence: () => undefined };
  const open = () => new Channel(join(root, "channel"), source, hooks);
  const channel = open();
  channel.initialize();
  channel.validate();

  const bundle = join(root, "bundle");
  mkdirSync(bundle, { mode: 0o700 });
  const files: Record<string, Uint8Array> = {
    "hack-native": Buffer.from("fixture-native"),
    "hack-relay-guest": Buffer.from("fixture-guest"),
    // The Compose backend starts this file directly.
    "hack-cli": Buffer.from("#!/bin/sh\nexit 0\n"),
    "hack-v5": Buffer.from("#!/bin/sh\nexit 0\n"),
    "provider-pins.json": Buffer.from("{}\n"),
    "README.md": Buffer.from("fixture\n"),
    "prerelease.json": jsonBytes({
      schema: "hack.prerelease/v1",
      version: VERSION,
      tag: `v${VERSION}`,
      source_revision: "a".repeat(40),
      platform: "darwin-arm64",
    }),
  };
  files.SHA256SUMS = Buffer.from(
    Object.entries(files)
      .map(([name, bytes]) => `${hash(bytes)}  ${name}\n`)
      .join("")
  );
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(bundle, name), bytes, {
      mode: name.startsWith("hack-") ? 0o755 : 0o600,
    });
  }
  const archive = join(root, `${VERSION}.tar.gz`);
  const tar = Bun.spawnSync(
    [
      "/usr/bin/tar",
      "--format=ustar",
      "-czf",
      archive,
      "-C",
      bundle,
      ...Object.keys(files),
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, timeout: 10_000 }
  );
  expect(tar.exitCode).toBe(0);
  await channel.install(VERSION, archive, digest(archive));
  return { root, source, open };
}

test("a launch through lock() verifies the selected candidate once", async () => {
  const fixture = await installedChannel();
  process.env.HACK_RUNTIME_BACKEND = "compose";
  const channel = fixture.open();
  const verify = spyOn(channel, "verifyVersion");
  const release = channel.lock(true);
  try {
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await channel.run(["--version"])).toBe(0);
    expect(verify).toHaveBeenCalledTimes(1);
    // The lock's verification covers one launch, not every later one.
    expect(await channel.run(["--version"])).toBe(0);
    expect(verify).toHaveBeenCalledTimes(2);
  } finally {
    release();
  }
}, 30_000);

test("a launch that did not just verify under the lock verifies itself", async () => {
  const fixture = await installedChannel();
  process.env.HACK_RUNTIME_BACKEND = "compose";

  // No lock: `validate()` alone leaves nothing for `run()` to reuse.
  const unlocked = fixture.open();
  unlocked.validate();
  const unlockedVerify = spyOn(unlocked, "verifyVersion");
  expect(await unlocked.run(["--version"])).toBe(0);
  expect(unlockedVerify).toHaveBeenCalledTimes(1);

  // A released lock: its verification no longer counts.
  const released = fixture.open();
  released.lock(true)();
  const releasedVerify = spyOn(released, "verifyVersion");
  expect(await released.run(["--version"])).toBe(0);
  expect(releasedVerify).toHaveBeenCalledTimes(1);
}, 30_000);

test("a changed candidate still stops the launch", async () => {
  const fixture = await installedChannel();
  process.env.HACK_RUNTIME_BACKEND = "compose";
  const cli = join(
    fixture.root,
    "channel/versions",
    VERSION,
    "bundle/hack-cli"
  );

  // Verified under a lock that was then released; changed afterwards. The
  // launch has nothing to reuse, verifies and refuses.
  const launched = fixture.open();
  launched.lock(true)();
  appendFileSync(cli, "# changed\n");
  await expect(launched.run(["--version"])).rejects.toThrow(
    "Candidate checksum mismatch"
  );

  // A new launch of the changed candidate is refused by the lock itself.
  expect(() => fixture.open().lock(true)).toThrow(
    "Candidate checksum mismatch"
  );
}, 30_000);
