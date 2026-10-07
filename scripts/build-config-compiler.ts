#!/usr/bin/env bun
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const GENERATED = ["hack.project.schema.json", "native-config.ts"] as const;

/** Build the pure host compiler; verify projections before publishing local output. */
export async function buildConfigCompiler(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const toolchain = Bun.spawn(["rustc", "--version"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const version = await new Response(toolchain.stdout).text();
  if ((await toolchain.exited) !== 0 || !version.startsWith("rustc 1.97.1 ")) {
    throw new Error(
      "Pinned Rust 1.97.1 is required to build the native configuration compiler."
    );
  }
  const target =
    process.env.HACK_CONFIG_COMPILER_TARGET_DIR ??
    join(root, ".hack-local/config-compiler-target");
  if (!isAbsolute(target)) {
    throw new Error("Compiler target directory must be absolute.");
  }
  const dist = join(root, "dist");
  const output = join(dist, "hack-config-compiler");
  for (const path of [join(root, ".hack-local"), target, dist, output]) {
    await verifyConfigCompilerBuildPath({ path });
  }
  await run(
    [
      "cargo",
      "build",
      "--locked",
      "--release",
      "--jobs",
      "2",
      "--manifest-path",
      "packages/config-compiler/Cargo.toml",
      "--target-dir",
      target,
    ],
    root
  );
  const binary = join(target, "release/hack-config-compiler");
  // Cargo can hard-link its Linux target executable to the deps artifact.
  // It is read-only input here; dist and shipped files must remain independent.
  await verifyConfigCompilerBuildPath({
    path: binary,
    allowCargoHardLink: true,
  });
  const generated = await mkdtemp(join(tmpdir(), "hack-config-projections-"));
  try {
    await run([binary, "generate", generated], root);
    for (const name of GENERATED) {
      await verifyConfigCompilerBuildPath({
        path: join(root, "packages/config-compiler/generated", name),
      });
      const [actual, expected] = await Promise.all([
        readFile(join(generated, name)),
        readFile(join(root, "packages/config-compiler/generated", name)),
      ]);
      if (!actual.equals(expected)) {
        throw new Error(
          `Generated native configuration projection is stale: ${name}`
        );
      }
    }
  } finally {
    await rm(generated, { recursive: true, force: true });
  }
  await mkdir(dist, { recursive: true });
  await copyFile(binary, output);
  await chmod(output, 0o755);
  process.stdout.write(
    "Built matching native configuration compiler: dist/hack-config-compiler\n"
  );
}

export async function verifyConfigCompilerBuildPath(opts: {
  readonly path: string;
  readonly allowCargoHardLink?: boolean;
}): Promise<void> {
  try {
    const info = await lstat(opts.path);
    if (
      info.isSymbolicLink() ||
      (info.isFile() && info.nlink !== 1 && !opts.allowCargoHardLink)
    ) {
      throw new Error("Refusing aliased configuration compiler build paths.");
    }
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function run(command: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  if ((await child.exited) !== 0) {
    throw new Error(
      "Native configuration compiler build or generation failed."
    );
  }
}

if (import.meta.main) {
  try {
    await buildConfigCompiler();
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Native configuration compiler build failed."}\n`
    );
    process.exitCode = 1;
  }
}
