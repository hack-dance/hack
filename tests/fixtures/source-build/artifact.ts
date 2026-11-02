// Qualification fixture only: one graph-owned writer, read-only consumers, one bounded bundle.
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const MAX_BUNDLE = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
export const SOURCE_FILES = [
  "artifact.ts",
  "build.ts",
  "check.ts",
  "contract.json",
  "init.ts",
  "loader.ts",
  "marker.ts",
  "server.ts",
];

type Manifest = {
  schema: 1;
  inputId: string;
  bundleSha256: string;
  bytes: number;
};

export function digest(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function directory(path: string): Promise<void> {
  if (
    !(await lstat(path)).isDirectory() ||
    (await realpath(path)) !== resolve(path)
  ) {
    throw new Error("Artifact directory identity refused");
  }
}

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) {
      throw new Error("Artifact file type or size refused");
    }
    // One extra byte detects growth without reserving the full limit for tiny inputs.
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        null
      );
      if (!bytesRead) {
        break;
      }
      offset += bytesRead;
    }
    const after = await file.stat();
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("Artifact changed during read");
    }
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

export async function inputIdentity(source: string): Promise<string> {
  await directory(source);
  const inputs: [string, string][] = [];
  for (const name of SOURCE_FILES) {
    inputs.push([
      name,
      digest(await boundedFile(join(source, name), MAX_BUNDLE)),
    ]);
  }
  return digest(
    JSON.stringify({ schema: 1, bun: Bun.version, target: "bun", inputs })
  );
}

export async function verifyArtifact({
  root,
  inputId,
}: {
  root: string;
  inputId: string;
}): Promise<Manifest> {
  await directory(root);
  const complete = join(root, "build");
  await directory(complete);
  const names = await readdir(complete);
  if (
    names.sort().join(",") !== "manifest.json,web.js" ||
    !HASH.test(inputId)
  ) {
    throw new Error("Artifact inventory refused");
  }
  const value: unknown = JSON.parse(
    (await boundedFile(join(complete, "manifest.json"), 4096)).toString()
  );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Artifact manifest refused");
  }
  const manifest = value as Record<string, unknown>;
  if (
    Object.keys(manifest).sort().join(",") !==
      "bundleSha256,bytes,inputId,schema" ||
    manifest.schema !== 1 ||
    manifest.inputId !== inputId ||
    typeof manifest.bundleSha256 !== "string" ||
    !HASH.test(manifest.bundleSha256) ||
    typeof manifest.bytes !== "number" ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 ||
    manifest.bytes > MAX_BUNDLE
  ) {
    throw new Error("Artifact identity refused");
  }
  const bytes = await boundedFile(join(complete, "web.js"), MAX_BUNDLE);
  if (
    bytes.length !== manifest.bytes ||
    digest(bytes) !== manifest.bundleSha256
  ) {
    throw new Error("Artifact content refused");
  }
  return {
    schema: 1,
    inputId,
    bytes: bytes.length,
    bundleSha256: manifest.bundleSha256,
  };
}

async function writeDurable(
  path: string,
  bytes: Uint8Array | string
): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(path, 0o444);
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function buildArtifact({
  root,
  inputId,
  compile,
  fault = false,
}: {
  root: string;
  inputId: string;
  compile: () => Promise<Uint8Array>;
  fault?: boolean;
}): Promise<{ reused: boolean; manifest: Manifest }> {
  await directory(root);
  if (!HASH.test(inputId)) {
    throw new Error("Build input identity refused");
  }
  const entries = await readdir(root);
  if (entries.length === 1 && entries[0] === "build") {
    return { reused: true, manifest: await verifyArtifact({ root, inputId }) };
  }
  if (entries.length) {
    throw new Error("Pending or foreign output retained; build refused");
  }
  const pending = join(root, "pending");
  await mkdir(pending, { mode: 0o700 });
  const bundle = await compile();
  if (!bundle.length || bundle.length > MAX_BUNDLE) {
    throw new Error("Build output exceeds fixture limit");
  }
  const manifest: Manifest = {
    schema: 1,
    inputId,
    bundleSha256: digest(bundle),
    bytes: bundle.length,
  };
  await writeDurable(join(pending, "web.js"), bundle);
  if (fault) {
    throw new Error("Injected interruption before manifest publication");
  }
  await writeDurable(join(pending, "manifest.json"), JSON.stringify(manifest));
  await syncDirectory(pending);
  await rename(pending, join(root, "build"));
  await chmod(join(root, "build"), 0o555);
  await syncDirectory(root);
  return { reused: false, manifest: await verifyArtifact({ root, inputId }) };
}
