#!/usr/bin/env bun
import { chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  composeOnly,
  hostBundlePlatform,
  requireThat,
  UNSUPPORTED_HOST,
} from "./installer/integrity.ts";
/**
 * Build only: user machines receive a standalone executable, never a Bun installer.
 *
 * Builds for the host: Apple Silicon macOS gets the signed manager, glibc Linux
 * x86_64 or arm64 the unsigned one (`hack-next-manager-linux-*`). There is no
 * cross build, so each manager is built and run on its own platform.
 */
export async function buildPrereleaseManager(output: string) {
  const target = resolve(output);
  const platform = hostBundlePlatform();
  requireThat(
    platform,
    `No prerelease manager for this host. ${UNSUPPORTED_HOST}`
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      // Linux compiles with the running Bun's own runtime (its host target).
      ...(composeOnly(platform) ? [] : ["--target=bun-darwin-arm64"]),
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      resolve(import.meta.dir, "install-prerelease.ts"),
      "--outfile",
      target,
    ],
    {
      // Bun may create a transient .bun-build next to its working directory.
      // Keep compiler scratch with the owned output, never in the source checkout.
      cwd: dirname(target),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    }
  );
  requireThat(
    result.exitCode === 0,
    `Standalone manager build failed: ${result.stderr.toString()}`
  );
  await chmod(target, 0o500);
  if (composeOnly(platform)) {
    // Linux executables are not code signed; release checksums bind the bytes.
    return;
  }
  const signature = Bun.spawnSync(
    ["/usr/bin/codesign", "--force", "--sign", "-", target],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 30_000 }
  );
  requireThat(signature.exitCode === 0, "Cannot sign standalone manager.");
  const verified = Bun.spawnSync(
    ["/usr/bin/codesign", "--verify", "--strict", target],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 30_000 }
  );
  requireThat(
    verified.exitCode === 0,
    "Cannot verify standalone manager signature."
  );
}
if (import.meta.main) {
  const output = Bun.argv[2];
  requireThat(output, "Expected output executable path.");
  await buildPrereleaseManager(resolve(output));
}
