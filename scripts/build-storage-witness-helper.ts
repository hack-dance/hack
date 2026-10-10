import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const INPUTS = [
  "package.json",
  "scripts/native-storage-witness-helper.ts",
  "src/lib/guards.ts",
  "src/lib/native-compose-storage-witness-xattr-codec.ts",
  "src/lib/native-compose-storage-witness-xattr-helper.ts",
  "src/lib/native-compose-storage-witness-xattr-linux.ts",
] as const;
const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Build an architecture-neutral candidate bundle and its source receipt. This
 * never executes the bundle, FFI, Docker or an image and never qualifies an ABI. */
export async function buildStorageWitnessHelper(opts: {
  readonly outputDirectory: string;
}): Promise<void> {
  const directory = opts.outputDirectory;
  if (!isAbsolute(directory) || Bun.version !== "1.4.2") {
    throw new Error(
      "Pinned Bun and an absolute exclusive output directory are required."
    );
  }
  const root = resolve(import.meta.dir, "..");
  const snapshot = async () =>
    await Promise.all(
      INPUTS.map(async (path) => {
        const absolute = join(root, path),
          before = await lstat(absolute);
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.nlink !== 1 ||
          before.size > 1024 * 1024
        ) {
          throw new Error("Helper source refused.");
        }
        const bytes = await readFile(absolute),
          after = await lstat(absolute);
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        ) {
          throw new Error("Helper source changed.");
        }
        return {
          path,
          sha256: hash(bytes),
          dev: before.dev,
          ino: before.ino,
          size: before.size,
        };
      })
    );
  const before = await snapshot();
  const packageJson: unknown = JSON.parse(
    await readFile(join(root, "package.json"), "utf8")
  );
  if (
    !(
      typeof packageJson === "object" &&
      packageJson !== null &&
      "packageManager" in packageJson &&
      packageJson.packageManager === "bun@1.4.2"
    )
  ) {
    throw new Error("Helper source Bun pin refused.");
  }
  await mkdir(directory, { mode: 0o700 });
  const payload = join(directory, "helper.mjs");
  const built = await Bun.build({
    entrypoints: [join(root, "scripts/native-storage-witness-helper.ts")],
    target: "bun",
    external: ["bun:ffi"],
    minify: false,
    sourcemap: "none",
  });
  const output = built.outputs[0];
  if (!built.success || built.outputs.length !== 1 || !output) {
    throw new Error("Helper candidate build refused.");
  }
  const bytes = new Uint8Array(await output.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 128 * 1024) {
    throw new Error("Helper candidate size refused.");
  }
  const after = await snapshot();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Helper source changed during build.");
  }
  const file = await open(payload, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(payload, 0o444);
  const receipt = await open(join(directory, "source.json"), "wx", 0o600);
  try {
    await receipt.writeFile(
      JSON.stringify(
        {
          version: 1,
          bunVersion: Bun.version,
          inputs: before,
          helperBytes: bytes.byteLength,
          helperSha256: hash(bytes),
          platforms: ["linux/amd64", "linux/arm64"],
          helperExecuted: false,
          ffiExecuted: false,
          engineQueried: false,
        },
        null,
        2
      )
    );
    await receipt.sync();
  } finally {
    await receipt.close();
  }
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory || process.argv.length !== 3) {
    throw new Error("One absolute exclusive output directory is required.");
  }
  await buildStorageWitnessHelper({ outputDirectory: directory });
}
