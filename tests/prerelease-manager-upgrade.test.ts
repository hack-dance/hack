import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveName,
  listedDigest,
  MANAGER_ASSET,
  PUBLISHED_ARCHIVES,
  previousPrerelease,
} from "../scripts/check-prerelease-upgrade.ts";
import {
  Channel,
  REVIEWED_PREDECESSORS,
} from "../scripts/installer/channel.ts";
import { digest, hash, jsonBytes } from "../scripts/installer/integrity.ts";
// The next.17 manager as it shipped (see the fixture's README).
import { Channel as Next17Channel } from "./fixtures/prerelease-manager-next17/channel.ts";

// HACK-2262: a channel installed by 5.0.0-next.17 could not upgrade to next.18.
// The retained next.17 manager validates every archive member against its own
// allowlist, and next.18's archive adds `hack-lifecycle-supervisor`.

const fixtureTest = (name: string, run: () => void | Promise<void>) =>
  test(name, run, 30_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hack-mgr-upgrade-")));
  roots.push(root);
  return root;
}
const revision = "a".repeat(40);
const hooks = { signatures: () => {}, quiescence: () => {} };

/** A bundle archive of `version` with the core files plus `extra` members. */
function archive(
  root: string,
  version: string,
  extra: Record<string, string> = {}
) {
  const bundle = join(root, `bundle-${version}-${Object.keys(extra).length}`);
  mkdirSync(bundle, { mode: 0o700 });
  const files: Record<string, Uint8Array> = {
    "hack-native": Buffer.from("fixture-native"),
    "hack-relay-guest": Buffer.from("fixture-guest"),
    "hack-cli": Buffer.from("fixture-cli"),
    "hack-v5": Buffer.from("fixture-launcher"),
    "provider-pins.json": Buffer.from("{}\n"),
    "README.md": Buffer.from("fixture\n"),
    "prerelease.json": jsonBytes({
      schema: "hack.prerelease/v1",
      version,
      tag: `v${version}`,
      source_revision: revision,
      platform: "darwin-arm64",
    }),
    ...Object.fromEntries(
      Object.entries(extra).map(([name, text]) => [name, Buffer.from(text)])
    ),
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
  const path = join(root, `${version}-${Object.keys(extra).length}.tar.gz`);
  const tar = Bun.spawnSync(
    [
      "/usr/bin/tar",
      "--format=ustar",
      "-czf",
      path,
      "-C",
      bundle,
      ...Object.keys(files),
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, timeout: 10_000 }
  );
  expect(tar.exitCode).toBe(0);
  return { archive: path, checksum: digest(path) };
}
const next18Payload = { "hack-lifecycle-supervisor": "#!/bin/sh\nexit 0\n" };

fixtureTest(
  "a next.17 channel refuses the next.18 bundle, and the next manager's upgrade-manager takes it over",
  async () => {
    const root = scratch();
    const channelRoot = join(root, "channel");
    // The retained manager is a byte copy of the installer that created the
    // channel; its bytes stand for the released next.17 manager.
    const next17Source = join(root, "hack-next-manager-next17");
    writeFileSync(next17Source, "next.17 manager bytes", { mode: 0o700 });
    const next17 = new Next17Channel(channelRoot, next17Source, hooks);
    next17.initialize();
    const a17 = archive(root, "5.0.0-next.17");
    await next17.install("5.0.0-next.17", a17.archive, a17.checksum);
    const a18 = archive(root, "5.0.0-next.18", next18Payload);

    // The refusal the Mac saw, from the manager that shipped.
    await expect(
      next17.install("5.0.0-next.18", a18.archive, a18.checksum, true)
    ).rejects.toThrow("Foreign, duplicate or traversing archive entry.");
    expect(next17.state.selected).toBe("5.0.0-next.17");

    // The next release's standalone manager cannot install into a channel that
    // another manager owns, and says how to take it over.
    const nextSource = join(root, "hack-next-manager-next");
    writeFileSync(nextSource, "next manager bytes", { mode: 0o700 });
    const fresh = new Channel(channelRoot, nextSource, hooks);
    fresh.validate();
    await expect(
      fresh.install("5.0.0-next.18", a18.archive, a18.checksum, true)
    ).rejects.toThrow("upgrade-manager");

    // Only a listed predecessor is replaced: these fixture bytes are not a
    // released manager, so the shipped list refuses them...
    expect(() => fresh.upgradeManager()).toThrow(
      "explicit upgrade supports only reviewed predecessors"
    );
    // ...and the same bytes listed as a predecessor are taken over.
    const next = new Channel(channelRoot, nextSource, {
      ...hooks,
      predecessors: [hash(Buffer.from("next.17 manager bytes"))],
    });
    next.validate();
    next.upgradeManager();
    expect(digest(join(channelRoot, "manager"))).toBe(
      hash(Buffer.from("next manager bytes"))
    );
    // The documented command then upgrades with the new retained manager. The
    // next.17 bundle and its homes are kept for rollback.
    await next.install("5.0.0-next.18", a18.archive, a18.checksum, true);
    expect(next.state.selected).toBe("5.0.0-next.18");
    expect(Object.keys(next.state.installed).sort()).toEqual([
      "5.0.0-next.17",
      "5.0.0-next.18",
    ]);
  }
);

test("the released compiled managers are reviewed predecessors", () => {
  // Each digest is hack-next-manager-darwin-arm64 in that release's
  // INSTALLER-SHA256SUMS.
  expect(REVIEWED_PREDECESSORS).toEqual([
    "ed606f521e36685d33657d91eed171cd612e6e66e3d83bdfa773a3aaeaf4fd71", // next.6-7
    "e6c667aa32bc345b3a58bc487f0c9a4a6e4fb68d2ae9a35f2bbbbf745a5a4f05", // next.8-12
    "3feb7cef0d1eff57ae54d2ee031fca2e769c9610acab3a04079b7b75cee81e3d", // next.13-16
    "85bbe4f064b3277efc88a9f79c197e81950ab8881320aef1b3443b70d95b530f", // next.17
    "90d1bc60bfd2b7eaad48dcf56ad45264f395c0ac1a8c4530e986be7fa194d4d9", // next.18
  ]);
});

fixtureTest(
  "an unknown payload from a newer release is refused with the step that fixes it",
  async () => {
    const root = scratch();
    const source = join(root, "manager");
    writeFileSync(source, "manager bytes", { mode: 0o700 });
    const channel = new Channel(join(root, "channel"), source, hooks);
    channel.initialize();
    const future = archive(root, "5.0.0-next.30", {
      "hack-future-tool": "#!/bin/sh\nexit 0\n",
    });
    const refusal = channel.install(
      "5.0.0-next.30",
      future.archive,
      future.checksum
    );
    await expect(refusal).rejects.toThrow("hack-future-tool");
    await expect(refusal).rejects.toThrow("upgrade-manager");
    await expect(refusal).rejects.toThrow("nothing changed");
    expect(channel.state.selected).toBeNull();
    // A name that is not a plain file name keeps the generic refusal and is
    // never echoed back.
    const nested = archive(root, "5.0.0-next.31", {
      ".hidden-payload": "x",
    });
    await expect(
      channel.install("5.0.0-next.31", nested.archive, nested.checksum)
    ).rejects.toThrow("Foreign, duplicate or traversing archive entry.");
  }
);

test("the release gate upgrades from the newest published prerelease before the candidate", () => {
  const tags = [
    "v5.0.0-next.9",
    "v5.0.0-next.17",
    "v5.0.0-next.18",
    "v5.0.0-next.19",
    "v4.9.0",
    "v5.0.0-next.18-rc",
    "not-a-tag",
  ];
  expect(previousPrerelease(tags, "5.0.0-next.19")).toBe("5.0.0-next.18");
  expect(previousPrerelease(tags, "5.0.0-next.18")).toBe("5.0.0-next.17");
  expect(previousPrerelease(tags, "5.1.0-next.1")).toBe("5.0.0-next.19");
  expect(previousPrerelease(["v4.9.0"], "5.0.0-next.1")).toBeNull();
  expect(archiveName("5.0.0-next.18")).toBe(
    "hack-5.0.0-next.18-darwin-arm64-native.tar.gz"
  );
  const sums = `${"a".repeat(64)}  ${MANAGER_ASSET}\n${"b".repeat(64)} *hack-next-install.sh\n`;
  expect(listedDigest(sums, MANAGER_ASSET)).toBe("a".repeat(64));
  expect(listedDigest(sums, "hack-next-install.sh")).toBe("b".repeat(64));
  expect(() => listedDigest(sums, "missing")).toThrow("not listed");
});

test("the gate runs a previous release only from reviewed pins", () => {
  // Release assets are mutable: the previous release's archive is pinned in
  // review (its SHA256SUMS when it published), and its manager must be a
  // reviewed predecessor.
  expect(PUBLISHED_ARCHIVES).toEqual({
    "5.0.0-next.17":
      "6f63804f5f81935ba9cfa05ab085e1ccbffc789e89633277547b0e85da1e1466",
    "5.0.0-next.18":
      "da7c3e74629c049a25c40fbe95c5aa35433f241499065df372a23b27ee95aaee",
  });
  expect(REVIEWED_PREDECESSORS).toContain(
    "90d1bc60bfd2b7eaad48dcf56ad45264f395c0ac1a8c4530e986be7fa194d4d9"
  );
});
