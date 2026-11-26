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
  PUBLISHED_RELEASES,
  previousPrerelease,
} from "../scripts/check-prerelease-upgrade.ts";
import { selectionTarget } from "../scripts/install-prerelease.ts";
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
    "ba47091559a80b2abbb246b8e86c5530b8ddb068973f5136e120d36e2003fae6", // next.19
    "2e9183b4ce7b4c4c5659f9ae33677699e1cdc9f5553e1b668bbbe6ea6846ac7b", // next.20
    "af7d25e2db3e5d0edf8d0e308a49db928f1bc7f138beb54b9d3b0ccae83ee423", // next.21
    "df75f28ef2fdd892e9d17f5528171117488b426a2fe9140ac3dd9add924ae45a", // next.22
    "c9cc02744bf801986f8962699fe633566790cb3a6e7bfff2beb0536107a56b66", // next.23
    // From next.23 on, the Linux managers in that release's SHA256SUMS-linux.
    "e946ba95a49018b0eff8ff81161d1ccf1a086627773e62a30db53e4e94c9195b", // next.23 linux-x86_64
    "be1599a85cd4251df4a9779f2e7fa16480094ebb48ec97ca4e9dad6dd73d0094", // next.23 linux-arm64
    "892c4cdf3a99e309df4b4d406f7e76e2b422b72f4dd2a47bef1f0b36dd29ee27", // next.24
    "00e6e01b05bd6f05ac32a41ab06b7309767d701653b220ede5148c2ffb66388c", // next.24 linux-x86_64
    "f52beab69e5ec62e237da74ae64a0cdef7887bcae51380ca6a0270e4b45e4d27", // next.24 linux-arm64
    "dfba3ea7bfcfbeffd5de38e0d3b0818657912764cd184d949e04deec00edb153", // next.25
    "6219e16a7b2d3eb83eaa440315829c4d77fb20af0f74664d04d8491899ea6404", // next.25 linux-x86_64
    "a07bd7d5cd8cf6c0788c1ab2d9cd29d481850e73065709683d3c2c372182fbc4", // next.25 linux-arm64
    "8467fe1b4ff48074ab1fd8d1ad96dcbc9f72639de9432dae59b1817fa9f97748", // next.26
    "03a03c78db05cfe0e60504e6cdbc27816398fdd310a984fa09058f037c966179", // next.26 linux-x86_64
    "3a4c3eca6e3c6df615342a3e4b39ac2dae2dd74d6b74e001595d87f7d244e4d9", // next.26 linux-arm64
    "a6d93f87e701383de9341fa08aa9df1cce029f8dd44d03cac0e5b68ee6d93152", // next.27
    "22d201e99bb4d31aead14b0685c8853f38fce6167a2f5ea8940da5d44fbbe946", // next.27 linux-x86_64
    "61ec352c6dd8c09830f29bbf53e8acec262e0e0d001d2664fa64ca14cfdcc849", // next.27 linux-arm64
    "90bf732b23d413df314352632b8808cc191e3681543746ce2e81ccbf0ad4d894", // next.28
    "44769f55357ca18dad0374a83fc506f9f72723c42ce5424d2fe30d39ba766901", // next.28 linux-x86_64
    "6f9c44bd3fb8c251aa8dad45105ac97609c37a6ac8ad9e1dadea58713c42c8bc", // next.28 linux-arm64
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

test("the gate runs a previous release only from its own reviewed pins", () => {
  // Release assets are mutable: each release's manager and archive are pinned
  // together, so a later reviewed manager cannot stand in for an older one.
  expect(PUBLISHED_RELEASES).toEqual({
    "5.0.0-next.17": {
      manager:
        "85bbe4f064b3277efc88a9f79c197e81950ab8881320aef1b3443b70d95b530f",
      archive:
        "6f63804f5f81935ba9cfa05ab085e1ccbffc789e89633277547b0e85da1e1466",
    },
    "5.0.0-next.18": {
      manager:
        "90d1bc60bfd2b7eaad48dcf56ad45264f395c0ac1a8c4530e986be7fa194d4d9",
      archive:
        "da7c3e74629c049a25c40fbe95c5aa35433f241499065df372a23b27ee95aaee",
    },
    "5.0.0-next.19": {
      manager:
        "ba47091559a80b2abbb246b8e86c5530b8ddb068973f5136e120d36e2003fae6",
      archive:
        "57efde68a6424fc7cf0c710d058735b1e3a50cbac8e2f211b0208572aed33086",
    },
    "5.0.0-next.20": {
      manager:
        "2e9183b4ce7b4c4c5659f9ae33677699e1cdc9f5553e1b668bbbe6ea6846ac7b",
      archive:
        "a20c32bb090f7535e167702f37910812130b45d96d2d5eb930588328a1f31060",
    },
    "5.0.0-next.21": {
      manager:
        "af7d25e2db3e5d0edf8d0e308a49db928f1bc7f138beb54b9d3b0ccae83ee423",
      archive:
        "7e7f887a09d435ee20a4dfd0afe7b33eb5a171660937efd443fac73ecc09ff0e",
    },
    "5.0.0-next.22": {
      manager:
        "df75f28ef2fdd892e9d17f5528171117488b426a2fe9140ac3dd9add924ae45a",
      archive:
        "a0d36c68d0e670a2d9b8dfad895136a17fa6706fc7b84072a962afa6d1994f51",
    },
    "5.0.0-next.23": {
      manager:
        "c9cc02744bf801986f8962699fe633566790cb3a6e7bfff2beb0536107a56b66",
      archive:
        "c17cb20bfe955fb188273701f8e39016cd7e4394ebc6cb7a1714959ff2a842a4",
    },
    "5.0.0-next.24": {
      manager:
        "892c4cdf3a99e309df4b4d406f7e76e2b422b72f4dd2a47bef1f0b36dd29ee27",
      archive:
        "b77eb0908d62db66fda707ec66e2c237ae217ea340b128ebafcb57d0ee60e59d",
    },
    "5.0.0-next.25": {
      manager:
        "dfba3ea7bfcfbeffd5de38e0d3b0818657912764cd184d949e04deec00edb153",
      archive:
        "01f5a7a469a6087c78a1491a9ac82feffb48018a534fa227a8a636e1b8c3aed1",
    },
    "5.0.0-next.26": {
      manager:
        "8467fe1b4ff48074ab1fd8d1ad96dcbc9f72639de9432dae59b1817fa9f97748",
      archive:
        "3146de32ea692882f9be489ce4f6fc2bc264ea7cdc9905ad1388305281e84718",
    },
    "5.0.0-next.27": {
      manager:
        "a6d93f87e701383de9341fa08aa9df1cce029f8dd44d03cac0e5b68ee6d93152",
      archive:
        "2f1ddbbc85b9e356568709fd95de968f3d909254055eb1897cfc40187ba793aa",
    },
    "5.0.0-next.28": {
      manager:
        "90bf732b23d413df314352632b8808cc191e3681543746ce2e81ccbf0ad4d894",
      archive:
        "d85593a034f19043fd3c91894f7b28a91a9116fe2e63c0d3968aa359fc173af9",
    },
  });
  for (const { manager } of Object.values(PUBLISHED_RELEASES)) {
    expect(REVIEWED_PREDECESSORS).toContain(manager);
  }
});

fixtureTest(
  "after a rollback, select moves forward to an installed newer version; upgrade names it",
  async () => {
    const root = scratch();
    const source = join(root, "manager");
    writeFileSync(source, "manager bytes", { mode: 0o700 });
    const channel = new Channel(join(root, "channel"), source, hooks);
    channel.initialize();
    const a17 = archive(root, "5.0.0-next.17");
    const a18 = archive(root, "5.0.0-next.18");
    await channel.install("5.0.0-next.17", a17.archive, a17.checksum);
    await channel.install("5.0.0-next.18", a18.archive, a18.checksum, true);
    channel.select(
      selectionTarget({
        command: "rollback",
        version: undefined,
        state: channel.state,
      })
    );
    expect(channel.state.selected).toBe("5.0.0-next.17");
    // Moving forward again is not an upgrade: the refusal names the command.
    await expect(
      channel.install("5.0.0-next.18", a18.archive, a18.checksum, true)
    ).rejects.toThrow(
      "5.0.0-next.18 is already installed; select it with: hack-next --manager select --version 5.0.0-next.18"
    );
    channel.select(
      selectionTarget({
        command: "select",
        version: "5.0.0-next.18",
        state: channel.state,
      })
    );
    expect(channel.state.selected).toBe("5.0.0-next.18");
    expect(channel.state.previous).toBe("5.0.0-next.17");
    // An older version that is not installed is still no upgrade.
    const a16 = archive(root, "5.0.0-next.16");
    await expect(
      channel.install("5.0.0-next.16", a16.archive, a16.checksum, true)
    ).rejects.toThrow(
      "Upgrade must increase the prerelease version. To use an installed older version, run: hack-next --manager select --version VERSION"
    );
    expect(channel.state.selected).toBe("5.0.0-next.18");
  }
);

test("select needs an installed --version; rollback without one returns to the previous", () => {
  const state = {
    installed: { "5.0.0-next.17": {}, "5.0.0-next.18": {} },
    previous: "5.0.0-next.17",
  };
  expect(
    selectionTarget({ command: "select", version: "5.0.0-next.18", state })
  ).toBe("5.0.0-next.18");
  expect(() =>
    selectionTarget({ command: "select", version: undefined, state })
  ).toThrow("select requires --version");
  expect(() =>
    selectionTarget({ command: "select", version: "5.0.0-next.19", state })
  ).toThrow("not installed");
  expect(
    selectionTarget({ command: "rollback", version: undefined, state })
  ).toBe("5.0.0-next.17");
  expect(() =>
    selectionTarget({
      command: "rollback",
      version: undefined,
      state: { ...state, previous: null },
    })
  ).toThrow("No retained rollback version.");
});
