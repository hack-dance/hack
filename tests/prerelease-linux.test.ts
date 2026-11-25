import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrereleaseManager } from "../scripts/build-prerelease-manager.ts";
import {
  freshChannelLeg,
  linuxGateDecision,
  PUBLISHED_LINUX_RELEASES,
  PUBLISHED_RELEASES,
  publishedPins,
  upgradeLeg,
} from "../scripts/check-prerelease-upgrade.ts";
import {
  BOOTSTRAP_ASSET,
  INSTALLER_SUMS,
  LINUX_INSTALLED_NOTE,
  MANAGER_ASSET,
  renderBootstrap,
} from "../scripts/installer/bootstrap.ts";
import { extractArchive } from "../scripts/installer/bundle.ts";
import {
  Channel,
  COMPOSE_ONLY_NATIVE_REFUSAL,
  REVIEWED_PREDECESSORS,
} from "../scripts/installer/channel.ts";
import {
  LINUX_SUMS,
  linuxSumsNames,
  officialArchive,
} from "../scripts/installer/download.ts";
import {
  type BundlePlatform,
  bundleArchiveName,
  COMPOSE_PAYLOAD,
  checksums,
  digest,
  hash,
  hostBundlePlatform,
  jsonBytes,
  managerAssetName,
  UNSUPPORTED_HOST,
} from "../scripts/installer/integrity.ts";
import { packageNativeStorageTool } from "../scripts/package-native-storage-tool.ts";
import {
  createPrereleasePlan,
  PRERELEASE_LINUX_PLATFORMS,
  PRERELEASE_PAYLOAD,
  packageLinuxPrerelease,
  packagePrerelease as packagePrereleaseActual,
  prereleaseMetadata,
  prereleaseNotes,
  releaseAssets,
  renderChecksums,
  requireLinuxManagerElf,
  verifyReleaseAssets as verifyReleaseAssetsActual,
  writeRehearsalInstaller,
} from "../scripts/prerelease-plan.ts";
import {
  NATIVE_STORAGE_TOOL_FILE,
  NATIVE_STORAGE_TOOL_MANIFEST,
} from "../src/backends/native-authored-storage-tool.ts";
import { officialArchive as next17OfficialArchive } from "./fixtures/prerelease-manager-next17/download.ts";
import { checksums as next17Checksums } from "./fixtures/prerelease-manager-next17/integrity.ts";
import { spawnSyncBounded } from "./helpers/bounded-spawn-sync.ts";

/*
 * HACK-2364: the Compose-only Linux candidate (x86_64, arm64). Linux is a
 * second, explicit bundle kind. These tests hold three things: the Linux kind
 * is exact; the installer and manager choose it only on Linux; and the macOS
 * asset set stays what every published macOS manager accepts.
 */

function packagePrerelease(
  options: Parameters<typeof packagePrereleaseActual>[0]
) {
  return packagePrereleaseActual({ ...options, nativeSignatures: () => {} });
}

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hack-linux-pre-")));
  roots.push(root);
  return root;
}

const VERSION = "5.0.0-next.23";
const revision = "a".repeat(40);
const plan = createPrereleasePlan({
  version: VERSION,
  sourceRevision: revision,
  ref: "refs/heads/next",
  eventName: "workflow_dispatch",
  channel: "prerelease",
});
/**
 * A minimal structurally valid ELF64 executable for `machine` (62 x86-64, 183
 * AArch64): the 64-byte header, one PT_LOAD program header covering the whole
 * file, then `payload`. `change` edits the bytes before they are returned.
 */
function elfExecutable(
  machine: number,
  payload = "manager fixture\n",
  change: (bytes: Buffer) => void = () => undefined
) {
  const body = Buffer.from(payload);
  const bytes = Buffer.alloc(64 + 56 + body.length);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16); // e_type ET_DYN
  bytes.writeUInt16LE(machine, 18);
  bytes.writeUInt32LE(1, 20); // e_version
  bytes.writeBigUInt64LE(64n, 32); // e_phoff
  bytes.writeUInt16LE(64, 52); // e_ehsize
  bytes.writeUInt16LE(56, 54); // e_phentsize
  bytes.writeUInt16LE(1, 56); // e_phnum
  bytes.writeUInt32LE(1, 64); // p_type PT_LOAD
  bytes.writeBigUInt64LE(0n, 64 + 8); // p_offset
  bytes.writeBigUInt64LE(BigInt(bytes.length), 64 + 32); // p_filesz
  body.copy(bytes, 64 + 56);
  change(bytes);
  return bytes;
}
/** A stand-in manager: a valid ELF for the architecture its file name says. */
const fixtureManager = async (output: string) => {
  const name = output.split("/").at(-1) ?? "";
  writeFileSync(
    output,
    elfExecutable(
      name.endsWith("linux-arm64") ? 183 : 62,
      `manager fixture for ${name}\n`
    ),
    { mode: 0o500 }
  );
  await Promise.resolve();
};

/** A fixture CLI: reports the version, otherwise prints what it was started with. */
const FIXTURE_CLI = `#!/bin/sh
if [ "\${1-}" = --version ]; then echo "hack v${VERSION}"; exit 0; fi
if [ "\${1-}" = write-umask ]; then umask > "$2"; : > "$2.created"; exit 0; fi
printf 'backend=%s\\n' "\${HACK_RUNTIME_BACKEND-<unset>}"
printf 'entrypoint=%s\\n' "\${HACK_CANDIDATE_ENTRYPOINT-<unset>}"
printf 'native_binary=%s\\n' "\${HACK_NATIVE_BINARY-<unset>}"
printf 'native_home=%s\\n' "\${HACK_NATIVE_HOME-<unset>}"
printf 'hack_home=%s\\n' "\${HACK_HOME-<unset>}"
printf 'args=%s\\n' "$*"
`;

/** A Compose bundle directory as `scripts/build-compose-candidate.sh` writes it. */
async function composeBundle(
  root: string,
  platform: BundlePlatform,
  changes: {
    readonly metadataPlatform?: string;
    readonly sourceRevision?: string;
    readonly version?: string;
  } = {}
) {
  const bundle = join(root, `bundle-${platform}-${changes.version ?? VERSION}`);
  mkdirSync(bundle, { mode: 0o700 });
  const files: Record<string, [string, number]> = {
    "hack-cli": [FIXTURE_CLI, 0o755],
    "hack-v5": [readFileSync("scripts/hack-v5.sh", "utf8"), 0o755],
    "README.md": ["fixture guide\n", 0o600],
    "prerelease.json": [
      `${JSON.stringify(
        {
          ...prereleaseMetadata({
            version: changes.version ?? VERSION,
            sourceRevision: changes.sourceRevision ?? revision,
            platform,
          }),
          ...(changes.metadataPlatform
            ? { platform: changes.metadataPlatform }
            : {}),
        },
        null,
        2
      )}\n`,
      0o600,
    ],
    "hack-lifecycle-supervisor": ["#!/bin/sh\nexit 0\n", 0o755],
    "hack-config-compiler": ["#!/bin/sh\nexit 0\n", 0o755],
    "hack.project.schema.json": ["{}\n", 0o600],
    "hack.local.schema.json": ["{}\n", 0o600],
  };
  expect(Object.keys(files)).toEqual([...COMPOSE_PAYLOAD]);
  for (const [name, [text, mode]] of Object.entries(files)) {
    writeFileSync(join(bundle, name), text, { mode });
    chmodSync(join(bundle, name), mode);
  }
  writeFileSync(
    join(bundle, "SHA256SUMS"),
    await renderChecksums({ root: bundle, names: COMPOSE_PAYLOAD })
  );
  return bundle;
}

function tar(archive: string, bundle: string, names: readonly string[]) {
  const result = Bun.spawnSync(
    ["tar", "--format=ustar", "-czf", archive, "-C", bundle, ...names],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, timeout: 10_000 }
  );
  expect(result.exitCode).toBe(0);
  return { archive, checksum: digest(archive) };
}

/** Both Linux job outputs, merged into one directory as the macOS job sees them. */
async function linuxAssets(root: string) {
  const merged = join(root, "linux-assets");
  mkdirSync(merged, { mode: 0o700 });
  for (const platform of PRERELEASE_LINUX_PLATFORMS) {
    const output = join(root, `out-${platform}`);
    await packageLinuxPrerelease({
      plan,
      bundle: await composeBundle(root, platform),
      output,
      platform,
      buildManager: fixtureManager,
    });
    expect(readdirSync(output).sort()).toEqual(
      [bundleArchiveName(VERSION, platform), managerAssetName(platform)].sort()
    );
    for (const name of readdirSync(output)) {
      copyFileSync(join(output, name), join(merged, name));
    }
  }
  return merged;
}

/** Smallest Linux ARM64 ELF header the storage tool byte contract accepts. */
function storageToolBytes() {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(183, 18);
  return bytes;
}

/** The macOS native bundle fixture, as tests/prerelease-plan.test.ts builds it. */
async function nativeBundle(root: string) {
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
            prereleaseMetadata({ version: VERSION, sourceRevision: revision })
          )
        : `fixture ${name}\n`
    );
  }
  writeFileSync(join(bundle, NATIVE_STORAGE_TOOL_FILE), storageToolBytes(), {
    mode: 0o500,
  });
  chmodSync(join(bundle, NATIVE_STORAGE_TOOL_FILE), 0o500);
  await packageNativeStorageTool({
    directory: bundle,
    sourceRevision: revision,
  });
  writeFileSync(
    join(bundle, "SHA256SUMS"),
    await renderChecksums({ root: bundle, names: PRERELEASE_PAYLOAD })
  );
  return bundle;
}

test("the plan lists the Linux assets apart from the unchanged macOS set", () => {
  expect(plan.assets).toEqual([
    `hack-${VERSION}-darwin-arm64-native.tar.gz`,
    "prerelease.json",
    "SHA256SUMS",
    "hack-next-manager-darwin-arm64",
    "hack-next-install.sh",
    "INSTALLER-SHA256SUMS",
  ]);
  expect(plan.linuxAssets).toEqual([
    `hack-${VERSION}-linux-x86_64-compose.tar.gz`,
    `hack-${VERSION}-linux-arm64-compose.tar.gz`,
    "hack-next-manager-linux-x86_64",
    "hack-next-manager-linux-arm64",
    "SHA256SUMS-linux",
  ]);
  expect(releaseAssets(plan)).toEqual([
    ...plan.assets,
    ...plan.linuxAssets,
    "prerelease-platforms.json",
  ]);
  expect(linuxSumsNames(VERSION)).toEqual(plan.linuxAssets.slice(0, 4));
  // The release-level metadata keeps the platform published managers require.
  expect(
    prereleaseMetadata({ version: VERSION, sourceRevision: revision }).platform
  ).toBe("darwin-arm64");
  expect(prereleaseNotes(plan)).toContain("Compose-only Linux");
});

test("each host maps to its own bundle kind and no other", () => {
  expect(hostBundlePlatform("darwin", "arm64")).toBe("darwin-arm64");
  expect(hostBundlePlatform("linux", "x64")).toBe("linux-x86_64");
  expect(hostBundlePlatform("linux", "arm64")).toBe("linux-arm64");
  for (const [platform, arch] of [
    ["darwin", "x64"],
    ["linux", "riscv64"],
    ["linux", "ia32"],
    ["win32", "x64"],
  ] as const) {
    expect(hostBundlePlatform(platform, arch)).toBeNull();
  }
  expect(UNSUPPORTED_HOST).toContain("Linux x86_64 or arm64");
  expect(UNSUPPORTED_HOST).toContain("Apple Silicon macOS");
});

fixtureTest(
  "the Linux bundle kind accepts exactly the Compose payload",
  async () => {
    const root = scratch();
    const platform = "linux-x86_64";
    const bundle = await composeBundle(root, platform);
    const names = [...COMPOSE_PAYLOAD, "SHA256SUMS"];
    const good = tar(join(root, "good.tar.gz"), bundle, names);
    const verified = extractArchive({
      ...good,
      destination: join(root, "good"),
      version: VERSION,
      platform,
    });
    expect(verified.identity.platform).toBe(platform);
    expect(Object.keys(verified.manifest).sort()).toEqual(
      [...COMPOSE_PAYLOAD].sort()
    );
    // The same archive is not a macOS bundle, and not the other architecture's.
    expect(() =>
      extractArchive({
        ...good,
        destination: join(root, "as-darwin"),
        version: VERSION,
      })
    ).toThrow("Incomplete candidate bundle.");
    expect(() =>
      extractArchive({
        ...good,
        destination: join(root, "as-arm64"),
        version: VERSION,
        platform: "linux-arm64",
      })
    ).toThrow("Prerelease identity mismatch.");

    // A missing member, and each macOS-only or unknown member, refuses.
    const missing = tar(
      join(root, "missing.tar.gz"),
      bundle,
      names.filter((name) => name !== "hack-config-compiler")
    );
    expect(() =>
      extractArchive({
        ...missing,
        destination: join(root, "missing"),
        version: VERSION,
        platform,
      })
    ).toThrow("Incomplete or foreign Compose candidate bundle.");
    for (const foreign of [
      "hack-native",
      "hack-relay-guest",
      "provider-pins.json",
      "hack-storage-root-witness",
    ]) {
      writeFileSync(join(bundle, foreign), "foreign\n");
      const extra = tar(join(root, `${foreign}.tar.gz`), bundle, [
        ...names,
        foreign,
      ]);
      expect(() =>
        extractArchive({
          ...extra,
          destination: join(root, `extra-${foreign}`),
          version: VERSION,
          platform,
        })
      ).toThrow(`This release contains ${foreign}`);
      rmSync(join(bundle, foreign));
    }
    mkdirSync(join(bundle, "mcp", "f".repeat(64)), { recursive: true });
    writeFileSync(join(bundle, "mcp", "f".repeat(64), "manifest.json"), "{}");
    const mcp = tar(join(root, "mcp.tar.gz"), bundle, [
      ...names,
      `mcp/${"f".repeat(64)}/manifest.json`,
    ]);
    expect(() =>
      extractArchive({
        ...mcp,
        destination: join(root, "mcp"),
        version: VERSION,
        platform,
      })
    ).toThrow("Foreign, duplicate or traversing archive entry.");
  }
);

fixtureTest(
  "a Linux channel keeps no private homes, runs Compose and refuses native",
  async () => {
    const root = scratch();
    const platform = "linux-arm64";
    const bundle = await composeBundle(root, platform);
    const input = tar(join(root, "bundle.tar.gz"), bundle, [
      ...COMPOSE_PAYLOAD,
      "SHA256SUMS",
    ]);
    const source = join(root, "source-manager");
    writeFileSync(source, "linux manager");
    // No hooks: the real signature and quiescence paths run, and on this
    // bundle kind they execute nothing from the bundle.
    const channel = new Channel(join(root, "channel"), source, {}, platform);
    channel.initialize();
    channel.validate();
    await channel.install(VERSION, input.archive, input.checksum);
    const version = join(root, "channel", "versions", VERSION);
    expect(readdirSync(version).sort()).toEqual([".receipt.json", "bundle"]);
    expect(
      JSON.parse(readFileSync(join(version, ".receipt.json"), "utf8")).homes
    ).toEqual({});
    expect(channel.state.selected).toBe(VERSION);
    channel.select(null);
    expect(channel.state.selected).toBeNull();
    channel.select(VERSION);
    expect(channel.state.selected).toBe(VERSION);

    const environment = channel.environment(VERSION, "compose");
    expect(environment.HACK_RUNTIME_BACKEND).toBe("compose");
    expect(environment.HACK_CANDIDATE_ENTRYPOINT).toBe("hack-next");
    expect(environment.HACK_NATIVE_BINARY).toBeUndefined();
    expect(environment.HACK_NATIVE_HOME).toBeUndefined();

    const saved = process.env.HACK_RUNTIME_BACKEND;
    try {
      process.env.HACK_RUNTIME_BACKEND = "native";
      await expect(channel.run(["up"])).rejects.toThrow(
        COMPOSE_ONLY_NATIVE_REFUSAL
      );
      process.env.HACK_RUNTIME_BACKEND = "docker";
      await expect(channel.run(["up"])).rejects.toThrow(
        "HACK_RUNTIME_BACKEND must be native or compose (unset selects compose)."
      );
    } finally {
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, "HACK_RUNTIME_BACKEND");
      } else {
        process.env.HACK_RUNTIME_BACKEND = saved;
      }
    }

    // HACK-2381: the manager's private umask must not reach the CLI. With the
    // manager at 077, the CLI runs with the caller's umask, the files it
    // creates get that umask, and the manager is back at 077 afterwards.
    Reflect.deleteProperty(process.env, "HACK_RUNTIME_BACKEND");
    const managerUmask = process.umask(0o077);
    try {
      for (const [caller, text, created] of [
        [0o022, "0022", 0o644],
        [0o027, "0027", 0o640],
        [0o077, "0077", 0o600],
      ] as const) {
        const seen = join(root, `umask-${text}`);
        expect(await channel.run(["write-umask", seen], caller)).toBe(0);
        expect(readFileSync(seen, "utf8").trim()).toBe(text);
        expect(statSync(`${seen}.created`).mode & 0o777).toBe(created);
        expect(process.umask()).toBe(0o077);
      }
      // Without a caller umask the child inherits the manager's, as before.
      const inherited = join(root, "umask-inherited");
      expect(await channel.run(["write-umask", inherited])).toBe(0);
      expect(readFileSync(inherited, "utf8").trim()).toBe("0077");
    } finally {
      process.umask(managerUmask);
      if (saved !== undefined) {
        process.env.HACK_RUNTIME_BACKEND = saved;
      }
    }

    // A macOS channel does not accept the Linux bundle, and the reverse.
    const mac = new Channel(join(root, "mac"), source, {
      signatures: () => {},
      quiescence: () => {},
    });
    mac.initialize();
    mac.validate();
    await expect(
      mac.install(VERSION, input.archive, input.checksum)
    ).rejects.toThrow("Incomplete candidate bundle.");
    // A version directory with private homes is not a Linux installation.
    mkdirSync(join(version, "native-home"), { mode: 0o700 });
    expect(() => channel.validate()).toThrow(
      "Incomplete or foreign version installation."
    );
  }
);

/**
 * Fail closed: if anything ever ran a real `curl` instead of the fixture's
 * (for example a shell whose startup files replace PATH), it could only reach
 * a discard port on this machine, never the network.
 */
const NO_NETWORK = {
  https_proxy: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "",
  no_proxy: "",
} as const;

/**
 * Why a shell cannot run the installer fixture hermetically, or null when it
 * can. zsh always sources the system `zshenv`, and the user's when HOME has
 * one. Where such a file sets PATH, the fixture's `uname` and `curl` are no
 * longer the ones the script runs, so the fixture would not decide the
 * platform or the download. Asked of the shell itself, started the same way
 * and with the same environment as the test starts it.
 */
function shellMissesFixtureTools(
  shell: string,
  env: Readonly<Record<string, string>>,
  bin: string
): string | null {
  const probe = spawnSyncBounded(
    [shell, "-c", "command -v uname; command -v curl"],
    { env: { ...env }, timeout: 10_000, stdout: "pipe", stderr: "pipe" }
  );
  const found = probe.stdout.toString().trim().split("\n");
  const wanted = [join(bin, "uname"), join(bin, "curl")];
  return probe.exitCode === 0 &&
    JSON.stringify(found) === JSON.stringify(wanted)
    ? null
    : `its startup files change PATH: uname and curl resolve to ${found.join(", ") || "nothing"}, not the fixture's`;
}

/**
 * Decided once, when the file loads, so a skip is a named line in the test
 * output and never a silent pass.
 */
const ZSH = Bun.which("zsh");
const ZSH_SKIP: string | null = (() => {
  if (ZSH === null) {
    return "no zsh on PATH";
  }
  // A host that lacks a fixture tool must skip this one test by name, not
  // fail the whole file while it loads.
  try {
    const f = bootstrapFixture({ system: "Linux", machine: "x86_64" });
    try {
      return shellMissesFixtureTools(ZSH, f.env, f.bin);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  } catch (error) {
    return `fixture unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
})();

/** The bootstrap fixture of tests/python-free-bootstrap.test.ts, with a chosen host. */
function bootstrapFixture(options: {
  readonly system: string;
  readonly machine: string;
  readonly linux?: boolean;
  readonly tools?: readonly string[];
  readonly badLinuxHash?: boolean;
}) {
  const root = scratch();
  const bin = join(root, "path");
  const home = join(root, "home");
  const temp = join(root, "temp");
  for (const path of [bin, home, temp]) {
    mkdirSync(path, { mode: 0o700 });
  }
  for (const tool of options.tools ?? [
    "sha256sum",
    "mktemp",
    "chmod",
    "rm",
    "cp",
    "cat",
    "date",
  ]) {
    const executable = Bun.which(tool);
    if (!executable) {
      throw new Error(`Required bootstrap fixture tool unavailable: ${tool}`);
    }
    symlinkSync(executable, join(bin, tool));
  }
  const script = (name: string, text: string) =>
    writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${text}\n`, {
      mode: 0o755,
    });
  script(
    "uname",
    `case "$1" in -s) echo ${options.system};; -m) echo ${options.machine};; esac`
  );
  const manager = join(root, "fixture-manager");
  writeFileSync(manager, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$INVOCATION"\n', {
    mode: 0o500,
  });
  script(
    "curl",
    `printf '%s\\n' "$@" >> "$CURL_ARGS"
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; output=$1; fi
  shift
done
cp "$FIXTURE_MANAGER" "$output"
printf '%s' '200 '`
  );
  const own = hash(readFileSync(manager));
  const bootstrap = join(root, "install.sh");
  writeFileSync(
    bootstrap,
    renderBootstrap(
      VERSION,
      "d".repeat(64),
      options.linux === false
        ? undefined
        : {
            "linux-x86_64": options.badLinuxHash ? "0".repeat(64) : own,
            "linux-arm64": options.badLinuxHash ? "0".repeat(64) : own,
          }
    )
  );
  const env = {
    HOME: home,
    PATH: bin,
    TMPDIR: temp,
    INVOCATION: join(root, "invocation"),
    CURL_ARGS: join(root, "curl-args"),
    FIXTURE_MANAGER: manager,
    ...NO_NETWORK,
  };
  const run = (args: readonly string[] = []) =>
    spawnSyncBounded(["/bin/sh", bootstrap, ...args], {
      env,
      timeout: 10_000,
      stdout: "pipe",
      stderr: "pipe",
    });
  return { root, bin, home, bootstrap, env, manager, run };
}

for (const [machine, asset] of [
  ["x86_64", "hack-next-manager-linux-x86_64"],
  ["amd64", "hack-next-manager-linux-x86_64"],
  ["aarch64", "hack-next-manager-linux-arm64"],
  ["arm64", "hack-next-manager-linux-arm64"],
] as const) {
  fixtureTest(
    `the installer accepts Linux ${machine}, needs no codesign and says native is macOS only`,
    () => {
      const f = bootstrapFixture({ system: "Linux", machine });
      const result = f.run();
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      // The manager is probed once (--help), then asked to install.
      expect(readFileSync(f.env.INVOCATION, "utf8")).toBe(
        `--help\n--root\n${f.home}/.hack-next\ninstall\n--version\n${VERSION}\n`
      );
      const args = readFileSync(f.env.CURL_ARGS, "utf8");
      expect(args).toContain(
        `https://github.com/hack-dance/hack/releases/download/v${VERSION}/${asset}\n`
      );
      expect(args).toContain("--proto\n=https");
      expect(args).not.toContain("--location");
      const stdout = result.stdout.toString();
      expect(stdout).toContain(LINUX_INSTALLED_NOTE);
      expect(stdout).toContain("Stable hack and shell PATH are unchanged.");
      expect(stdout).toContain('export PATH="$HOME/.hack-next/bin:$PATH"');
      // Nothing it ran needs root, codesign, shasum, Python or Bun.
      for (const tool of ["sudo", "codesign", "shasum", "python3", "bun"]) {
        expect(Bun.which(tool, { PATH: f.bin })).toBeNull();
      }
    }
  );
}

fixtureTest(
  "the installer uses shasum on Linux when sha256sum is missing, and refuses with neither",
  () => {
    const withShasum = bootstrapFixture({
      system: "Linux",
      machine: "x86_64",
      tools: ["shasum", "mktemp", "chmod", "rm", "cp", "cat", "date"],
    });
    if (Bun.which("shasum")) {
      expect(withShasum.run().exitCode).toBe(0);
    }
    const neither = bootstrapFixture({
      system: "Linux",
      machine: "x86_64",
      tools: ["mktemp", "chmod", "rm", "cp", "cat", "date"],
    });
    const refused = neither.run();
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain(
      "Required system tool unavailable: sha256sum (or shasum)"
    );
    expect(existsSync(neither.env.CURL_ARGS)).toBe(false);
  }
);

for (const [system, machine] of [
  ["Linux", "riscv64"],
  ["Linux", "i686"],
  ["Darwin", "x86_64"],
  ["FreeBSD", "amd64"],
] as const) {
  fixtureTest(
    `the installer refuses ${system} ${machine} and names the supported platforms`,
    () => {
      const f = bootstrapFixture({ system, machine });
      const result = f.run();
      expect(result.exitCode).not.toBe(0);
      const stderr = result.stderr.toString();
      expect(stderr).toContain(UNSUPPORTED_HOST);
      expect(stderr).toContain(`This host is ${system} ${machine}.`);
      expect(existsSync(f.env.CURL_ARGS)).toBe(false);
      expect(existsSync(f.env.INVOCATION)).toBe(false);
      expect(existsSync(join(f.home, ".hack-next"))).toBe(false);
    }
  );
}

fixtureTest(
  "a wrong Linux manager digest, or a macOS-only installer, changes nothing on Linux",
  () => {
    const bad = bootstrapFixture({
      system: "Linux",
      machine: "x86_64",
      badLinuxHash: true,
    });
    const mismatch = bad.run();
    expect(mismatch.exitCode).not.toBe(0);
    expect(mismatch.stderr.toString()).toContain("Manager checksum mismatch");
    expect(existsSync(bad.env.INVOCATION)).toBe(false);

    const macOnly = bootstrapFixture({
      system: "Linux",
      machine: "aarch64",
      linux: false,
    });
    const none = macOnly.run();
    expect(none.exitCode).not.toBe(0);
    expect(none.stderr.toString()).toContain(
      "This release has no Linux bundle"
    );
    expect(existsSync(macOnly.env.CURL_ARGS)).toBe(false);
  }
);

fixtureTest(
  "a supplied manager file skips the download and is still checked against the embedded digest",
  () => {
    const f = bootstrapFixture({ system: "Linux", machine: "x86_64" });
    rmSync(join(f.bin, "curl"));
    const local = f.run([
      "--manager",
      f.manager,
      "--archive",
      "/fixture.tar.gz",
      "--sha256",
      "a".repeat(64),
    ]);
    expect(local.stderr.toString()).toBe("");
    expect(local.exitCode).toBe(0);
    expect(readFileSync(f.env.INVOCATION, "utf8")).toBe(
      `--help\n--root\n${f.home}/.hack-next\ninstall\n--version\n${VERSION}\n--archive\n/fixture.tar.gz\n--sha256\n${"a".repeat(64)}\n`
    );
    rmSync(f.env.INVOCATION);
    const other = join(f.root, "other-manager");
    writeFileSync(other, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
    const wrong = f.run(["--manager", other]);
    expect(wrong.exitCode).not.toBe(0);
    expect(wrong.stderr.toString()).toContain("Manager checksum mismatch");
    expect(existsSync(f.env.INVOCATION)).toBe(false);
    for (const args of [
      ["--manager", "relative"],
      ["--manager", join(f.root, "absent")],
      ["--manager", f.manager, "--manager", f.manager],
    ]) {
      expect(f.run(args).exitCode).not.toBe(0);
      expect(existsSync(f.env.INVOCATION)).toBe(false);
    }
  }
);

test("the macOS branch of the one installer is the same whether or not Linux digests are embedded", () => {
  const mac = "d".repeat(64);
  const withLinux = renderBootstrap(VERSION, mac, {
    "linux-x86_64": "b".repeat(64),
    "linux-arm64": "c".repeat(64),
  });
  const macOnly = renderBootstrap(VERSION, mac);
  const differing = withLinux
    .split("\n")
    .filter((line, index) => line !== macOnly.split("\n")[index]);
  // Only the two Linux case arms differ.
  expect(differing).toHaveLength(2);
  expect(differing.every((line) => line.trimStart().startsWith("Linux/"))).toBe(
    true
  );
  for (const text of [withLinux, macOnly]) {
    expect(text).toContain(
      `Darwin/arm64) platform=darwin-arm64; manager_sha256='${mac}' ;;`
    );
    expect(text).toContain(
      "for tool in curl shasum codesign mktemp chmod rm date; do"
    );
    expect(text).toContain("sha256_check() { shasum -a 256 -c -; }");
    expect(text).toContain("'--manager is for Linux installs only.'");
    // No unquoted variable is used as a word list or a command.
    expect(text).not.toMatch(/for tool in \$|\| \$/);
    expect(text).toContain('codesign --verify --strict "$scratch/manager"');
    expect(text).toContain(
      `url="https://github.com/hack-dance/hack/releases/download/v${VERSION}/hack-next-manager-$platform"`
    );
  }
  expect(MANAGER_ASSET).toBe("hack-next-manager-darwin-arm64");
  expect(() =>
    renderBootstrap(VERSION, mac, {
      "linux-x86_64": "b".repeat(64),
      "linux-arm64": "nope",
    })
  ).toThrow("Invalid standalone Linux manager checksum.");
});

fixtureTest(
  "Linux packaging is exact, and the release set carries it in SHA256SUMS-linux only",
  async () => {
    const root = scratch();
    const bundle = await nativeBundle(root);
    const linux = await linuxAssets(root);

    // The macOS-only package is the baseline every published manager knows.
    const baseline = join(root, "baseline");
    await packagePrerelease({
      plan,
      bundle,
      output: baseline,
      buildManager: fixtureManager,
    });
    await verifyReleaseAssets({ plan, output: baseline });
    expect(readdirSync(baseline).sort()).toEqual([...plan.assets].sort());

    const output = join(root, "assets");
    await packagePrerelease({
      plan,
      bundle,
      output,
      buildManager: fixtureManager,
      linux,
    });
    await verifyReleaseAssets({ plan, output, linux: true });
    expect(readdirSync(output).sort()).toEqual([...releaseAssets(plan)].sort());

    // Byte for byte what a macOS-only release produces. (The archive differs
    // only by tar and gzip timestamps, so its members are compared instead.)
    for (const name of ["prerelease.json", MANAGER_ASSET]) {
      expect(readFileSync(join(output, name))).toEqual(
        readFileSync(join(baseline, name))
      );
    }
    const sums = readFileSync(join(output, "SHA256SUMS"), "utf8");
    expect(sums).toBe(
      `${digest(join(output, plan.archive))}  ${plan.archive}\n`
    );
    expect(sums.split("\n").filter(Boolean)).toHaveLength(1);
    expect(readFileSync(join(output, INSTALLER_SUMS), "utf8")).toBe(
      `${digest(join(output, MANAGER_ASSET))}  ${MANAGER_ASSET}\n${digest(join(output, BOOTSTRAP_ASSET))}  ${BOOTSTRAP_ASSET}\n`
    );
    expect(
      JSON.parse(readFileSync(join(output, "prerelease.json"), "utf8"))
    ).toEqual({
      schema: "hack.prerelease/v1",
      version: VERSION,
      tag: `v${VERSION}`,
      source_revision: revision,
      platform: "darwin-arm64",
    });

    // Linux checksums: exactly the two archives, then the two managers.
    const linuxSums = checksums(
      readFileSync(join(output, LINUX_SUMS)),
      linuxSumsNames(VERSION)
    );
    for (const name of linuxSumsNames(VERSION)) {
      expect(linuxSums[name]).toBe(digest(join(output, name)));
    }
    // The installer embeds the three manager digests of this exact set.
    const installer = readFileSync(join(output, BOOTSTRAP_ASSET), "utf8");
    for (const platform of ["darwin-arm64", ...PRERELEASE_LINUX_PLATFORMS]) {
      expect(installer).toContain(
        `platform=${platform}; manager_sha256='${digest(join(output, `hack-next-manager-${platform}`))}'`
      );
    }

    // Publication requires the full set and refuses any change to it.
    await expect(verifyReleaseAssets({ plan, output })).rejects.toThrow(
      "Expected exactly the candidate and standalone installer release assets"
    );
    await expect(
      verifyReleaseAssets({ plan, output: baseline, linux: true })
    ).rejects.toThrow(
      "Expected exactly the candidate and standalone installer release assets"
    );
    const manager = join(output, "hack-next-manager-linux-arm64");
    const original = readFileSync(manager);
    chmodSync(manager, 0o700);
    writeFileSync(manager, "tampered");
    await expect(
      verifyReleaseAssets({ plan, output, linux: true })
    ).rejects.toThrow("Linux assets do not match their checksum manifest");
    writeFileSync(manager, original);
    await verifyReleaseAssets({ plan, output, linux: true });
    // Publication boundary: an archive whose member changed after the Linux
    // job validated it is refused even when SHA256SUMS-linux was rendered from
    // the changed bytes, because every member is checked against the
    // archive's own SHA256SUMS here too.
    const x86 = join(output, bundleArchiveName(VERSION, "linux-x86_64"));
    const savedArchive = readFileSync(x86);
    const savedSums = readFileSync(join(output, LINUX_SUMS));
    const changed = await composeBundle(
      join(root, "out-linux-arm64"),
      "linux-x86_64"
    );
    writeFileSync(join(changed, "hack-cli"), "#!/bin/sh\necho changed\n");
    tar(x86, changed, [...COMPOSE_PAYLOAD, "SHA256SUMS"]);
    writeFileSync(
      join(output, LINUX_SUMS),
      await renderChecksums({ root: output, names: linuxSumsNames(VERSION) })
    );
    await expect(
      verifyReleaseAssets({ plan, output, linux: true })
    ).rejects.toThrow("Candidate checksum mismatch: hack-cli");
    writeFileSync(x86, savedArchive);
    writeFileSync(join(output, LINUX_SUMS), savedSums);
    await verifyReleaseAssets({ plan, output, linux: true });
    // A Linux line added to SHA256SUMS is refused, not published.
    writeFileSync(
      join(output, "SHA256SUMS"),
      `${sums}${"e".repeat(64)}  ${bundleArchiveName(VERSION, "linux-x86_64")}\n`
    );
    await expect(
      verifyReleaseAssets({ plan, output, linux: true })
    ).rejects.toThrow("Release archive does not match its outer checksum");
  }
);

fixtureTest(
  "release packaging refuses incomplete, foreign or mismatched Linux assets",
  async () => {
    const root = scratch();
    const bundle = await nativeBundle(root);
    const linux = await linuxAssets(root);
    const attempt = (name: string) =>
      packagePrerelease({
        plan,
        bundle,
        output: join(root, name),
        buildManager: fixtureManager,
        linux,
      });
    const arm = join(linux, bundleArchiveName(VERSION, "linux-arm64"));
    const saved = readFileSync(arm);
    rmSync(arm);
    await expect(attempt("missing")).rejects.toThrow(
      "Linux assets must be exactly the two Compose archives and the two Linux managers"
    );
    writeFileSync(arm, saved);
    writeFileSync(join(linux, "notes.txt"), "extra");
    await expect(attempt("foreign")).rejects.toThrow(
      "Linux assets must be exactly"
    );
    rmSync(join(linux, "notes.txt"));
    // The x86_64 archive under the arm64 name is not the arm64 bundle.
    copyFileSync(join(linux, bundleArchiveName(VERSION, "linux-x86_64")), arm);
    await expect(attempt("swapped")).rejects.toThrow(
      "Prerelease identity mismatch."
    );
    writeFileSync(arm, saved);
    // A manager that is not a structurally valid ELF executable for the
    // architecture refuses: the other architecture's, a script, a header
    // truncated at any point, a non-executable type, a program-header table
    // outside the file, and no loadable segment.
    const armManager = join(linux, "hack-next-manager-linux-arm64");
    const savedManager = readFileSync(armManager);
    const valid = elfExecutable(183);
    const invalid: Record<string, Buffer> = {
      "other architecture": readFileSync(
        join(linux, "hack-next-manager-linux-x86_64")
      ),
      script: Buffer.from("#!/bin/sh\nexit 0\n"),
      "20-byte stub": valid.subarray(0, 20),
      "header only": valid.subarray(0, 64),
      "truncated program header": valid.subarray(0, 64 + 55),
      "e_type ET_NONE": elfExecutable(183, undefined, (b) => {
        b.writeUInt16LE(0, 16);
      }),
      "e_type ET_REL": elfExecutable(183, undefined, (b) => {
        b.writeUInt16LE(1, 16);
      }),
      "e_type ET_CORE": elfExecutable(183, undefined, (b) => {
        b.writeUInt16LE(4, 16);
      }),
      "32-bit class": elfExecutable(183, undefined, (b) => {
        b.writeUInt8(1, 4);
      }),
      "no program headers": elfExecutable(183, undefined, (b) => {
        b.writeUInt16LE(0, 56);
      }),
      "program headers past the end": elfExecutable(183, undefined, (b) => {
        b.writeBigUInt64LE(BigInt(b.length), 32);
      }),
      "too many program headers": elfExecutable(183, undefined, (b) => {
        b.writeUInt16LE(0xff_ff, 56);
      }),
      "wrong program header size": elfExecutable(183, undefined, (b) => {
        b.writeUInt16LE(32, 54);
      }),
      "no loadable segment": elfExecutable(183, undefined, (b) => {
        b.writeUInt32LE(4, 64);
      }),
      "segment past the end": elfExecutable(183, undefined, (b) => {
        b.writeBigUInt64LE(BigInt(b.length) + 1n, 64 + 32);
      }),
    };
    for (const [what, bytes] of Object.entries(invalid)) {
      chmodSync(armManager, 0o700);
      writeFileSync(armManager, bytes);
      const refusal = await attempt(
        `manager-${what.replaceAll(" ", "-")}`
      ).then(
        () => "accepted",
        (error: unknown) => String(error)
      );
      expect([what, refusal]).toEqual([
        what,
        "Error: Linux manager for linux-arm64 is not a structurally valid ELF executable for that architecture",
      ]);
    }
    // Controls: the valid fixture, as ET_DYN and as ET_EXEC, is accepted.
    for (const type of [3, 2]) {
      const path = join(root, `valid-${type}`);
      writeFileSync(
        path,
        elfExecutable(183, undefined, (b) => {
          b.writeUInt16LE(type, 16);
        })
      );
      await requireLinuxManagerElf({ path, platform: "linux-arm64" });
    }
    writeFileSync(armManager, savedManager);
    // A member changed after the archive's own checksums were written refuses
    // on the packaging host too, not only in the Linux build job.
    const tampered = await composeBundle(
      join(root, "out-linux-x86_64"),
      "linux-arm64"
    );
    writeFileSync(join(tampered, "hack-cli"), "#!/bin/sh\necho changed\n");
    tar(arm, tampered, [...COMPOSE_PAYLOAD, "SHA256SUMS"]);
    await expect(attempt("member")).rejects.toThrow(
      "Candidate checksum mismatch: hack-cli"
    );
    // An archive built from another commit is not this release's.
    const other = join(root, "other");
    await packageLinuxPrerelease({
      plan: { ...plan, source_revision: "b".repeat(40) },
      bundle: await composeBundle(
        join(root, "out-linux-arm64"),
        "linux-arm64",
        {
          sourceRevision: "b".repeat(40),
        }
      ),
      output: other,
      platform: "linux-arm64",
      buildManager: fixtureManager,
    });
    copyFileSync(join(other, bundleArchiveName(VERSION, "linux-arm64")), arm);
    await expect(attempt("revision")).rejects.toThrow(
      "Linux archive for linux-arm64 was built from another source revision"
    );
  }
);

fixtureTest(
  "Linux bundle packaging refuses anything but the exact built bundle",
  async () => {
    const root = scratch();
    const platform = "linux-x86_64";
    const pack = (bundle: string, name: string) =>
      packageLinuxPrerelease({
        plan,
        bundle,
        output: join(root, name),
        platform,
        buildManager: fixtureManager,
      });
    const bundle = await composeBundle(root, platform);
    writeFileSync(join(bundle, "hack-native"), "native\n");
    await expect(pack(bundle, "extra")).rejects.toThrow(
      "Compose prerelease bundle must contain exactly the complete payload and checksums"
    );
    rmSync(join(bundle, "hack-native"));
    writeFileSync(join(bundle, "hack-cli"), "changed after checksums\n");
    await expect(pack(bundle, "tampered")).rejects.toThrow(
      "Compose bundle checksums do not match its complete payload"
    );
    rmSync(bundle, { recursive: true });
    const wrong = await composeBundle(root, platform, {
      metadataPlatform: "darwin-arm64",
    });
    await expect(pack(wrong, "platform")).rejects.toThrow(
      "Bundle metadata must match the requested version, revision and platform"
    );
    await expect(
      packageLinuxPrerelease({
        plan,
        bundle: wrong,
        output: join(root, "darwin"),
        platform: "darwin-arm64",
        buildManager: fixtureManager,
      })
    ).rejects.toThrow("Linux packaging requires a Linux bundle platform");
  }
);

function fetchMock(
  implementation: (...args: Parameters<typeof fetch>) => Promise<Response>
): typeof fetch {
  return Object.assign(implementation, { preconnect: fetch.preconnect });
}

fixtureTest(
  "published macOS managers still accept the release: their SHA256SUMS parse and download are untouched",
  async () => {
    const root = scratch();
    const output = join(root, "assets");
    await packagePrerelease({
      plan,
      bundle: await nativeBundle(root),
      output,
      buildManager: fixtureManager,
      linux: await linuxAssets(root),
    });
    const sums = readFileSync(join(output, "SHA256SUMS"));
    // The parse every published manager (next.17 to next.22) runs: exactly
    // its own archive name, and any other line refuses.
    for (const parse of [next17Checksums, checksums]) {
      expect(parse(sums, [plan.archive])).toEqual({
        [plan.archive]: digest(join(output, plan.archive)),
      });
      // Control: this is why the Linux entries are in their own file.
      expect(() =>
        parse(Buffer.concat([sums, readFileSync(join(output, LINUX_SUMS))]), [
          plan.archive,
        ])
      ).toThrow("Malformed, duplicate or foreign checksum entry.");
    }

    // The whole download sequence of the released next.17 manager, and of the
    // current macOS manager, against a release that lists all eleven assets.
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
        fetchMock((url) => {
          const bytes = responses[String(url)];
          if (!bytes) {
            throw new Error(`Unexpected fixture request ${String(url)}`);
          }
          requested.push(String(url));
          return Promise.resolve(new Response(Buffer.from(bytes)));
        })
      );
      for (const download of [next17OfficialArchive, officialArchive]) {
        requested.length = 0;
        const stage = join(root, `stage-${download === officialArchive}`);
        mkdirSync(stage, { mode: 0o700 });
        const result = await download(stage, VERSION);
        expect(result.checksum).toBe(digest(join(output, plan.archive)));
        expect(readFileSync(result.archive)).toEqual(
          readFileSync(join(output, plan.archive))
        );
        expect(result.releaseMetadata.platform).toBe("darwin-arm64");
        // A macOS manager never fetches a Linux asset.
        expect(requested.filter((url) => url.includes("linux"))).toEqual([]);
      }

      // The Linux manager reads SHA256SUMS-linux and its own archive, and binds
      // the archive to the tag's commit through the same release metadata.
      for (const platform of PRERELEASE_LINUX_PLATFORMS) {
        requested.length = 0;
        const stage = join(root, `stage-${platform}`);
        mkdirSync(stage, { mode: 0o700 });
        const result = await officialArchive(
          stage,
          VERSION,
          undefined,
          platform
        );
        const name = bundleArchiveName(VERSION, platform);
        expect(result.checksum).toBe(digest(join(output, name)));
        const released: Record<string, unknown> = result.releaseMetadata;
        expect(released).toEqual({
          schema: "hack.prerelease/v1",
          version: VERSION,
          tag: `v${VERSION}`,
          source_revision: revision,
          platform,
        });
        expect(requested.map((url) => url.split("/").at(-1))).toEqual([
          `v${VERSION}`,
          "prerelease.json",
          `v${VERSION}`,
          LINUX_SUMS,
          name,
        ]);
        const verified = extractArchive({
          ...result,
          destination: join(stage, "bundle"),
          version: VERSION,
          platform,
        });
        expect(verified.identity.platform).toBe(platform);
      }
      // A Linux archive from a different commit than the tag is refused.
      const stage = join(root, "stage-revision");
      mkdirSync(stage, { mode: 0o700 });
      const result = await officialArchive(
        stage,
        VERSION,
        undefined,
        "linux-x86_64"
      );
      expect(() =>
        extractArchive({
          ...result,
          releaseMetadata: {
            ...result.releaseMetadata,
            source_revision: "c".repeat(40),
          },
          destination: join(stage, "bundle"),
          version: VERSION,
          platform: "linux-x86_64",
        })
      ).toThrow("Archive metadata differs from the pinned release.");
    } finally {
      mock.mockRestore();
    }
  }
);

test("Linux pins are separate, so the macOS pins stay the reviewed pairs", () => {
  // Each digest is that platform's line in the release's SHA256SUMS-linux.
  expect(PUBLISHED_LINUX_RELEASES).toEqual({
    "5.0.0-next.23": {
      "linux-x86_64": {
        manager:
          "e946ba95a49018b0eff8ff81161d1ccf1a086627773e62a30db53e4e94c9195b",
        archive:
          "21a3709c8b78adaa1f399b3c91d3213862fc51cfaefbf0a0e6d06ff76fd7bb6f",
      },
      "linux-arm64": {
        manager:
          "be1599a85cd4251df4a9779f2e7fa16480094ebb48ec97ca4e9dad6dd73d0094",
        archive:
          "6874a73a1cea9410527b4831ffec7a46c4bccb28312620adfd335e0fb01d40de",
      },
    },
    "5.0.0-next.24": {
      "linux-x86_64": {
        manager:
          "00e6e01b05bd6f05ac32a41ab06b7309767d701653b220ede5148c2ffb66388c",
        archive:
          "379a0aa616fbc956e5871bc010f201eb9fead450dab462de124efdf23e7845ab",
      },
      "linux-arm64": {
        manager:
          "f52beab69e5ec62e237da74ae64a0cdef7887bcae51380ca6a0270e4b45e4d27",
        archive:
          "1636630b2a378c8d3aeb97f8015cd3c8d61c3db4d8a6e49637085d020ad7fbf6",
      },
    },
    "5.0.0-next.25": {
      "linux-x86_64": {
        manager:
          "6219e16a7b2d3eb83eaa440315829c4d77fb20af0f74664d04d8491899ea6404",
        archive:
          "30a79d0df88a947df76f229eee658dd40c7b2ab0faf42345c5ee3a71ba683912",
      },
      "linux-arm64": {
        manager:
          "a07bd7d5cd8cf6c0788c1ab2d9cd29d481850e73065709683d3c2c372182fbc4",
        archive:
          "9cd6943ccab29d18c7facd29051a1910b6a8e7e12f1ce5ed921a55e1e352bf44",
      },
    },
  });
  for (const [version, pins] of Object.entries(PUBLISHED_RELEASES)) {
    expect(Object.keys(pins).sort()).toEqual(["archive", "manager"]);
    expect(publishedPins(version, "darwin-arm64")).toBe(pins);
    // 5.0.0-next.23 is the first release with Linux assets.
    const linux = PUBLISHED_LINUX_RELEASES[version];
    for (const platform of PRERELEASE_LINUX_PLATFORMS) {
      expect(publishedPins(version, platform)).toBe(linux?.[platform]);
    }
  }
  // Every release with Linux assets is also a pinned macOS release, pins both
  // platforms, and its Linux managers are reviewed predecessors.
  for (const [version, platforms] of Object.entries(PUBLISHED_LINUX_RELEASES)) {
    expect(PUBLISHED_RELEASES[version]).toBeDefined();
    expect(Object.keys(platforms).sort()).toEqual(
      [...PRERELEASE_LINUX_PLATFORMS].sort()
    );
    for (const pins of Object.values(platforms)) {
      expect(REVIEWED_PREDECESSORS).toContain(pins?.manager);
    }
  }
});

test("the Linux gate leg is decided from reviewed pins, never from a missing asset", () => {
  const pin = { manager: "a".repeat(64), archive: "b".repeat(64) };
  const platform = "linux-x86_64";
  const shipped = {
    "5.0.0-next.23": { "linux-x86_64": pin, "linux-arm64": pin },
  };
  // Before the first Linux release: nothing in reviewed history and next.22
  // has no Linux assets, so there is nothing to upgrade.
  expect(
    linuxGateDecision({
      previous: "5.0.0-next.22",
      platform,
      previousHasManagerAsset: false,
      history: {},
    })
  ).toEqual({ leg: "fresh" });
  // Today, with the reviewed history itself: next.23 is pinned, so the next
  // release upgrades it, and next.22 is no longer a "first release" case.
  // The exact digests are asserted in the pins test above; this checks the
  // decision picks each platform's own pair.
  for (const real of PRERELEASE_LINUX_PLATFORMS) {
    const reviewed = publishedPins("5.0.0-next.23", real);
    if (reviewed === undefined) {
      throw new Error(`5.0.0-next.23 has no reviewed ${real} pin`);
    }
    expect(
      linuxGateDecision({
        previous: "5.0.0-next.23",
        platform: real,
        previousHasManagerAsset: true,
      })
    ).toEqual({ leg: "upgrade", previous: "5.0.0-next.23", pins: reviewed });
    expect(() =>
      linuxGateDecision({
        previous: "5.0.0-next.22",
        platform: real,
        previousHasManagerAsset: false,
      })
    ).toThrow("That is not a first Linux release");
  }
  expect(publishedPins("5.0.0-next.23", "linux-x86_64")).not.toEqual(
    publishedPins("5.0.0-next.23", "linux-arm64")
  );
  expect(
    linuxGateDecision({
      previous: null,
      platform,
      previousHasManagerAsset: false,
      history: {},
    })
  ).toEqual({ leg: "fresh" });
  // A pinned predecessor with its assets: the upgrade leg, with its pins.
  expect(
    linuxGateDecision({
      previous: "5.0.0-next.23",
      platform,
      previousHasManagerAsset: true,
      history: shipped,
    })
  ).toEqual({ leg: "upgrade", previous: "5.0.0-next.23", pins: pin });
  // A reviewed Linux predecessor whose manager asset is gone fails; it is
  // not a first release.
  expect(() =>
    linuxGateDecision({
      previous: "5.0.0-next.23",
      platform,
      previousHasManagerAsset: false,
      history: shipped,
    })
  ).toThrow("asset is missing");
  // Once Linux is in reviewed history, an unpinned previous release fails,
  // with or without assets.
  for (const previousHasManagerAsset of [false, true]) {
    expect(() =>
      linuxGateDecision({
        previous: "5.0.0-next.24",
        platform,
        previousHasManagerAsset,
        history: shipped,
      })
    ).toThrow(
      previousHasManagerAsset
        ? "is not pinned"
        : "That is not a first Linux release"
    );
  }
  // A pin for the other architecture only is not a pin for this one.
  expect(() =>
    linuxGateDecision({
      previous: "5.0.0-next.23",
      platform,
      previousHasManagerAsset: false,
      history: { "5.0.0-next.23": { "linux-arm64": pin } },
    })
  ).toThrow("That is not a first Linux release");
  // The pin chore cannot be skipped after the first Linux release: assets
  // with no pin fail even while the reviewed history is still empty.
  expect(() =>
    linuxGateDecision({
      previous: "5.0.0-next.23",
      platform,
      previousHasManagerAsset: true,
      history: {},
    })
  ).toThrow("has linux-x86_64 assets but is not pinned");
});

fixtureTest(
  "a Linux build job's rehearsal installer embeds only its own manager digest",
  async () => {
    const root = scratch();
    const output = join(root, "out");
    mkdirSync(output);
    writeFileSync(join(output, "hack-next-manager-linux-arm64"), "manager");
    const directory = join(root, "rehearsal");
    await writeRehearsalInstaller({
      plan,
      output,
      directory,
      platform: "linux-arm64",
    });
    const text = readFileSync(join(directory, BOOTSTRAP_ASSET), "utf8");
    expect(text).toBe(
      renderBootstrap(VERSION, "0".repeat(64), {
        "linux-x86_64": "0".repeat(64),
        "linux-arm64": hash(Buffer.from("manager")),
      })
    );
    await expect(
      writeRehearsalInstaller({
        plan,
        output,
        directory: join(root, "mac"),
        platform: "darwin-arm64",
      })
    ).rejects.toThrow("The rehearsal installer is for a Linux build host");
  }
);

/** Compose selected by default and by name. */
const BACKEND_ENVIRONMENTS: readonly Record<string, string>[] = [
  {},
  { HACK_RUNTIME_BACKEND: "compose" },
];

/** The bundle's launcher (`hack-v5`) in a directory shaped like `kind`. */
function launcherBundle(kind: "linux" | "no-metadata" | "darwin-metadata") {
  const root = scratch();
  copyFileSync("scripts/hack-v5.sh", join(root, "hack-v5"));
  chmodSync(join(root, "hack-v5"), 0o755);
  writeFileSync(join(root, "hack-cli"), FIXTURE_CLI, { mode: 0o755 });
  if (kind !== "no-metadata") {
    writeFileSync(
      join(root, "prerelease.json"),
      `${JSON.stringify(
        prereleaseMetadata({
          version: VERSION,
          sourceRevision: revision,
          platform: kind === "linux" ? "linux-x86_64" : "darwin-arm64",
        }),
        null,
        2
      )}\n`
    );
  }
  const run = (env: Record<string, string>, args: readonly string[] = ["up"]) =>
    spawnSyncBounded([join(root, "hack-v5"), ...args], {
      env: { PATH: "/usr/bin:/bin", HOME: root, ...env },
      timeout: 10_000,
      stdout: "pipe",
      stderr: "pipe",
    });
  return { root, run };
}

fixtureTest(
  "the bundle launcher runs a Linux bundle on Compose and refuses native there",
  () => {
    const linux = launcherBundle("linux");
    for (const env of BACKEND_ENVIRONMENTS) {
      const result = linux.run({
        ...env,
        HACK_NATIVE_BINARY: "/wrong/executor",
        HACK_NATIVE_HOME: "/wrong/home",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(
        "backend=compose\nentrypoint=hack-v5\nnative_binary=<unset>\nnative_home=<unset>\nhack_home=<unset>\nargs=up\n"
      );
    }
    // `native ...` commands reach the CLI, which answers for the platform.
    const setup = linux.run({}, ["native", "setup", "--json"]);
    expect(setup.exitCode).toBe(0);
    expect(setup.stdout.toString()).toContain(
      "backend=compose\nentrypoint=hack-v5\n"
    );
    expect(setup.stdout.toString()).toContain("args=native setup --json\n");
    const native = linux.run({ HACK_RUNTIME_BACKEND: "native" });
    expect(native.exitCode).toBe(69);
    expect(native.stderr.toString()).toBe(
      "This is a Compose-only Linux candidate; the native backend is Apple Silicon macOS only. Unset HACK_RUNTIME_BACKEND (or set it to compose).\n"
    );
    expect(native.stdout.toString()).toBe("");
    expect(linux.run({ HACK_RUNTIME_BACKEND: "docker" }).exitCode).toBe(64);

    // Only a bundle whose own metadata names Linux is Compose-only. Any other
    // bundle without hack-native is still incomplete, on every backend.
    for (const kind of ["no-metadata", "darwin-metadata"] as const) {
      for (const env of BACKEND_ENVIRONMENTS) {
        const incomplete = launcherBundle(kind).run(env);
        expect(incomplete.exitCode).toBe(69);
        expect(incomplete.stderr.toString()).toContain(
          "Incomplete candidate bundle: hack-cli and hack-native are required."
        );
      }
    }
  }
);

function contractNames(script: string) {
  const line = script
    .split("\n")
    .find((text) => text.trimStart().startsWith("sha256sum "));
  return (line ?? "")
    .trim()
    .replace(/ > SHA256SUMS$/, "")
    .split(" ")
    .slice(1);
}

test("the Linux builder checksums exactly the Compose payload, in order, with the installed modes", async () => {
  const script = await Bun.file("scripts/build-compose-candidate.sh").text();
  // Packaging compares SHA256SUMS byte for byte, so order is part of the contract.
  expect(contractNames(script)).toEqual([...COMPOSE_PAYLOAD]);
  // Anything the script writes into the bundle must also be checksummed.
  for (const [, name] of script.matchAll(/"\$out\/([\w.-]+)"/g)) {
    expect(COMPOSE_PAYLOAD as readonly string[]).toContain(name ?? "");
  }
  // It builds none of the macOS-only parts and signs nothing.
  for (const absent of [
    "hack-native",
    "hack-relay-guest",
    "provider-pins.json",
    "hack-storage-root-witness",
    "package-mcp-bundle",
    "codesign",
    "zig",
  ]) {
    expect(script).not.toContain(absent);
  }
  expect(script).toContain('HACK_PRERELEASE_PLATFORM="$platform"');
  expect(script).toContain(`--define "__HACK_BUILD_VERSION__=\\"$version\\""`);
});

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly needs?: string | string[];
  readonly if?: string;
  readonly environment?: string;
  readonly "runs-on"?: string;
  readonly permissions?: Record<string, string>;
  readonly strategy?: { readonly matrix?: { readonly include?: unknown } };
  readonly steps: readonly Step[];
}

test("the prerelease workflow builds, installs and gates Linux before the macOS job packages one release set", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(".github/workflows/prerelease.yml").text()
  ) as { jobs: Record<string, Job> };
  expect(Object.keys(workflow.jobs)).toEqual([
    "plan",
    "build-linux",
    "build",
    "publish",
  ]);
  const linux = workflow.jobs["build-linux"] as Job;
  expect(linux.needs).toBe("plan");
  // It can read the repository and nothing else; it has no approval
  // environment because it cannot publish.
  expect(linux.permissions).toEqual({ contents: "read" });
  expect(linux.environment).toBeUndefined();
  expect(linux.strategy?.matrix?.include).toEqual([
    { os: "ubuntu-latest", platform: "linux-x86_64" },
    { os: "ubuntu-24.04-arm", platform: "linux-arm64" },
  ]);
  const runs = linux.steps.map((step) => step.run ?? "");
  const order = [
    'scripts/build-compose-candidate.sh "$HACK_PRERELEASE_BUNDLE" "--version=$HACK_PRERELEASE_VERSION"',
    'bun scripts/check-candidate-daemon-identity.ts "$HACK_PRERELEASE_BUNDLE" "$HACK_PRERELEASE_VERSION"',
    "bun scripts/prerelease-plan.ts package-linux",
    "bun scripts/prerelease-plan.ts rehearsal-installer",
    "bun scripts/check-prerelease-upgrade.ts",
    "bun scripts/linux-first-run-check.ts",
  ].map((command) => runs.findIndex((run) => run.includes(command)));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  const firstRun = runs[order.at(-1) as number] ?? "";
  for (const flag of ["--installer", "--archive", "--sha256", "--manager"]) {
    expect(firstRun).toContain(flag);
  }
  expect(firstRun).not.toContain("sudo");
  // Same pins as the macOS job.
  const pin = (job: Job, prefix: string) =>
    job.steps.find((step) => step.uses?.startsWith(prefix));
  const mac = workflow.jobs.build as Job;
  expect(pin(linux, "oven-sh/setup-bun@")?.with).toEqual(
    pin(mac, "oven-sh/setup-bun@")?.with
  );
  expect(pin(linux, "dtolnay/rust-toolchain@")?.uses).toBe(
    pin(mac, "dtolnay/rust-toolchain@")?.uses
  );
  const upload = pin(linux, "actions/upload-artifact@");
  expect(linux.steps.indexOf(upload as Step)).toBe(linux.steps.length - 1);

  // The macOS job waits for both architectures and packages them in the step
  // that renders every checksum file and the installer.
  expect(mac.needs).toEqual(["plan", "build-linux"]);
  expect(mac["runs-on"]).toBe("macos-15");
  const fetched = mac.steps.findIndex((step) =>
    step.uses?.startsWith("actions/download-artifact@")
  );
  const packaged = mac.steps.findIndex((step) =>
    (step.run ?? "").includes("scripts/prerelease-plan.ts package")
  );
  const gated = mac.steps.findIndex((step) =>
    (step.run ?? "").includes("scripts/check-prerelease-upgrade.ts")
  );
  expect(mac.steps[fetched]?.with).toMatchObject({ "merge-multiple": true });
  expect(fetched).toBeGreaterThan(-1);
  expect(packaged).toBeGreaterThan(fetched);
  expect(gated).toBeGreaterThan(packaged);
  expect(
    mac.steps.some((step) =>
      (step.run ?? "").includes(
        "HACK_PRERELEASE_LINUX_ASSETS=%s/prerelease-linux"
      )
    )
  ).toBe(true);

  // Publication uses macOS signature verification and keeps the same approval gate.
  const publish = workflow.jobs.publish as Job;
  expect(publish.needs).toEqual(["plan", "build"]);
  expect(publish.environment).toBe("v5-prerelease");
  expect(publish["runs-on"]).toBe("macos-15");
  expect(publish.if).toContain("inputs.publish");
  expect(
    publish.steps.filter((step) => step.run !== undefined).map((s) => s.run)
  ).toEqual([
    `printf 'HACK_PRERELEASE_OUTPUT=%s/prerelease-assets\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"`,
    "bun scripts/prerelease-plan.ts publish",
  ]);
  // Only the publish job can write, and only it holds a token in a job env.
  for (const [name, job] of Object.entries(workflow.jobs)) {
    expect([name, job.permissions?.contents]).toEqual([
      name,
      name === "publish" ? "write" : "read",
    ]);
    for (const step of job.steps) {
      expect(step.run ?? "").not.toContain("${{");
      expect(step.run ?? "").not.toMatch(/gh release|git tag|git push/);
    }
  }
});

test("release packaging without the Linux assets refuses instead of publishing a macOS-only set", () => {
  const result = spawnSyncBounded(
    [process.execPath, "scripts/prerelease-plan.ts", "package"],
    {
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_REF: "refs/heads/next",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        RELEASE_CHANNEL: "prerelease",
        HACK_PRERELEASE_VERSION: VERSION,
        HACK_PRERELEASE_SOURCE_REVISION: revision,
        HACK_PRERELEASE_BUNDLE: "/nonexistent/bundle",
        HACK_PRERELEASE_OUTPUT: "/nonexistent/output",
      },
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(
    "Packaging requires HACK_PRERELEASE_LINUX_ASSETS"
  );
});

const linuxHost = hostBundlePlatform();
test.skipIf(linuxHost === null || linuxHost === "darwin-arm64")(
  "a compiled Linux manager installs through the installer, runs Compose, refuses native and uninstalls",
  async () => {
    const platform = linuxHost as BundlePlatform;
    const root = scratch();
    const home = join(root, "home");
    const temp = join(root, "tmp");
    for (const directory of [home, temp]) {
      mkdirSync(directory, { mode: 0o700 });
    }
    const output = join(root, "out");
    await packageLinuxPrerelease({
      plan,
      bundle: await composeBundle(root, platform),
      output,
      platform,
      buildManager: buildPrereleaseManager,
    });
    const manager = join(output, managerAssetName(platform));
    const archive = join(output, bundleArchiveName(VERSION, platform));
    // The structural check accepts a real compiled manager for this host and
    // refuses it as the other architecture's.
    await requireLinuxManagerElf({ path: manager, platform });
    await expect(
      requireLinuxManagerElf({
        path: manager,
        platform: platform === "linux-arm64" ? "linux-x86_64" : "linux-arm64",
      })
    ).rejects.toThrow("not a structurally valid ELF executable");
    const rehearsal = join(root, "rehearsal");
    await writeRehearsalInstaller({ plan, output, directory: rehearsal });
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      TMPDIR: temp,
      HACK_NATIVE_BINARY: "/wrong/executor",
      HACK_NATIVE_HOME: "/wrong/home",
    };
    const run = (argv: readonly string[], extra: Record<string, string> = {}) =>
      spawnSyncBounded([...argv], {
        env: { ...env, ...extra },
        timeout: 60_000,
        stdout: "pipe",
        stderr: "pipe",
      });
    const install = run([
      "/bin/sh",
      join(rehearsal, BOOTSTRAP_ASSET),
      "--manager",
      manager,
      "--archive",
      archive,
      "--sha256",
      digest(archive),
    ]);
    expect(install.stderr.toString()).toBe("");
    expect(install.exitCode).toBe(0);
    expect(install.stdout.toString()).toContain(LINUX_INSTALLED_NOTE);
    const launcher = join(home, ".hack-next/bin/hack-next");
    // Installed under HOME only, private, with the manager that was verified.
    expect(readdirSync(home)).toEqual([".hack-next"]);
    expect(digest(join(home, ".hack-next/manager"))).toBe(digest(manager));
    expect(
      readdirSync(join(home, ".hack-next/versions", VERSION)).sort()
    ).toEqual([".receipt.json", "bundle"]);

    expect(run([launcher, "--version"]).stdout.toString()).toBe(
      `hack v${VERSION}\n`
    );
    // HACK-2381: through the real launcher and compiled manager, the CLI gets
    // the caller's umask, not the manager's 077, while the manager's own
    // files stay private.
    for (const caller of ["0022", "0027", "0077"]) {
      const seen = join(root, `launcher-umask-${caller}`);
      const viaLauncher = run([
        "/bin/sh",
        "-c",
        `umask ${caller}; exec "$0" write-umask "$1"`,
        launcher,
        seen,
      ]);
      expect(viaLauncher.stderr.toString()).toBe("");
      expect(viaLauncher.exitCode).toBe(0);
      expect(readFileSync(seen, "utf8").trim()).toBe(caller);
    }
    expect(
      statSync(join(root, "launcher-umask-0022.created")).mode & 0o777
    ).toBe(0o644);
    run(["/bin/sh", "-c", 'umask 022; exec "$0" --manager stable', launcher]);
    run(["/bin/sh", "-c", 'umask 022; exec "$0" --manager rollback', launcher]);
    expect(
      statSync(join(home, ".hack-next/.selection.json")).mode & 0o777
    ).toBe(0o600);
    expect(statSync(join(home, ".hack-next")).mode & 0o777).toBe(0o700);

    // Unset selects Compose on Linux; native selectors never reach the CLI.
    const up = run([launcher, "up", "-d"]);
    expect(up.exitCode).toBe(0);
    expect(up.stdout.toString()).toBe(
      "backend=compose\nentrypoint=hack-next\nnative_binary=<unset>\nnative_home=<unset>\nhack_home=<unset>\nargs=up -d\n"
    );
    const setup = run([launcher, "native", "setup", "--json"]);
    expect(setup.stdout.toString()).toContain("backend=compose\n");
    expect(setup.stdout.toString()).toContain("args=native setup --json\n");
    const native = run([launcher, "up"], { HACK_RUNTIME_BACKEND: "native" });
    expect(native.exitCode).toBe(1);
    expect(native.stderr.toString()).toBe(
      `hack-next: ${COMPOSE_ONLY_NATIVE_REFUSAL}\n`
    );
    expect(native.stdout.toString()).toBe("");
    // A changed bundle file stops the launch.
    const cli = join(home, ".hack-next/versions", VERSION, "bundle/hack-cli");
    const original = readFileSync(cli);
    chmodSync(cli, 0o755);
    writeFileSync(cli, "#!/bin/sh\necho tampered\n");
    const tampered = run([launcher, "up"]);
    expect(tampered.exitCode).toBe(1);
    expect(tampered.stderr.toString()).toContain("Candidate checksum mismatch");
    expect(tampered.stdout.toString()).toBe("");
    writeFileSync(cli, original);
    expect(run([launcher, "--version"]).exitCode).toBe(0);
    // The macOS archive name is not what this manager installs.
    const status = JSON.parse(
      run([launcher, "--manager", "status"]).stdout.toString()
    ) as { selected: string; installed: string[] };
    expect(status).toMatchObject({ selected: VERSION, installed: [VERSION] });

    // The upgrade gate's first-Linux-release leg, on the same package.
    const work = join(root, "gate");
    mkdirSync(work, { mode: 0o700 });
    const copies = join(work, "candidate");
    mkdirSync(copies, { mode: 0o700 });
    copyFileSync(manager, join(copies, "manager"));
    copyFileSync(archive, join(copies, "archive.tar.gz"));
    freshChannelLeg({
      work,
      manager: join(copies, "manager"),
      archive: join(copies, "archive.tar.gz"),
      checksum: digest(archive),
      version: VERSION,
    });
    expect(
      readdirSync(work).filter((name) =>
        name.startsWith(".channel.uninstalled-")
      )
    ).toHaveLength(2);
    // And it fails when the installed candidate is not the version it gates.
    const wrongWork = join(root, "gate-wrong");
    mkdirSync(join(wrongWork, "candidate"), { mode: 0o700, recursive: true });
    copyFileSync(manager, join(wrongWork, "candidate/manager"));
    copyFileSync(archive, join(wrongWork, "candidate/archive.tar.gz"));
    expect(() =>
      freshChannelLeg({
        work: wrongWork,
        manager: join(wrongWork, "candidate/manager"),
        archive: join(wrongWork, "candidate/archive.tar.gz"),
        checksum: "0".repeat(64),
        version: VERSION,
      })
    ).toThrow(`Installing ${VERSION} into a fresh channel failed`);

    // The published-predecessor leg: a channel installed by the previous
    // release's manager takes the next candidate with the documented command.
    const NEXT = "5.0.0-next.24";
    const nextPlan = createPrereleasePlan({
      version: NEXT,
      sourceRevision: revision,
      ref: "refs/heads/next",
      eventName: "workflow_dispatch",
      channel: "prerelease",
    });
    const nextOutput = join(root, "out-next");
    await packageLinuxPrerelease({
      plan: nextPlan,
      bundle: await composeBundle(root, platform, { version: NEXT }),
      output: nextOutput,
      platform,
      buildManager: fixtureManager,
    });
    const nextArchive = join(nextOutput, bundleArchiveName(NEXT, platform));
    const legInputs = (name: string) => {
      const legWork = join(root, name);
      mkdirSync(join(legWork, "files"), { mode: 0o700, recursive: true });
      for (const [from, to] of [
        [manager, "previous-manager"],
        [manager, "candidate-manager"],
        [archive, "previous.tar.gz"],
        [nextArchive, "candidate.tar.gz"],
      ] as const) {
        copyFileSync(from, join(legWork, "files", to));
      }
      chmodSync(join(legWork, "files/previous-manager"), 0o700);
      return {
        work: legWork,
        previous: VERSION,
        previousManager: join(legWork, "files/previous-manager"),
        previousArchive: join(legWork, "files/previous.tar.gz"),
        previousSum: digest(archive),
        candidate: NEXT,
        candidateManager: join(legWork, "files/candidate-manager"),
        candidateArchive: join(legWork, "files/candidate.tar.gz"),
        unchanged: () => undefined,
        acceptManagerStep: false,
      };
    };
    const upgraded = legInputs("leg-ok");
    expect(upgradeLeg({ ...upgraded, candidateSum: digest(nextArchive) })).toBe(
      0
    );
    expect(readdirSync(join(upgraded.work, "channel/versions")).sort()).toEqual(
      [VERSION, NEXT]
    );
    // A candidate the retained manager cannot install fails the gate.
    expect(
      upgradeLeg({ ...legInputs("leg-bad"), candidateSum: "0".repeat(64) })
    ).toBe(1);

    // Uninstall moves the whole channel aside; nothing else under HOME changes.
    const removed = JSON.parse(
      run([launcher, "--manager", "uninstall", "--apply"]).stdout.toString()
    ) as { applied: boolean; to: string; manifest: string };
    expect(removed.applied).toBe(true);
    expect(readdirSync(home).sort()).toEqual(
      [removed.to, removed.manifest]
        .map((path) => path.split("/").at(-1) ?? "")
        .sort()
    );
    const restored = run([
      join(removed.to, "manager"),
      "--root",
      join(home, ".hack-next"),
      "uninstall",
      "--rollback-manifest",
      removed.manifest,
    ]);
    expect(restored.stderr.toString()).toBe("");
    expect(restored.exitCode).toBe(0);
    expect(run([launcher, "--version"]).stdout.toString()).toBe(
      `hack v${VERSION}\n`
    );
  },
  240_000
);

test("the compiled manager is built for the host platform, and only macOS is signed", async () => {
  const source = await Bun.file("scripts/build-prerelease-manager.ts").text();
  expect(source).toContain(
    '...(composeOnly(platform) ? [] : ["--target=bun-darwin-arm64"]),'
  );
  expect(source.indexOf("if (composeOnly(platform)) {")).toBeLessThan(
    source.indexOf('"/usr/bin/codesign", "--force"')
  );
  expect(source.indexOf("if (composeOnly(platform)) {")).toBeGreaterThan(
    source.indexOf("await chmod(target, 0o500);")
  );
});

test("the guides list the Linux platforms apart from the native platform and say what Linux installs", async () => {
  const guide = await Bun.file("docs/guides/prereleases.md").text();
  const lines = guide.split("\n");
  const start = lines.indexOf("### Compose-only Linux platforms");
  expect(start).toBeGreaterThan(lines.indexOf("### Supported platform"));
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("### ")
  );
  const documented = lines
    .slice(start, end)
    .flatMap((line) => /^- `([^`]+)`/.exec(line)?.slice(1) ?? []);
  expect(documented).toEqual([...PRERELEASE_LINUX_PLATFORMS]);
  for (const fact of [LINUX_SUMS, "hack-next-manager-linux-x86_64", "glibc"]) {
    expect(guide).toContain(fact);
  }
  for (const page of [
    "docs/versions/v5/install.md",
    "docs/guides/candidate-install.md",
  ]) {
    const text = (await Bun.file(page).text()).replaceAll("\n", " ");
    // The installer's closing line, word for word.
    expect(text).toContain(LINUX_INSTALLED_NOTE);
    expect(text).toContain("without `sudo`");
  }
});

// Native zsh does not split unquoted variables; the script must not need it.
test.skipIf(ZSH_SKIP !== null)(
  `the Linux installer runs under zsh without sh emulation${ZSH_SKIP === null ? "" : ` [skipped: ${ZSH_SKIP}]`}`,
  () => {
    const zsh = ZSH as string;
    const f = bootstrapFixture({ system: "Linux", machine: "x86_64" });
    // Checked again for this very fixture: without it the run is not hermetic.
    expect(shellMissesFixtureTools(zsh, f.env, f.bin)).toBeNull();
    const result = spawnSyncBounded([zsh, f.bootstrap], {
      env: f.env,
      timeout: 10_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(LINUX_INSTALLED_NOTE);
    // The fixture's curl made the one request, for the fixture's platform.
    expect(readFileSync(f.env.CURL_ARGS, "utf8")).toContain(
      `/v${VERSION}/hack-next-manager-linux-x86_64\n`
    );
  },
  30_000
);

test.skipIf(ZSH === null)(
  `a zsh whose startup files replace PATH is detected, so the zsh run is skipped there${ZSH === null ? " [skipped: no zsh on PATH]" : ""}`,
  () => {
    const zsh = ZSH as string;
    const f = bootstrapFixture({ system: "Linux", machine: "x86_64" });
    // What a system zshenv does on some machines, done here through the
    // fixture HOME's own .zshenv: put another directory first. That directory
    // holds decoys, so the result does not depend on where this host keeps
    // its real tools, and nothing real is run.
    const decoys = join(f.root, "decoys");
    mkdirSync(decoys, { mode: 0o700 });
    const called = join(f.root, "decoy-curl-called");
    writeFileSync(
      join(decoys, "uname"),
      '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n',
      { mode: 0o755 }
    );
    writeFileSync(
      join(decoys, "curl"),
      `#!/bin/sh\n: > '${called}'\nexit 7\n`,
      { mode: 0o755 }
    );
    writeFileSync(join(f.home, ".zshenv"), `export PATH='${decoys}':"$PATH"\n`);
    const reason = shellMissesFixtureTools(zsh, f.env, f.bin);
    expect(reason).toBe(
      `its startup files change PATH: uname and curl resolve to ${join(decoys, "uname")}, ${join(decoys, "curl")}, not the fixture's`
    );
    // Run that way, the installer uses the other curl, which is exactly why
    // the zsh run is skipped on such a host. Here it is a decoy that fails,
    // so the install stops unchanged.
    const result = spawnSyncBounded([zsh, f.bootstrap], {
      env: f.env,
      timeout: 20_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Manager download failed");
    expect(existsSync(called)).toBe(true);
    expect(existsSync(f.env.CURL_ARGS)).toBe(false);
    expect(existsSync(f.env.INVOCATION)).toBe(false);
    expect(existsSync(join(f.home, ".hack-next"))).toBe(false);
  },
  60_000
);

// The fixture's last line of defence, checked against the host's real curl
// with the installer's own protocol flags: it can only reach the discard port
// on this machine, so it fails without any outside connection.
const REAL_CURL = Bun.which("curl");
test.skipIf(REAL_CURL === null)(
  `a real curl with the fixture environment cannot leave this machine${REAL_CURL === null ? " [skipped: no curl on PATH]" : ""}`,
  () => {
    const root = scratch();
    const result = spawnSyncBounded(
      [
        REAL_CURL as string,
        "--proto",
        "=https",
        "--tlsv1.2",
        "--silent",
        "--show-error",
        "--fail",
        "--connect-timeout",
        "5",
        "--max-time",
        "10",
        "--output",
        join(root, "out"),
        // A reserved name that never resolves: a curl built without proxy
        // support would ignore the proxy, and even then connects nowhere.
        `https://github.invalid/hack-dance/hack/releases/download/v${VERSION}/hack-next-manager-linux-x86_64`,
      ],
      {
        env: { PATH: "/usr/bin:/bin", HOME: root, ...NO_NETWORK },
        timeout: 20_000,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    // 7: the discard port refused the connection. 28: something listens on
    // it and never answers. Either way the request went to this machine.
    expect([7, 28]).toContain(result.exitCode);
    expect(result.stderr.toString()).toMatch(/127\.0\.0\.1|timed out/i);
    expect(existsSync(join(root, "out"))).toBe(false);
  },
  30_000
);

// Independent of zsh: runs under /bin/sh wherever shasum exists.
const SHASUM_SKIP = Bun.which("shasum") === null ? "no shasum on PATH" : null;
test.skipIf(SHASUM_SKIP !== null)(
  `the macOS installer refuses --manager before any transfer${SHASUM_SKIP === null ? "" : ` [skipped: ${SHASUM_SKIP}]`}`,
  () => {
    const mac = bootstrapFixture({
      system: "Darwin",
      machine: "arm64",
      tools: ["shasum", "mktemp", "chmod", "rm", "cp", "cat", "date"],
    });
    writeFileSync(join(mac.bin, "codesign"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const refused = mac.run(["--manager", mac.manager]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain(
      "--manager is for Linux installs only."
    );
    expect(existsSync(mac.env.CURL_ARGS)).toBe(false);
    expect(existsSync(mac.env.INVOCATION)).toBe(false);
  },
  30_000
);

fixtureTest(
  "a takeover that works still fails the gate unless the manager step is accepted",
  () => {
    // Stand-in managers isolate the gate's own control flow: the previous
    // manager's channel refuses the documented upgrade until the candidate's
    // standalone manager has run upgrade-manager on it.
    const leg = (accept: boolean, takeoverWorks: boolean) => {
      const work = scratch();
      const previousManager = join(work, "previous-manager");
      writeFileSync(
        previousManager,
        `#!/bin/sh
# --root R install --version V --archive A --sha256 S
[ "$3" = install ] || exit 64
mkdir -p "$2/bin"
cat > "$2/bin/hack-next" <<'LAUNCHER'
#!/bin/sh
root=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd -P)
[ "$1" = --manager ] && [ "$2" = upgrade ] || exit 64
[ -f "$root/taken-over" ] || { echo "retained manager refuses this bundle" >&2; exit 1; }
: > "$root/upgraded"
LAUNCHER
chmod 755 "$2/bin/hack-next"
`,
        { mode: 0o700 }
      );
      const candidateManager = join(work, "candidate-manager");
      writeFileSync(
        candidateManager,
        `#!/bin/sh
[ "$3" = upgrade-manager ] || exit 64
${takeoverWorks ? ': > "$2/taken-over"' : 'echo "unknown predecessor" >&2; exit 1'}
`,
        { mode: 0o600 }
      );
      let checks = 0;
      const exit = upgradeLeg({
        work,
        previous: "5.0.0-next.23",
        previousManager,
        previousArchive: join(work, "previous.tar.gz"),
        previousSum: "a".repeat(64),
        candidate: "5.0.0-next.24",
        candidateManager,
        candidateArchive: join(work, "candidate.tar.gz"),
        candidateSum: "b".repeat(64),
        unchanged: () => {
          checks++;
        },
        acceptManagerStep: accept,
      });
      return {
        exit,
        checks,
        tookOver: existsSync(join(work, "channel/taken-over")),
        upgraded: existsSync(join(work, "channel/upgraded")),
      };
    };
    // Direct upgrade fails, upgrade-manager succeeds, the retry succeeds:
    // still a failure, because existing users would need the extra step.
    expect(leg(false, true)).toEqual({
      exit: 1,
      checks: 2,
      tookOver: true,
      upgraded: true,
    });
    // The same run passes only when the maintainer accepted that step.
    expect(leg(true, true)).toEqual({
      exit: 0,
      checks: 2,
      tookOver: true,
      upgraded: true,
    });
    // Acceptance does not rescue a takeover that does not work.
    expect(leg(true, false)).toEqual({
      exit: 1,
      checks: 2,
      tookOver: false,
      upgraded: false,
    });
  }
);
