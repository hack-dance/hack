#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..");
const vendorDir = path.join(repoRoot, "apps/macos/vendor/ghostty");
const bridgeDir = path.join(repoRoot, "apps/macos/Experiments/GhosttyVTBridge");
const outDir = path.join(repoRoot, "apps/macos/App/GhosttyVT/ghostty/lib");
const outLib = path.join(outDir, "libhack_ghostty_vt.dylib");

const zigVersion = (await $`zig version`.text()).trim();

type ZigVersion = Readonly<{
  major: number;
  minor: number;
  patch: number;
  isDev: boolean;
}>;

const parseVersion = (value: string): ZigVersion | null => {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  const [, major, minor, patch] = match;
  return {
    major: Number.parseInt(major ?? "0", 10),
    minor: Number.parseInt(minor ?? "0", 10),
    patch: Number.parseInt(patch ?? "0", 10),
    isDev: value.includes("dev"),
  };
};

const assertZigCompatible = ({
  current,
  min,
}: {
  current: ZigVersion;
  min: ZigVersion;
}): void => {
  const sameMajorMinor =
    current.major === min.major && current.minor === min.minor;
  const okPatch = current.patch >= min.patch || current.isDev;
  if (!(sameMajorMinor && okPatch)) {
    throw new Error(
      `Ghostty VT targets Zig ${min.major}.${min.minor}.x (min ${min.major}.${min.minor}.${min.patch}). Current: ${current.major}.${current.minor}.${current.patch}${current.isDev ? "-dev" : ""}.`
    );
  }
};

const ensureGhosttyPatched = (): void => {
  const libVtPath = path.join(vendorDir, "src/lib_vt.zig");
  let source = readFileSync(libVtPath, "utf8");

  const guard = 'if (@import("root") == lib) {';
  const patchedGuard =
    'if (@import("root") == lib and terminal.options.c_abi) {';
  if (source.includes(guard) && !source.includes(patchedGuard)) {
    source = source.replace(guard, patchedGuard);
  }

  if (source.includes("@export(&")) {
    source = source.replaceAll("@export(&", "@export(");
  }

  writeFileSync(libVtPath, source);
};

const main = async (): Promise<void> => {
  if (!existsSync(vendorDir)) {
    throw new Error(
      `Missing Ghostty vendor directory at ${vendorDir}. Run \`bun run macos:ghostty:setup\` once to fetch it.`
    );
  }

  const minVersionMatch = readFileSync(
    path.join(vendorDir, "build.zig.zon"),
    "utf8"
  ).match(/minimum_zig_version\\s*=\\s*"(\\d+\\.\\d+\\.\\d+)"/);
  const min = parseVersion(minVersionMatch?.[1] ?? "0.15.2") ?? {
    major: 0,
    minor: 15,
    patch: 2,
    isDev: false,
  };
  const current = parseVersion(zigVersion);
  if (!current) {
    throw new Error(`Unable to parse Zig version "${zigVersion}".`);
  }
  assertZigCompatible({ current, min });

  ensureGhosttyPatched();

  const armPrefix = path.join(repoRoot, ".tmp/ghosttyvt/arm64");
  const x64Prefix = path.join(repoRoot, ".tmp/ghosttyvt/x86_64");
  mkdirSync(armPrefix, { recursive: true });
  mkdirSync(x64Prefix, { recursive: true });

  await $`zig build -Dghostty=${vendorDir} -Doptimize=ReleaseSafe -Dtarget=aarch64-macos --prefix ${armPrefix}`.cwd(
    bridgeDir
  );
  await $`zig build -Dghostty=${vendorDir} -Doptimize=ReleaseSafe -Dtarget=x86_64-macos --prefix ${x64Prefix}`.cwd(
    bridgeDir
  );

  const armLib = path.join(armPrefix, "lib/libhack_ghostty_vt.dylib");
  const x64Lib = path.join(x64Prefix, "lib/libhack_ghostty_vt.dylib");
  if (!(existsSync(armLib) && existsSync(x64Lib))) {
    throw new Error(`Missing built dylib(s): ${armLib} / ${x64Lib}`);
  }

  mkdirSync(outDir, { recursive: true });
  await $`lipo -create ${armLib} ${x64Lib} -output ${outLib}`;
  await $`codesign --force --sign - ${outLib}`;
  await $`xattr -d com.apple.provenance ${outLib}`.quiet().nothrow();

  // eslint-disable-next-line no-console
  console.log(`Ghostty VT dylib staged for app bundle: ${outLib}`);
};

await main();
