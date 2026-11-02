import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
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
  MAX_ARCHIVE,
  metadata,
  parseJson,
  SHA256,
  versionNumber,
} from "../scripts/installer/integrity.ts";
import {
  isFreshInitializerStage,
  publishDirectoryExclusive,
} from "../scripts/installer/publication.ts";

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
      expect(() => legacyChannel.initialize()).toThrow("separate --root");
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
        checkpoint: (point) => {
          if (point === "upgrade-journal") {
            throw new Error("interrupted");
          }
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

describe("reviewed initialization and durability boundaries", () => {
  fixtureTest(
    "first initialization retries every publication boundary without adopting or removing interrupted stages",
    () => {
      for (const point of [
        "init-stage",
        "init-manager",
        "init-launcher",
        "init-channel",
        "init-selection",
        "init-lock",
        "init-ready",
        "init-published",
      ]) {
        const root = scratch();
        const source = join(root, "source");
        writeFileSync(source, "fixture-manager");
        const target = join(root, "channel");
        const interrupted = new Channel(target, source, {
          checkpoint: (at) => {
            if (at === point) {
              throw new Error("fixture first-init interruption");
            }
          },
        });
        expect(() => interrupted.initialize()).toThrow(
          point === "init-published"
            ? "durability is uncertain"
            : "first-init interruption"
        );
        expect(existsSync(target)).toBe(point === "init-published");
        const retained = readdirSync(root).filter((name) =>
          name.includes(".init-")
        );
        const retry = new Channel(target, source);
        retry.initialize();
        retry.validate();
        expect(retry.state.selected).toBeNull();
        expect(readdirSync(target).sort()).toEqual(
          [
            ".channel.json",
            ".selection.json",
            ".manager.lock",
            "manager",
            "bin",
            "versions",
          ].sort()
        );
        for (const stage of retained) {
          expect(existsSync(join(root, stage))).toBe(true);
        }
      }
    }
  );
  fixtureTest(
    "concurrent initializers publish exactly one complete root and remove only their fresh losing stage",
    async () => {
      const root = scratch();
      const source = join(root, "source");
      writeFileSync(source, "fixture-manager");
      const target = join(root, "channel");
      const module = new URL("../scripts/installer/channel.ts", import.meta.url)
        .pathname;
      const code = `import {Channel} from ${JSON.stringify(module)}; import {readSync} from "node:fs"; new Channel(${JSON.stringify(target)},${JSON.stringify(source)},{checkpoint(point){if(point==="init-ready"){process.stdout.write("ready\\n");readSync(0,Buffer.alloc(1),0,1,null);}}}).initialize();`;
      const children = [0, 1].map(() =>
        Bun.spawn([process.execPath, "-e", code], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        })
      );
      try {
        for (const child of children) {
          const reader = child.stdout.getReader();
          const ready = await reader.read();
          reader.releaseLock();
          expect(new TextDecoder().decode(ready.value)).toContain("ready");
        }
        for (const child of children) {
          child.stdin.write("x");
          child.stdin.end();
        }
        for (const child of children) {
          expect(await new Response(child.stderr).text()).toBe("");
          expect(await child.exited).toBe(0);
        }
        const result = new Channel(target, source);
        result.validate();
        expect(
          readdirSync(root).filter((name) => name.includes(".init-"))
        ).toHaveLength(0);
      } finally {
        for (const child of children) {
          if (child.exitCode === null) {
            child.kill();
            await child.exited;
          }
        }
      }
    }
  );
  fixtureTest(
    "no-replace publication refuses even an existing empty destination",
    () => {
      const root = scratch();
      const source = join(root, "source");
      writeFileSync(source, "fixture-manager");
      const target = join(root, "empty");
      mkdirSync(target, { mode: 0o700 });
      expect(() => new Channel(target, source).initialize()).toThrow(
        "existing installation root"
      );
      expect(readdirSync(target)).toEqual([]);
    }
  );
  fixtureTest(
    "selection sync failure reports uncertainty and on-disk readback is authoritative",
    async () => {
      const { channel, source } = await installed();
      const fail = new Channel(channel.root, source, {
        signatures: () => {},
        quiescence: () => {},
        checkpoint: (point) => {
          if (point === "sync:.selection.json") {
            throw new Error("fixture directory sync failure");
          }
        },
      });
      fail.validate();
      expect(() => fail.select(null)).toThrow("durability is uncertain");
      const readback = new Channel(channel.root, source);
      readback.validate();
      expect(readback.state.selected).toBeNull();
      expect(readback.state.previous).toBe("5.0.0-next.1");
      expect(
        existsSync(join(channel.root, "versions/5.0.0-next.1/native-home"))
      ).toBe(true);
    }
  );
  fixtureTest(
    "version rename sync failure retains published version without claiming its selection committed",
    async () => {
      const { root, channel, source } = await installed();
      const second = fixtureArchive(root, "5.0.0-next.2");
      const fail = new Channel(channel.root, source, {
        signatures: () => {},
        quiescence: () => {},
        checkpoint: (point) => {
          if (point === "sync:version") {
            throw new Error("fixture directory sync failure");
          }
        },
      });
      fail.validate();
      await expect(
        fail.install("5.0.0-next.2", second.archive, second.checksum, true)
      ).rejects.toThrow("durability is uncertain");
      const readback = new Channel(channel.root, source);
      readback.validate();
      expect(readback.state.selected).toBe("5.0.0-next.1");
      expect(readback.state.installed["5.0.0-next.2"]).toBeUndefined();
      expect(
        existsSync(join(channel.root, "versions/5.0.0-next.2/.receipt.json"))
      ).toBe(true);
    }
  );
  for (const point of [
    "sync:journal",
    "sync:manager",
    "sync:.channel.json",
    "sync:journal-removed",
  ]) {
    fixtureTest(
      `manager sync failure ${point} preserves recoverable authoritative state and originals`,
      () => {
        const { root, channel } = fixture();
        const original = readFileSync(join(channel.root, "manager"));
        const selection = readFileSync(join(channel.root, ".selection.json"));
        const source = join(root, "new-manager");
        writeFileSync(source, "fixture-new-manager");
        const fail = new Channel(channel.root, source, {
          predecessors: [hash(original)],
          checkpoint: (at) => {
            if (at === point) {
              throw new Error("fixture directory sync failure");
            }
          },
        });
        expect(() => fail.upgradeManager()).toThrow("durability is uncertain");
        const pending = existsSync(join(channel.root, ".manager-upgrade.json"));
        expect(pending).toBe(point !== "sync:journal-removed");
        const recover = new Channel(channel.root, source, {
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
          "fixture-new-manager"
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
    "digest binds its size and bytes to the opened descriptor when the pathname changes",
    () => {
      const root = scratch();
      const path = join(root, "data");
      writeFileSync(path, "opened bytes");
      const result = digest(path, () => {
        renameSync(path, join(root, "original"));
        writeFileSync(path, "replacement");
      });
      expect(result).toBe(hash(Buffer.from("opened bytes")));
      expect(readFileSync(path, "utf8")).toBe("replacement");
    }
  );
});
fixtureTest(
  "actual Python channel with an interrupted old manager journal refuses unchanged before recovery advice",
  () => {
    const root = scratch();
    const target = join(root, "python-channel");
    const code = `import importlib.util, pathlib, sys
def load(name, path):
 spec=importlib.util.spec_from_file_location(name,path)
 module=importlib.util.module_from_spec(spec)
 spec.loader.exec_module(module)
 return module
old=load('old_manager',sys.argv[2])
old.Channel(pathlib.Path(sys.argv[1])).initialize()
current=load('current_manager',sys.argv[3])
def interrupted(*args):
 raise RuntimeError('fixture interrupted old upgrade')
current.atomic_file=interrupted
channel=current.Channel(pathlib.Path(sys.argv[1]))
with channel.lock(manager_upgrade=True):
 try:
  channel.upgrade_manager()
 except RuntimeError as error:
  assert str(error)=='fixture interrupted old upgrade'
assert (pathlib.Path(sys.argv[1])/'.manager-upgrade.json').is_file()
`;
    const python = Bun.spawnSync(
      [
        "python3",
        "-I",
        "-B",
        "-c",
        code,
        target,
        new URL("./fixtures/prerelease-manager-storage-v5.py", import.meta.url)
          .pathname,
        new URL("../scripts/install-prerelease.py", import.meta.url).pathname,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 10_000 }
    );
    expect(python.stderr.toString()).toBe("");
    expect(python.exitCode).toBe(0);
    const inventory = (directory: string): Record<string, string> => {
      const result: Record<string, string> = {};
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const info = lstatSync(path);
        result[name] = info.isDirectory()
          ? JSON.stringify(inventory(path))
          : `${info.mode}:${digest(path)}`;
      }
      return result;
    };
    const before = inventory(target);
    const source = join(root, "new-compiled-fixture");
    writeFileSync(source, "fixture");
    const channel = new Channel(target, source);
    for (const operation of [
      () => channel.initialize(),
      () => channel.validate(),
      () => channel.lock(),
      () => channel.lock(false, true),
    ]) {
      expect(operation).toThrow(
        "cannot migrate or recover a Python manager journal"
      );
    }
    expect(inventory(target)).toEqual(before);
  }
);
fixtureTest(
  "a mismatched external manager refuses before fetching a complete archive",
  async () => {
    const { root, channel } = fixture();
    const source = join(root, "different-manager");
    writeFileSync(source, "unreviewed manager");
    const external = new Channel(channel.root, source);
    external.validate();
    const mock = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("unexpected download")
    );
    try {
      await expect(external.install("5.0.0-next.2")).rejects.toThrow(
        "none is currently approved"
      );
      expect(mock).not.toHaveBeenCalled();
    } finally {
      mock.mockRestore();
    }
  }
);
fixtureTest(
  "an oversized opened descriptor cannot evade the bound by swapping in a small pathname",
  () => {
    const root = scratch();
    const path = join(root, "oversized");
    writeFileSync(path, "");
    truncateSync(path, MAX_ARCHIVE + 1);
    expect(() =>
      digest(path, () => {
        renameSync(path, join(root, "retained-oversized"));
        writeFileSync(path, "small");
      })
    ).toThrow("Oversized");
    expect(readFileSync(path, "utf8")).toBe("small");
  }
);
fixtureTest(
  "OS no-replace rename preserves an existing empty target and the complete source",
  () => {
    const root = scratch();
    const source = join(root, "stage");
    const target = join(root, "existing");
    mkdirSync(source, { mode: 0o700 });
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(source, "keep"), "original");
    const before = lstatSync(target);
    expect(publishDirectoryExclusive(source, target)).toBe(false);
    expect(lstatSync(target).ino).toBe(before.ino);
    expect(readdirSync(target)).toEqual([]);
    expect(readFileSync(join(source, "keep"), "utf8")).toBe("original");
  }
);
fixtureTest(
  "outer archive checksum pins precisely the opened bytes parsed, even when the pathname is replaced",
  () => {
    const root = scratch();
    const first = fixtureArchive(root);
    const second = fixtureArchive(root, "5.0.0-next.2");
    const replacement = readFileSync(second.archive);
    const destination = join(root, "accepted");
    const result = extractArchive({
      archive: first.archive,
      checksum: first.checksum,
      destination,
      version: "5.0.0-next.1",
      signatures: () => {},
      afterArchiveOpen: () => {
        renameSync(first.archive, join(root, "retained-original.gz"));
        writeFileSync(first.archive, replacement);
      },
    });
    expect(result.identity.version).toBe("5.0.0-next.1");
    expect(digest(first.archive)).toBe(second.checksum);
    const source = join(root, "negative.gz");
    const original = readFileSync(join(root, "retained-original.gz"));
    writeFileSync(source, original);
    const corrupted = Buffer.from(original);
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    expect(() =>
      extractArchive({
        archive: source,
        checksum: first.checksum,
        destination: join(root, "never-written"),
        version: "5.0.0-next.1",
        signatures: () => {},
        afterArchiveOpen: () => {
          writeFileSync(source, corrupted);
          renameSync(source, join(root, "retained-corrupt.gz"));
          writeFileSync(source, original);
        },
      })
    ).toThrow("Archive checksum");
    expect(existsSync(join(root, "never-written"))).toBe(false);
    expect(digest(source)).toBe(first.checksum);
  }
);
fixtureTest(
  "existing-root preflight does not validate unlocked; kernel admission still refuses a changed manager",
  () => {
    const { channel, source } = fixture();
    const existing = new Channel(channel.root, source);
    const full = spyOn(existing, "validate");
    const release = channel.lock();
    try {
      chmodSync(join(channel.root, "manager"), 0o700);
      writeFileSync(
        join(channel.root, "manager"),
        "temporarily changed by the lock owner"
      );
      chmodSync(join(channel.root, "manager"), 0o500);
      existing.initialize();
      expect(full).not.toHaveBeenCalled();
      expect(() => existing.lock()).toThrow("active");
      expect(full).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect(() => existing.lock()).toThrow("manager or launcher changed");
    expect(full).toHaveBeenCalledTimes(1);
    full.mockRestore();
  }
);
fixtureTest(
  "confirmed loser removes only its recorded fresh stage and validates the winner only under lock",
  () => {
    const root = scratch();
    const source = join(root, "source");
    writeFileSync(source, "fixture-manager");
    const target = join(root, "channel");
    const historical = join(root, `.channel.init-${"a".repeat(32)}`);
    mkdirSync(historical, { mode: 0o700 });
    writeFileSync(join(historical, "keep"), "historical original");
    let fresh = "";
    const first = new Channel(target, source, {
      checkpoint(point) {
        if (point === "init-ready") {
          fresh = join(
            root,
            readdirSync(root).find(
              (name) =>
                name.startsWith(".channel.init-") &&
                join(root, name) !== historical
            ) as string
          );
          new Channel(target, source).initialize();
        }
      },
    });
    const full = spyOn(first, "validate");
    first.initialize();
    expect(full).not.toHaveBeenCalled();
    expect(existsSync(fresh)).toBe(false);
    expect(readFileSync(join(historical, "keep"), "utf8")).toBe(
      "historical original"
    );
    const release = first.lock();
    release();
    expect(full).toHaveBeenCalledTimes(1);
    full.mockRestore();
  }
);
for (const replacement of ["directory", "file", "symlink"] as const) {
  fixtureTest(
    `loser cleanup preserves a ${replacement} replacement and the original staged bytes`,
    () => {
      const root = scratch();
      const source = join(root, "source");
      writeFileSync(source, "fixture-manager");
      const target = join(root, "channel");
      const external = join(root, "unowned-by-initializer");
      mkdirSync(external, { mode: 0o700 });
      writeFileSync(join(external, "keep"), "replacement original");
      let fresh = "";
      const saved = join(root, "original-stage-preserved");
      const first = new Channel(target, source, {
        checkpoint(point) {
          if (point === "init-ready") {
            fresh = join(
              root,
              readdirSync(root).find((name) =>
                name.startsWith(".channel.init-")
              ) as string
            );
            new Channel(target, source).initialize();
          }
          if (point === "init-loser") {
            renameSync(fresh, saved);
            if (replacement === "directory") {
              mkdirSync(fresh, { mode: 0o700 });
              writeFileSync(join(fresh, "keep"), "foreign replacement");
            } else if (replacement === "file") {
              writeFileSync(fresh, "foreign replacement");
            } else {
              symlinkSync(external, fresh);
            }
          }
        },
      });
      expect(() => first.initialize()).toThrow(
        "retained because its type, ownership, mode or identity changed"
      );
      expect(existsSync(fresh)).toBe(true);
      expect(readFileSync(join(saved, "manager"), "utf8")).toBe(
        "fixture-manager"
      );
      expect(readFileSync(join(external, "keep"), "utf8")).toBe(
        "replacement original"
      );
      if (replacement === "directory") {
        expect(readFileSync(join(fresh, "keep"), "utf8")).toBe(
          "foreign replacement"
        );
      }
      if (replacement === "file") {
        expect(readFileSync(fresh, "utf8")).toBe("foreign replacement");
      }
      const winner = new Channel(target, source);
      const release = winner.lock();
      release();
    }
  );
}
fixtureTest(
  "fresh-stage identity gate rejects a foreign UID without changing filesystem ownership",
  () => {
    const root = scratch();
    const observed = lstatSync(root);
    const uid = process.getuid?.();
    expect(isFreshInitializerStage(observed, observed, uid)).toBe(true);
    expect(
      isFreshInitializerStage(
        observed,
        { ...observed, isDirectory: () => true, uid: observed.uid + 1 },
        uid
      )
    ).toBe(false);
    expect(
      isFreshInitializerStage(
        { ...observed, isDirectory: () => true, uid: observed.uid + 1 },
        observed,
        uid
      )
    ).toBe(false);
  }
);
