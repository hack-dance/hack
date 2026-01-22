#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..");
const vendorDir = path.join(repoRoot, "apps/macos/vendor/ghostty");
const bridgeDir = path.join(repoRoot, "apps/macos/Experiments/GhosttyVTBridge");
const installDir = path.join(
  process.env.HOME ?? "",
  "Library/Application Support/Hack/ghostty/lib"
);

const zigVersion = (await $`zig version`.text()).trim();
const parseVersion = (value: string) => {
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

const _isAtLeast = (
  current: { major: number; minor: number; patch: number },
  min: {
    major: number;
    minor: number;
    patch: number;
  }
) => {
  if (current.major !== min.major) {
    return current.major > min.major;
  }
  if (current.minor !== min.minor) {
    return current.minor > min.minor;
  }
  return current.patch >= min.patch;
};

if (existsSync(vendorDir)) {
  await $`git -C ${vendorDir} fetch --depth 1 origin main`;
  await $`git -C ${vendorDir} reset --hard origin/main`;
} else {
  await $`git clone --depth 1 https://github.com/ghostty-org/ghostty ${vendorDir}`;
}

const minVersionMatch = readFileSync(
  path.join(vendorDir, "build.zig.zon"),
  "utf8"
).match(/minimum_zig_version\\s*=\\s*"(\\d+\\.\\d+\\.\\d+)"/);
const minVersion = parseVersion(minVersionMatch?.[1] ?? "0.15.2") ?? {
  major: 0,
  minor: 15,
  patch: 2,
  isDev: false,
};

const parsedZigVersion = parseVersion(zigVersion);
if (!parsedZigVersion) {
  console.error(`Unable to parse Zig version "${zigVersion}".`);
  process.exit(1);
}

const supportsGhostty =
  parsedZigVersion.major === minVersion.major &&
  parsedZigVersion.minor === minVersion.minor &&
  (parsedZigVersion.patch >= minVersion.patch || parsedZigVersion.isDev);
if (!supportsGhostty) {
  console.error(
    `Ghostty VT currently targets Zig ${minVersion.major}.${minVersion.minor}.x (min ${minVersion.major}.${minVersion.minor}.${minVersion.patch}). Install Zig ${minVersion.major}.${minVersion.minor}.${minVersion.patch} (mise: "mise install zig@0.15.2") and retry.`
  );
  process.exit(1);
}

const libVtPath = path.join(vendorDir, "src/lib_vt.zig");
let libVtSource = readFileSync(libVtPath, "utf8");
const guard = 'if (@import("root") == lib) {';
const patchedGuard = 'if (@import("root") == lib and terminal.options.c_abi) {';
if (libVtSource.includes(guard) && !libVtSource.includes(patchedGuard)) {
  libVtSource = libVtSource.replace(guard, patchedGuard);
}
if (libVtSource.includes("@export(&")) {
  libVtSource = libVtSource.replaceAll("@export(&", "@export(");
}
writeFileSync(libVtPath, libVtSource);

await $`zig build -Dghostty=${vendorDir} -Doptimize=ReleaseSafe`.cwd(bridgeDir);

mkdirSync(installDir, { recursive: true });
const builtLib = path.join(bridgeDir, "zig-out/lib/libhack_ghostty_vt.dylib");
const targetLib = path.join(installDir, "libhack_ghostty_vt.dylib");
await $`cp ${builtLib} ${targetLib}`;
await $`codesign --force --sign - ${targetLib}`;
await $`xattr -d com.apple.provenance ${targetLib}`.quiet().nothrow();

console.log(`Ghostty VT library installed: ${targetLib}`);
