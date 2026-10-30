import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { extractArchive } from "../scripts/installer/bundle.ts";
import { Channel, launcherBytes } from "../scripts/installer/channel.ts";
import { download, secureUrl } from "../scripts/installer/download.ts";
import {
  archiveEntries,
  digest,
  hash,
  jsonBytes,
  metadata,
  parseJson,
  SHA256,
  versionNumber,
} from "../scripts/installer/integrity.ts";

// Filesystem fixtures may span several bounded subprocesses; the suite default is only 5 s.
const fixtureTest = (name: string, run: () => void | Promise<void>) =>
  test(name, run, 30_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hack-python-free-")));
  roots.push(root);
  return root;
}
const revision = "a".repeat(40);
function fixtureArchive(root: string, version = "5.0.0-next.1") {
  const bundle = join(root, `bundle-${version}`);
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
  };
  const checksums = Object.entries(files)
    .map(([name, bytes]) => `${hash(bytes)}  ${name}\n`)
    .join("");
  files.SHA256SUMS = Buffer.from(checksums);
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(bundle, name), bytes, {
      mode: name.startsWith("hack-") ? 0o755 : 0o600,
    });
  }
  const archive = join(root, `${version}.tar.gz`);
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
  return { archive, checksum: digest(archive) };
}
function fixture(hooks: ConstructorParameters<typeof Channel>[2] = {}) {
  const root = scratch();
  const source = join(root, "source-manager");
  writeFileSync(source, "manager-one");
  const channel = new Channel(join(root, "channel"), source, {
    signatures: () => {},
    quiescence: () => {},
    ...hooks,
  });
  channel.initialize();
  channel.validate();
  return { root, source, channel };
}
async function installed() {
  const f = fixture();
  const input = fixtureArchive(f.root);
  await f.channel.install("5.0.0-next.1", input.archive, input.checksum);
  return f;
}

describe("standalone manager ownership and atomic state", () => {
  fixtureTest(
    "installs, upgrades, rolls back and deselects without touching stable bytes",
    async () => {
      const { root, channel } = fixture();
      const stable = join(root, "hack");
      writeFileSync(stable, "custom stable command");
      const a = fixtureArchive(root);
      const b = fixtureArchive(root, "5.0.0-next.2");
      await channel.install("5.0.0-next.1", a.archive, a.checksum);
      const originalHome = join(
        channel.root,
        "versions/5.0.0-next.1/native-home"
      );
      writeFileSync(join(originalHome, "retained-user-state"), "keep");
      await expect(
        channel.install("5.0.0-next.2", b.archive, b.checksum)
      ).rejects.toThrow("use upgrade");
      await channel.install("5.0.0-next.2", b.archive, b.checksum, true);
      expect(channel.state.previous).toBe("5.0.0-next.1");
      channel.select("5.0.0-next.1");
      expect(channel.state.previous).toBe("5.0.0-next.2");
      channel.select(null);
      expect(channel.state.selected).toBeNull();
      expect(
        readFileSync(join(originalHome, "retained-user-state"), "utf8")
      ).toBe("keep");
      expect(readFileSync(stable, "utf8")).toBe("custom stable command");
      expect(readFileSync(join(channel.root, "bin/hack-next"))).toEqual(
        launcherBytes()
      );
      expect(readdirSync(join(channel.root, "versions"))).toHaveLength(2);
    }
  );
  fixtureTest(
    "bad hashes, failed executor checks and changed bytes preserve selection",
    async () => {
      const { root, source, channel } = await installed();
      const before = readFileSync(join(channel.root, ".selection.json"));
      const b = fixtureArchive(root, "5.0.0-next.2");
      await expect(
        channel.install("5.0.0-next.2", b.archive, "0".repeat(64), true)
      ).rejects.toThrow("checksum");
      const fail = new Channel(channel.root, source, {
        signatures: () => {},
        quiescence: () => {
          throw new Error("executor unavailable");
        },
      });
      fail.validate();
      expect(() => fail.select(null)).toThrow("executor unavailable");
      expect(readFileSync(join(channel.root, ".selection.json"))).toEqual(
        before
      );
      writeFileSync(
        join(channel.root, "versions/5.0.0-next.1/bundle/hack-cli"),
        "changed"
      );
      expect(() => channel.validate()).toThrow("checksum mismatch");
      expect(readFileSync(join(channel.root, ".selection.json"))).toEqual(
        before
      );
    }
  );
  fixtureTest(
    "kernel shared launch locks exclude selection and exclusive locks exclude launch",
    () => {
      const { source, channel } = fixture();
      const second = new Channel(channel.root, source);
      const release = channel.lock(true);
      const releaseSecond = second.lock(true);
      expect(() => second.lock()).toThrow("active");
      releaseSecond();
      release();
      const exclusive = channel.lock();
      expect(() => second.lock(true)).toThrow("active");
      exclusive();
      second.lock()();
    }
  );
  fixtureTest(
    "refuses Python layouts, nonempty roots, symlink roots and hardlinked managers intact",
    () => {
      const root = scratch();
      const source = join(root, "manager");
      writeFileSync(source, "new");
      const legacy = join(root, "legacy");
      mkdirSync(legacy, { mode: 0o700 });
      writeFileSync(join(legacy, "manager.py"), "original python manager", {
        mode: 0o600,
      });
      const before = readFileSync(join(legacy, "manager.py"));
      const legacyChannel = new Channel(legacy, source);
      expect(() => legacyChannel.initialize()).toThrow("nonempty");
      writeFileSync(
        join(legacy, ".channel.json"),
        jsonBytes({ schema: "hack.prerelease-install/v1" }),
        { mode: 0o600 }
      );
      expect(() => legacyChannel.validate()).toThrow();
      expect(readFileSync(join(legacy, "manager.py"))).toEqual(before);
      symlinkSync(legacy, join(root, "alias"));
      expect(() => new Channel(join(root, "alias"), source)).toThrow(
        "symlinks"
      );
      const f = fixture();
      linkSync(join(f.channel.root, "manager"), join(f.root, "hardlink"));
      expect(() => f.channel.validate()).toThrow("Hard-linked");
    }
  );
  fixtureTest(
    "renamed but uncommitted version stays retained and unselected after interruption",
    async () => {
      const { root, channel, source } = fixture({
        checkpoint: (point) => {
          if (point === "version-published") {
            throw new Error("fixture interruption");
          }
        },
      });
      const input = fixtureArchive(root);
      await expect(
        channel.install("5.0.0-next.1", input.archive, input.checksum)
      ).rejects.toThrow("interruption");
      const recovered = new Channel(channel.root, source, {
        signatures: () => {},
        quiescence: () => {},
      });
      recovered.validate();
      expect(recovered.state.selected).toBeNull();
      expect(
        existsSync(join(channel.root, "versions/5.0.0-next.1/.receipt.json"))
      ).toBe(true);
      await expect(
        recovered.install("5.0.0-next.1", input.archive, input.checksum)
      ).rejects.toThrow("overwrite");
      expect(recovered.state.selected).toBeNull();
    }
  );
  for (const point of [
    "upgrade-journal",
    "upgrade-manager",
    "upgrade-receipt",
  ]) {
    fixtureTest(
      `manager upgrade resumes ${point} with originals and selection intact`,
      () => {
        const { root, channel } = fixture();
        const original = readFileSync(join(channel.root, "manager"));
        const selection = readFileSync(join(channel.root, ".selection.json"));
        const target = join(root, "new-manager");
        writeFileSync(target, "manager-two");
        const hooks = {
          predecessors: [hash(original)],
          checkpoint: (at: string) => {
            if (at === point) {
              throw new Error("fixture interruption");
            }
          },
        };
        const upgrade = new Channel(channel.root, target, hooks);
        expect(() => upgrade.upgradeManager()).toThrow("interruption");
        expect(() => channel.validate()).toThrow("pending");
        const recover = new Channel(channel.root, target, {
          predecessors: [hash(original)],
        });
        const release = recover.lock(false, true);
        try {
          recover.upgradeManager();
        } finally {
          release();
        }
        recover.validate();
        expect(readFileSync(join(channel.root, "manager"), "utf8")).toBe(
          "manager-two"
        );
        expect(readFileSync(join(channel.root, ".selection.json"))).toEqual(
          selection
        );
        const stage = readdirSync(channel.root).find((name) =>
          name.startsWith(".stage-")
        ) as string;
        expect(
          readFileSync(join(channel.root, stage, "manager-before"))
        ).toEqual(original);
      }
    );
  }
  fixtureTest(
    "unknown manager and changed recovery selection refuse without overwriting originals",
    () => {
      const { root, channel } = fixture();
      const target = join(root, "new");
      writeFileSync(target, "new manager");
      const original = readFileSync(join(channel.root, "manager"));
      expect(() => new Channel(channel.root, target).upgradeManager()).toThrow(
        "reviewed predecessors"
      );
      const upgrade = new Channel(channel.root, target, {
        predecessors: [hash(original)],
        checkpoint: () => {
          throw new Error("interrupted");
        },
      });
      expect(() => upgrade.upgradeManager()).toThrow("interrupted");
      writeFileSync(join(channel.root, ".selection.json"), "{}\n", {
        mode: 0o600,
      });
      expect(() =>
        new Channel(channel.root, target, {
          predecessors: [hash(original)],
        }).upgradeManager()
      ).toThrow("Selection changed");
      expect(readFileSync(join(channel.root, "manager"))).toEqual(original);
    }
  );
});

function changedHeader(archive: string, change: (header: Buffer) => void) {
  const tar = gunzipSync(readFileSync(archive));
  const header = tar.subarray(0, 512);
  change(header);
  header.fill(32, 148, 156);
  const sum = header
    .reduce((a, b) => a + b, 0)
    .toString(8)
    .padStart(6, "0");
  header.write(`${sum}\0 `, 148, "ascii");
  return gzipSync(tar);
}
describe("bounded input boundaries", () => {
  fixtureTest(
    "independent system ustar fixture accepted; links, traversal, extensions, size and corruption rejected before extraction",
    () => {
      const root = scratch();
      const { archive, checksum } = fixtureArchive(root);
      expect(archiveEntries(readFileSync(archive)).size).toBe(8);
      const tar = gunzipSync(readFileSync(archive));
      const corruptPayload = Buffer.from(tar);
      corruptPayload[512] = (corruptPayload[512] ?? 0) ^ 1;
      const variants = [
        gzipSync(Buffer.concat([tar.subarray(0, 1024), tar])),
        gzipSync(corruptPayload),
        changedHeader(archive, (h) => {
          h.fill(0, 0, 100);
          h.write("../escape", 0);
        }),
        ...["1", "2", "5", "x", "g", "S"].map((type) =>
          changedHeader(archive, (h) => {
            h.write(type, 156);
          })
        ),
        changedHeader(archive, (h) => {
          h.write("77777777777\0", 124);
        }),
        gzipSync(gunzipSync(readFileSync(archive)).subarray(0, 700)),
        Buffer.from("not gzip"),
      ];
      for (const [index, bytes] of variants.entries()) {
        const path = join(root, `bad-${index}`);
        writeFileSync(path, bytes);
        const destination = join(root, `out-${index}`);
        expect(() =>
          extractArchive({
            archive: path,
            checksum: hash(bytes),
            destination,
            version: "5.0.0-next.1",
            signatures: () => {},
          })
        ).toThrow();
        expect(existsSync(destination)).toBe(false);
      }
      expect(() =>
        extractArchive({
          archive,
          checksum: "0".repeat(64),
          destination: join(root, "out"),
          version: "5.0.0-next.1",
        })
      ).toThrow("checksum");
      expect(digest(archive)).toBe(checksum);
    }
  );
  fixtureTest(
    "duplicate escaped JSON fields, malformed identity and foreign downloads refuse",
    async () => {
      expect(() => versionNumber("5.0.0-next.1\n")).toThrow();
      expect(SHA256.test(`${"a".repeat(64)}\n`)).toBe(false);
      expect(() => parseJson('{"a":1,"\\u0061":2}')).toThrow("Duplicate");
      expect(() => parseJson('{"x":{"a":1,"a":2}}')).toThrow("Duplicate");
      expect(() => metadata(jsonBytes({}), "5.0.0-next.1")).toThrow();
      for (const url of [
        "http://github.com/a",
        "https://github.com.evil.test/a",
        "https://user@github.com/a",
        "https://github.com:444/a",
        "https://github.com/a#x",
        "file:///tmp/a",
      ]) {
        expect(() => secureUrl(url)).toThrow();
      }
      expect(secureUrl("https://github.com/hack-dance/hack").hostname).toBe(
        "github.com"
      );
      const root = scratch();
      await expect(
        download("http://example.invalid", join(root, "never"), 10)
      ).rejects.toThrow("non-HTTPS");
      expect(existsSync(join(root, "never"))).toBe(false);
    }
  );
  fixtureTest(
    "foreign home identity and unsafe receipt modes are rejected",
    async () => {
      const { channel } = await installed();
      const receipt = join(channel.root, ".selection.json");
      chmodSync(receipt, 0o644);
      expect(() => channel.validate()).toThrow("Unsafe mode");
      chmodSync(receipt, 0o600);
      const home = join(channel.root, "versions/5.0.0-next.1/native-home");
      renameSync(home, join(channel.root, "../original-home"));
      mkdirSync(home, { mode: 0o700 });
      expect(() => channel.validate()).toThrow(
        "Candidate home identity changed"
      );
    }
  );
});
