import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractArchive } from "../scripts/installer/bundle.ts";
import { officialArchive } from "../scripts/installer/download.ts";
import {
  BUNDLE_PLATFORMS,
  type BundlePlatform,
  bundleArchiveName,
  COMPOSE_PAYLOAD,
  digest,
  jsonBytes,
  managerAssetName,
  metadata,
} from "../scripts/installer/integrity.ts";
import {
  PLATFORMS_ASSET,
  platformsInAssetSet,
  releasePlatforms,
  renderReleasePlatforms,
  requireReleasePlatforms,
} from "../scripts/installer/release-platforms.ts";
import { packageNativeStorageTool } from "../scripts/package-native-storage-tool.ts";
import {
  createPrereleasePlan,
  PRERELEASE_LINUX_PLATFORMS,
  PRERELEASE_PAYLOAD,
  PRERELEASE_PLATFORM,
  packageLinuxPrerelease,
  packagePrerelease,
  prereleaseMetadata,
  releaseAssets,
  renderChecksums,
  verifyReleaseAssets as verifyReleaseAssetsActual,
} from "../scripts/prerelease-plan.ts";
import {
  NATIVE_STORAGE_TOOL_FILE,
  NATIVE_STORAGE_TOOL_MANIFEST,
} from "../src/backends/native-authored-storage-tool.ts";
import { officialArchive as next17OfficialArchive } from "./fixtures/prerelease-manager-next17/download.ts";
import { metadata as next17Metadata } from "./fixtures/prerelease-manager-next17/integrity.ts";

/*
 * HACK-2419: the release-level `prerelease.json` says `"platform":
 * "darwin-arm64"` although a release also holds two Linux archives and
 * managers. That file cannot change: every published manager requires its
 * exact five keys and that platform value. A release therefore carries a
 * second file, `prerelease-platforms.json`, that names every platform in the
 * set, and packaging and publication refuse a set it does not describe.
 */

function verifyReleaseAssets(
  options: Parameters<typeof verifyReleaseAssetsActual>[0]
) {
  return verifyReleaseAssetsActual({ ...options, nativeSignatures: () => {} });
}

const fixtureTest = (name: string, run: () => void | Promise<void>) =>
  test(name, run, 30_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hack-platforms-")));
  roots.push(root);
  return root;
}

const VERSION = "5.0.0-next.25";
const revision = "a".repeat(40);
const plan = createPrereleasePlan({
  version: VERSION,
  sourceRevision: revision,
  ref: "refs/heads/next",
  eventName: "workflow_dispatch",
  channel: "prerelease",
});

/** A minimal structurally valid ELF64 executable (62 x86-64, 183 AArch64). */
function elfExecutable(machine: number) {
  const body = Buffer.from("manager fixture\n");
  const bytes = Buffer.alloc(64 + 56 + body.length);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(1, 64);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 64 + 32);
  body.copy(bytes, 64 + 56);
  return bytes;
}
const fixtureManager = async (output: string) => {
  writeFileSync(
    output,
    elfExecutable(output.endsWith("linux-arm64") ? 183 : 62),
    {
      mode: 0o500,
    }
  );
  await Promise.resolve();
};

/** A Compose bundle directory whose metadata names `inner`. */
async function composeBundle(
  root: string,
  name: string,
  inner: BundlePlatform
) {
  const bundle = join(root, name);
  mkdirSync(bundle, { mode: 0o700 });
  for (const member of COMPOSE_PAYLOAD) {
    const executable = member.startsWith("hack-") && !member.includes(".");
    writeFileSync(
      join(bundle, member),
      member === "prerelease.json"
        ? `${JSON.stringify(prereleaseMetadata({ version: VERSION, sourceRevision: revision, platform: inner }), null, 2)}\n`
        : `fixture ${member}\n`
    );
    chmodSync(join(bundle, member), executable ? 0o755 : 0o600);
  }
  writeFileSync(
    join(bundle, "SHA256SUMS"),
    await renderChecksums({ root: bundle, names: COMPOSE_PAYLOAD })
  );
  return bundle;
}

async function nativeBundle(root: string, sourceRevision = revision) {
  const bundle = join(root, "native-bundle");
  mkdirSync(bundle, { mode: 0o700 });
  chmodSync(bundle, 0o700);
  for (const name of PRERELEASE_PAYLOAD) {
    if (
      name === NATIVE_STORAGE_TOOL_FILE ||
      name === NATIVE_STORAGE_TOOL_MANIFEST
    ) {
      continue;
    }
    writeFileSync(
      join(bundle, name),
      name === "prerelease.json"
        ? JSON.stringify(
            prereleaseMetadata({ version: VERSION, sourceRevision })
          )
        : `fixture ${name}\n`
    );
  }
  const witness = Buffer.alloc(64);
  witness.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  witness.writeUInt16LE(183, 18);
  writeFileSync(join(bundle, NATIVE_STORAGE_TOOL_FILE), witness, {
    mode: 0o500,
  });
  chmodSync(join(bundle, NATIVE_STORAGE_TOOL_FILE), 0o500);
  await packageNativeStorageTool({
    directory: bundle,
    sourceRevision,
  });
  writeFileSync(
    join(bundle, "SHA256SUMS"),
    await renderChecksums({ root: bundle, names: PRERELEASE_PAYLOAD })
  );
  return bundle;
}

/** A complete packaged release set: macOS, both Linux platforms, metadata. */
async function fullSet(root: string) {
  const linux = join(root, "linux-assets");
  mkdirSync(linux, { mode: 0o700 });
  for (const platform of PRERELEASE_LINUX_PLATFORMS) {
    const out = join(root, `out-${platform}`);
    await packageLinuxPrerelease({
      plan,
      bundle: await composeBundle(root, `bundle-${platform}`, platform),
      output: out,
      platform,
      buildManager: fixtureManager,
    });
    for (const name of readdirSync(out)) {
      copyFileSync(join(out, name), join(linux, name));
    }
  }
  const output = join(root, "assets");
  await packagePrerelease({
    plan,
    bundle: await nativeBundle(root),
    output,
    buildManager: fixtureManager,
    linux,
  });
  return output;
}

test("the platforms metadata names every bundle platform with its assets", () => {
  expect(PLATFORMS_ASSET).toBe("prerelease-platforms.json");
  expect(
    releasePlatforms({ version: VERSION, sourceRevision: revision })
  ).toEqual({
    schema: "hack.prerelease-platforms/v1",
    version: VERSION,
    tag: `v${VERSION}`,
    source_revision: revision,
    platforms: [
      {
        platform: "darwin-arm64",
        backends: ["native", "compose"],
        archive: `hack-${VERSION}-darwin-arm64-native.tar.gz`,
        manager: "hack-next-manager-darwin-arm64",
        checksums: "SHA256SUMS",
      },
      {
        platform: "linux-x86_64",
        backends: ["compose"],
        archive: `hack-${VERSION}-linux-x86_64-compose.tar.gz`,
        manager: "hack-next-manager-linux-x86_64",
        checksums: "SHA256SUMS-linux",
      },
      {
        platform: "linux-arm64",
        backends: ["compose"],
        archive: `hack-${VERSION}-linux-arm64-compose.tar.gz`,
        manager: "hack-next-manager-linux-arm64",
        checksums: "SHA256SUMS-linux",
      },
    ],
  });
  // One entry per platform a bundle is built for, nothing else.
  expect(
    releasePlatforms({
      version: VERSION,
      sourceRevision: revision,
    }).platforms.map((entry) => entry.platform)
  ).toEqual([...BUNDLE_PLATFORMS]);
  expect(releaseAssets(plan).at(-1)).toBe(PLATFORMS_ASSET);
  expect(releaseAssets(plan)).toHaveLength(12);
});

test("the platforms in a set are read from its archive and manager names", () => {
  expect(platformsInAssetSet(VERSION, releaseAssets(plan))).toEqual([
    "darwin-arm64",
    "linux-arm64",
    "linux-x86_64",
  ]);
  expect(platformsInAssetSet(VERSION, plan.assets)).toEqual(["darwin-arm64"]);
  // A manager alone, or an archive alone, still counts as a platform present.
  expect(
    platformsInAssetSet(VERSION, [
      "hack-next-manager-linux-riscv64",
      `hack-${VERSION}-freebsd-amd64-compose.tar.gz`,
      "hack-5.0.0-next.1-linux-arm64-compose.tar.gz",
      "SHA256SUMS",
    ])
  ).toEqual(["freebsd-amd64", "linux-riscv64"]);
});

fixtureTest(
  "a full release set carries the platforms metadata, and publication accepts it",
  async () => {
    const output = await fullSet(scratch());
    expect(readdirSync(output).sort()).toEqual([...releaseAssets(plan)].sort());
    expect(readFileSync(join(output, PLATFORMS_ASSET), "utf8")).toBe(
      renderReleasePlatforms({ version: VERSION, sourceRevision: revision })
    );
    await verifyReleaseAssets({ plan, output, linux: true });
    // Every listed archive and manager is a file in the set.
    const listed = JSON.parse(
      readFileSync(join(output, PLATFORMS_ASSET), "utf8")
    ) as {
      platforms: { archive: string; manager: string; checksums: string }[];
    };
    for (const entry of listed.platforms) {
      for (const name of [entry.archive, entry.manager, entry.checksums]) {
        expect(readdirSync(output)).toContain(name);
      }
    }
  }
);

fixtureTest(
  "the release-level prerelease.json is unchanged, and published managers still parse it and skip the new asset",
  async () => {
    const root = scratch();
    const output = await fullSet(root);
    const raw = readFileSync(join(output, "prerelease.json"));
    // Byte for byte the five keys every published manager requires.
    expect(raw.toString()).toBe(
      `${JSON.stringify(
        {
          schema: "hack.prerelease/v1",
          version: VERSION,
          tag: `v${VERSION}`,
          source_revision: revision,
          platform: "darwin-arm64",
        },
        null,
        2
      )}\n`
    );
    expect(PRERELEASE_PLATFORM).toBe("darwin-arm64");
    // The parse of the manager released as next.17, and today's.
    for (const parse of [next17Metadata, metadata]) {
      expect(parse(raw, VERSION).platform).toBe("darwin-arm64");
      // Control: this is why the platforms are not added to this file. An
      // extra key, another platform value or another schema is refused.
      for (const changed of [
        { platforms: ["darwin-arm64", "linux-x86_64"] },
        { platform: "all" },
        { schema: "hack.prerelease/v2" },
      ]) {
        expect(() =>
          parse(
            jsonBytes({ ...JSON.parse(raw.toString()), ...changed }),
            VERSION
          )
        ).toThrow();
      }
    }

    // The whole download of the next.17 manager and of today's managers
    // against a release that lists all twelve assets: none asks for the new
    // file.
    const base = `https://github.com/hack-dance/hack/releases/download/v${VERSION}/`;
    const api = "https://api.github.com/repos/hack-dance/hack/";
    const responses: Record<string, Uint8Array> = {
      [`${api}releases/tags/v${VERSION}`]: jsonBytes({
        tag_name: `v${VERSION}`,
        prerelease: true,
        draft: false,
        assets: releaseAssets(plan).map((name) => ({
          name,
          browser_download_url: base + name,
        })),
      }),
      [`${api}git/ref/tags/v${VERSION}`]: jsonBytes({
        ref: `refs/tags/v${VERSION}`,
        object: { type: "commit", sha: revision },
      }),
      ...Object.fromEntries(
        releaseAssets(plan).map((name) => [
          base + name,
          readFileSync(join(output, name)),
        ])
      ),
    };
    const requested: string[] = [];
    const mock = spyOn(globalThis, "fetch");
    try {
      mock.mockImplementation(
        Object.assign(
          (url: Parameters<typeof fetch>[0]) => {
            const bytes = responses[String(url)];
            if (!bytes) {
              throw new Error(`Unexpected fixture request ${String(url)}`);
            }
            requested.push(String(url));
            return Promise.resolve(new Response(Buffer.from(bytes)));
          },
          { preconnect: fetch.preconnect }
        )
      );
      const runs: [string, () => Promise<{ releaseMetadata: unknown }>][] = [
        ["next17", () => next17OfficialArchive(stage(root, "n17"), VERSION)],
        ["darwin", () => officialArchive(stage(root, "mac"), VERSION)],
        ...PRERELEASE_LINUX_PLATFORMS.map(
          (platform): [string, () => Promise<{ releaseMetadata: unknown }>] => [
            platform,
            () =>
              officialArchive(
                stage(root, platform),
                VERSION,
                undefined,
                platform
              ),
          ]
        ),
      ];
      for (const [name, run] of runs) {
        requested.length = 0;
        const result = await run();
        expect([name, typeof result.releaseMetadata]).toEqual([name, "object"]);
        expect(requested.some((url) => url.endsWith("/prerelease.json"))).toBe(
          true
        );
        expect(
          requested.filter((url) => url.endsWith(PLATFORMS_ASSET))
        ).toEqual([]);
      }
    } finally {
      mock.mockRestore();
    }
  }
);

function stage(root: string, name: string) {
  const directory = join(root, `stage-${name}`);
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

fixtureTest(
  "publication refuses a set whose platforms metadata does not describe it",
  async () => {
    const output = await fullSet(scratch());
    const path = join(output, PLATFORMS_ASSET);
    const good = JSON.parse(readFileSync(path, "utf8")) as ReturnType<
      typeof releasePlatforms
    >;
    const write = (value: unknown) =>
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    const refuses = (message: string) =>
      expect(
        verifyReleaseAssets({ plan, output, linux: true })
      ).rejects.toThrow(message);

    // A platform that is in the set is not listed.
    write({ ...good, platforms: good.platforms.slice(0, 2) });
    await refuses(
      "Release platform metadata does not list linux-arm64, which has assets in the release set."
    );
    // A platform is listed that the set does not hold.
    write({
      ...good,
      platforms: [
        ...good.platforms,
        {
          platform: "linux-riscv64",
          backends: ["compose"],
          archive: `hack-${VERSION}-linux-riscv64-compose.tar.gz`,
          manager: "hack-next-manager-linux-riscv64",
          checksums: "SHA256SUMS-linux",
        },
      ],
    });
    await refuses(
      "Release platform metadata lists linux-riscv64, which has no archive or manager in the release set."
    );
    // Wrong asset names for a platform that is there.
    write({
      ...good,
      platforms: good.platforms.map((entry) =>
        entry.platform === "linux-x86_64"
          ? { ...entry, archive: `hack-${VERSION}-linux-x86_64.tar.gz` }
          : entry
      ),
    });
    await refuses(
      "Release platform metadata for linux-x86_64 does not name its archive, manager, checksum file and backends (wrong: archive)."
    );
    // Right values with the keys in another order are not called wrong
    // names; only the final exact-rendering check objects.
    write({
      ...good,
      platforms: good.platforms.map((entry) => ({
        checksums: entry.checksums,
        manager: entry.manager,
        archive: entry.archive,
        backends: entry.backends,
        platform: entry.platform,
      })),
    });
    await refuses("is not the exact rendering for this release");
    // The wrong release.
    for (const changed of [
      { version: "5.0.0-next.24" },
      { tag: "v5.0.0-next.24" },
      { source_revision: "b".repeat(40) },
      { schema: "hack.prerelease-platforms/v2" },
    ]) {
      write({ ...good, ...changed });
      await refuses(
        "Release platform metadata does not match the planned version, tag and source revision."
      );
    }
    // A duplicate, an unknown key, another order, another formatting.
    write({ ...good, platforms: [...good.platforms, good.platforms[0]] });
    await refuses("Release platform metadata lists a platform twice.");
    write({ ...good, note: "extra" });
    await refuses("Unexpected JSON fields.");
    write({ ...good, platforms: [...good.platforms].reverse() });
    await refuses("is not the exact rendering for this release");
    writeFileSync(path, JSON.stringify(good));
    await refuses("is not the exact rendering for this release");
    // The native archive of another commit under this release's name, with
    // its outer checksum regenerated: its own metadata gives it away.
    write(good);
    const otherRoot = scratch();
    const otherPlan = { ...plan, source_revision: "b".repeat(40) };
    const otherBundle = await nativeBundle(otherRoot, "b".repeat(40));
    await packagePrerelease({
      plan: otherPlan,
      bundle: otherBundle,
      output: join(otherRoot, "assets"),
      buildManager: fixtureManager,
    });
    const savedArchive = readFileSync(join(output, plan.archive));
    const savedSums = readFileSync(join(output, "SHA256SUMS"));
    copyFileSync(
      join(otherRoot, "assets", plan.archive),
      join(output, plan.archive)
    );
    writeFileSync(
      join(output, "SHA256SUMS"),
      await renderChecksums({ root: output, names: [plan.archive] })
    );
    await refuses(
      "Native archive for darwin-arm64 was built from another source revision"
    );
    writeFileSync(join(output, plan.archive), savedArchive);
    writeFileSync(join(output, "SHA256SUMS"), savedSums);
    // Missing altogether: the set is not the planned twelve assets.
    rmSync(path);
    await refuses(
      "Expected exactly the candidate and standalone installer release assets"
    );
    write(good);
    await verifyReleaseAssets({ plan, output, linux: true });
  }
);

fixtureTest(
  "publication and the installer reject the same native archive corruption",
  async () => {
    const root = scratch();
    const output = await fullSet(root);
    const bundle = join(root, "native-bundle");
    const archive = join(output, plan.archive);
    const executable = join(bundle, "hack-native");
    const original = readFileSync(executable);
    const storageManifest = join(bundle, NATIVE_STORAGE_TOOL_MANIFEST);
    const refusals = [
      "Candidate checksum mismatch: hack-native",
      "Storage tool fingerprint or identity mismatch",
    ];
    for (const [index, error] of refusals.entries()) {
      if (index === 0) {
        writeFileSync(executable, "changed payload\n");
      } else {
        writeFileSync(executable, original);
        const tool = JSON.parse(readFileSync(storageManifest, "utf8"));
        writeFileSync(
          storageManifest,
          JSON.stringify({ ...tool, sourceRevision: "b".repeat(40) })
        );
        writeFileSync(
          join(bundle, "SHA256SUMS"),
          await renderChecksums({ root: bundle, names: PRERELEASE_PAYLOAD })
        );
      }
      const child = Bun.spawn(
        [
          "tar",
          "--format=ustar",
          "-czf",
          archive,
          "-C",
          bundle,
          ...PRERELEASE_PAYLOAD,
          "SHA256SUMS",
        ],
        {
          env: { ...process.env, COPYFILE_DISABLE: "1" },
          timeout: 10_000,
        }
      );
      expect(await child.exited).toBe(0);
      writeFileSync(
        join(output, "SHA256SUMS"),
        await renderChecksums({ root: output, names: [plan.archive] })
      );
      expect(() =>
        extractArchive({
          archive,
          checksum: digest(archive),
          destination: join(root, `probe-${index}`),
          version: plan.version,
          signatures: () => {},
        })
      ).toThrow(error);
      await expect(
        verifyReleaseAssets({ plan, output, linux: true })
      ).rejects.toThrow(error);
    }
  }
);

fixtureTest(
  "packaging refuses a Linux archive whose own metadata names another platform",
  async () => {
    const root = scratch();
    const linux = join(root, "linux-assets");
    mkdirSync(linux, { mode: 0o700 });
    for (const platform of PRERELEASE_LINUX_PLATFORMS) {
      const out = join(root, `out-${platform}`);
      await packageLinuxPrerelease({
        plan,
        bundle: await composeBundle(root, `bundle-${platform}`, platform),
        output: out,
        platform,
        buildManager: fixtureManager,
      });
      for (const name of readdirSync(out)) {
        copyFileSync(join(out, name), join(linux, name));
      }
    }
    // The arm64 name on an archive that says linux-x86_64 inside.
    copyFileSync(
      join(linux, bundleArchiveName(VERSION, "linux-x86_64")),
      join(linux, bundleArchiveName(VERSION, "linux-arm64"))
    );
    await expect(
      packagePrerelease({
        plan,
        bundle: await nativeBundle(root),
        output: join(root, "assets"),
        buildManager: fixtureManager,
        linux,
      })
    ).rejects.toThrow("Prerelease identity mismatch.");
  }
);

fixtureTest(
  "a set without a platform's files is refused before the metadata is trusted",
  async () => {
    const output = await fullSet(scratch());
    // The arm64 manager is gone but the metadata still lists the platform.
    rmSync(join(output, managerAssetName("linux-arm64")));
    await expect(
      verifyReleaseAssets({ plan, output, linux: true })
    ).rejects.toThrow(
      "Expected exactly the candidate and standalone installer release assets"
    );
    // The validator itself, given such a set: the listed manager is missing.
    expect(() =>
      requireReleasePlatforms({
        raw: readFileSync(join(output, PLATFORMS_ASSET)),
        version: VERSION,
        sourceRevision: revision,
        assetNames: readdirSync(output),
      })
    ).toThrow(
      "Release platform metadata lists hack-next-manager-linux-arm64 for linux-arm64, which is not in the release set."
    );
  }
);

fixtureTest(
  "the macOS-only shape (tests only) has no platforms metadata and is still exact",
  async () => {
    const root = scratch();
    const output = join(root, "assets");
    await packagePrerelease({
      plan,
      bundle: await nativeBundle(root),
      output,
      buildManager: fixtureManager,
    });
    expect(readdirSync(output).sort()).toEqual([...plan.assets].sort());
    await verifyReleaseAssets({ plan, output });
    // Publication requires the full set, metadata included.
    await expect(
      verifyReleaseAssets({ plan, output, linux: true })
    ).rejects.toThrow(
      "Expected exactly the candidate and standalone installer release assets"
    );
  }
);
