#!/usr/bin/env bun
import { chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { requireThat } from "./installer/integrity.ts";
/** Build only: user machines receive a standalone executable, never a Bun installer. */
export async function buildPrereleaseManager(output: string) {
  const target = resolve(output);
  requireThat(
    process.platform === "darwin" && process.arch === "arm64",
    "Build and sign the prerelease manager on Apple Silicon macOS."
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      "--target=bun-darwin-arm64",
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
