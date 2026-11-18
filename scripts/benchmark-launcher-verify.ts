#!/usr/bin/env bun
/**
 * Time what the `hack-next` channel manager does before it starts the CLI:
 * lock, validate every installed version, verify the selected version and
 * spawn it. The manager itself only runs on Apple Silicon macOS, but this
 * path is plain file hashing, so its cost can be measured on any host with
 * the same `Channel` class and a bundle of realistic size.
 *
 * Usage: bun scripts/benchmark-launcher-verify.ts --hack PATH [--runs N]
 *          [--installed N] [--native-mb N] [--manager-mb N]
 *   --hack        compiled CLI to place in the bundle as `hack-cli`
 *   --runs        launches to time per case (default 10)
 *   --installed   candidate versions installed in the channel (default 2:
 *                 the selected one and the previous one)
 *   --native-mb   size of the stand-in `hack-native` (default 20)
 *   --manager-mb  size of the stand-in manager executable (default 90; the
 *                 published darwin-arm64 manager for 5.0.0-next.20 is 89 MB)
 *
 * Not measured: `codesign --verify` (stubbed, macOS only), the manager's own
 * process start, and the shell launcher. The printed "manager overhead" is
 * therefore a lower bound for a real `hack-next` call. The results go to
 * stderr; the launched CLI's own output goes to stdout.
 *
 * Both sides of the comparison run the CLI with the environment the manager
 * gives it. To compare two revisions of `scripts/installer/channel.ts`, run
 * this script from a checkout of each with the same flags.
 *
 * Everything is created under one fresh directory in the OS temp directory
 * (about three times the bundle size at its peak) and removed on exit, on an
 * error and on SIGINT or SIGTERM.
 */
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Channel } from "./installer/channel.ts";
import { digest, jsonBytes } from "./installer/integrity.ts";

const { values: flags } = parseArgs({
  options: {
    hack: { type: "string" },
    runs: { type: "string", default: "10" },
    installed: { type: "string", default: "2" },
    "native-mb": { type: "string", default: "20" },
    "manager-mb": { type: "string", default: "90" },
  },
});

function positive(name: string, text: string): number {
  const value = Number(text);
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return value;
}

if (!flags.hack) {
  throw new Error("Pass --hack <compiled CLI>.");
}
const hack = resolve(flags.hack);
const runs = positive("runs", flags.runs);
const installed = positive("installed", flags.installed);
const nativeBytes = positive("native-mb", flags["native-mb"]) * 1024 * 1024;
const managerBytes = positive("manager-mb", flags["manager-mb"]) * 1024 * 1024;
statSync(hack);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Incompressible-looking filler, so the archive step does not skew sizes. */
function filler(bytes: number, seed: number): Buffer {
  const buffer = Buffer.allocUnsafe(bytes);
  let state = seed;
  for (let offset = 0; offset + 4 <= bytes; offset += 4) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    buffer.writeUInt32LE(state, offset);
  }
  return buffer;
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "hack-launcher-bench-")));
const previousBackend = process.env.HACK_RUNTIME_BACKEND;
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    rmSync(root, { recursive: true, force: true });
    process.exit(code);
  });
}
try {
  const repo = resolve(import.meta.dir, "..");
  const manager = join(root, "source-manager");
  writeFileSync(manager, filler(managerBytes, 7), { mode: 0o500 });
  const channel = new Channel(join(root, "channel"), manager, {
    signatures: () => {
      // codesign is macOS only; its cost is outside this measurement.
    },
    quiescence: () => {
      // No native runtime exists in this fixture.
    },
  });
  channel.initialize();
  channel.validate();

  let bundleBytes = 0;
  const versions = Array.from(
    { length: installed },
    (_, index) => `5.0.0-next.${index + 1}`
  );
  for (const [index, version] of versions.entries()) {
    const bundle = join(root, `bundle-${version}`);
    mkdirSync(bundle, { mode: 0o700 });
    copyFileSync(hack, join(bundle, "hack-cli"));
    copyFileSync(join(repo, "scripts/hack-v5.sh"), join(bundle, "hack-v5"));
    writeFileSync(join(bundle, "hack-native"), filler(nativeBytes, index + 1));
    writeFileSync(join(bundle, "hack-relay-guest"), "fixture-guest");
    writeFileSync(join(bundle, "provider-pins.json"), "{}\n");
    writeFileSync(join(bundle, "README.md"), "fixture\n");
    writeFileSync(
      join(bundle, "prerelease.json"),
      jsonBytes({
        schema: "hack.prerelease/v1",
        version,
        tag: `v${version}`,
        source_revision: "a".repeat(40),
        platform: "darwin-arm64",
      })
    );
    const names = [
      "hack-native",
      "hack-relay-guest",
      "hack-cli",
      "hack-v5",
      "provider-pins.json",
      "README.md",
      "prerelease.json",
    ];
    writeFileSync(
      join(bundle, "SHA256SUMS"),
      names.map((name) => `${digest(join(bundle, name))}  ${name}\n`).join("")
    );
    for (const name of [...names, "SHA256SUMS"]) {
      chmodSync(join(bundle, name), name.startsWith("hack-") ? 0o755 : 0o600);
    }
    bundleBytes = names.reduce(
      (sum, name) => sum + statSync(join(bundle, name)).size,
      0
    );
    const archive = join(root, `${version}.tar.gz`);
    const tar = Bun.spawnSync(
      [
        "/usr/bin/tar",
        "--format=ustar",
        "-czf",
        archive,
        "-C",
        bundle,
        ...names,
        "SHA256SUMS",
      ],
      { env: { ...process.env, COPYFILE_DISABLE: "1" }, timeout: 300_000 }
    );
    if (tar.exitCode !== 0) {
      throw new Error(`tar failed: ${tar.stderr.toString().slice(-300)}`);
    }
    await channel.install(version, archive, digest(archive), index > 0);
    rmSync(bundle, { recursive: true, force: true });
    rmSync(archive, { force: true });
  }
  const selected = versions.at(-1) as string;
  const cli = join(root, "channel/versions", selected, "bundle/hack-cli");

  // The Compose backend makes the manager start `hack-cli` itself, so the
  // launch is the CLI's own `--version` and nothing native is involved.
  process.env.HACK_RUNTIME_BACKEND = "compose";
  const direct: number[] = [];
  const managed: number[] = [];
  for (let index = -1; index < runs; index += 1) {
    let started = performance.now();
    const child = Bun.spawn([cli, "--version"], {
      env: channel.environment(selected, "compose"),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0) {
      throw new Error("Direct CLI run failed.");
    }
    const directMs = performance.now() - started;

    started = performance.now();
    const launch = new Channel(join(root, "channel"), manager, {
      signatures: () => {
        // See above: not measured.
      },
    });
    const release = launch.lock(true);
    let code: number;
    try {
      code = await launch.run(["--version"]);
    } finally {
      release();
    }
    if (code !== 0) {
      throw new Error(`Managed run exited ${code}.`);
    }
    const managedMs = performance.now() - started;
    // The first pass warms the page cache and is not recorded.
    if (index >= 0) {
      direct.push(directMs);
      managed.push(managedMs);
    }
  }
  const directMedian = median(direct);
  const managedMedian = median(managed);
  process.stderr.write(
    `${JSON.stringify(
      {
        installed_versions: installed,
        bundle_mb: Math.round(bundleBytes / 1024 / 1024),
        hack_cli_mb: Math.round(statSync(cli).size / 1024 / 1024),
        manager_mb: Math.round(managerBytes / 1024 / 1024),
        runs,
        direct_cli_median_ms: Math.round(directMedian),
        through_manager_median_ms: Math.round(managedMedian),
        manager_overhead_ms: Math.round(managedMedian - directMedian),
      },
      null,
      2
    )}\n`
  );
} finally {
  if (previousBackend === undefined) {
    Reflect.deleteProperty(process.env, "HACK_RUNTIME_BACKEND");
  } else {
    process.env.HACK_RUNTIME_BACKEND = previousBackend;
  }
  rmSync(root, { recursive: true, force: true });
}
