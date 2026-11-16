#!/usr/bin/env bun
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyConfigCompilerBuildPath } from "./build-config-compiler.ts";

/** Build the host sibling with locked dependencies and bounded Cargo parallelism. */
export async function buildLifecycleSupervisor(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const target = join(root, ".hack-local/lifecycle-supervisor-target");
  const output = join(root, "dist/hack-lifecycle-supervisor");
  for (const path of [
    join(root, ".hack-local"),
    target,
    join(root, "dist"),
    output,
  ]) {
    await verifyConfigCompilerBuildPath({ path });
  }
  const child = Bun.spawn(
    [
      "cargo",
      "+1.97.1",
      "build",
      "--locked",
      "--release",
      "--jobs",
      "2",
      "--manifest-path",
      "packages/lifecycle-supervisor/Cargo.toml",
      "--target-dir",
      target,
    ],
    {
      cwd: root,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      timeout: 300_000,
    }
  );
  if ((await child.exited) !== 0) {
    throw new Error("Lifecycle supervisor build failed.");
  }
  const binary = join(target, "release/hack-lifecycle-supervisor");
  await verifyConfigCompilerBuildPath({
    path: binary,
    allowCargoHardLink: true,
  });
  await mkdir(join(root, "dist"), { recursive: true });
  const stage = await mkdtemp(join(root, "dist/.lifecycle-supervisor-build-"));
  try {
    const staged = join(stage, "hack-lifecycle-supervisor");
    await copyFile(binary, staged);
    await chmod(staged, 0o755);
    if (process.platform === "darwin") {
      for (const args of [
        ["--force", "--sign", "-"],
        ["--verify", "--strict"],
      ]) {
        const signature = Bun.spawn(["/usr/bin/codesign", ...args, staged], {
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
          timeout: 30_000,
        });
        if ((await signature.exited) !== 0) {
          throw new Error(
            "Lifecycle supervisor signature verification failed."
          );
        }
      }
    }
    // A locally installed helper may still be supervising work. Replace its
    // directory entry instead of writing to that running executable's inode.
    await verifyConfigCompilerBuildPath({ path: output });
    await rename(staged, output);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await buildLifecycleSupervisor();
}
