import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  archiveEntries,
  checksums,
  digest,
  exact,
  hash,
  inventory,
  MCP,
  metadata,
  object,
  owned,
  parseJson,
  payloadMode,
  readPinnedArchive,
  requireThat,
  SHA256,
  syncDirectory,
  writeFile,
} from "./integrity.ts";

export function bundleInventory(bundle: string) {
  const names = readdirSync(bundle);
  if (names.includes("mcp")) {
    owned(join(bundle, "mcp"), true, 0o700);
    const identities = readdirSync(join(bundle, "mcp"));
    const identity = identities[0];
    requireThat(
      identities.length === 1 && identity && SHA256.test(identity),
      "Candidate requires one MCP bundle identity."
    );
    owned(join(bundle, "mcp", identity), true, 0o700);
    names.splice(names.indexOf("mcp"), 1);
    names.push(
      ...readdirSync(join(bundle, "mcp", identity)).map(
        (name) => `mcp/${identity}/${name}`
      )
    );
  }
  return inventory(names);
}
export function verifyBundle(bundle: string, version: string) {
  owned(bundle, true, 0o700);
  const payload = bundleInventory(bundle);
  for (const name of [...payload, "SHA256SUMS"]) {
    owned(join(bundle, name), false, payloadMode(name));
  }
  for (const name of ["SHA256SUMS", "prerelease.json"]) {
    requireThat(
      owned(join(bundle, name)).size <= 64 * 1024,
      "Oversized bundle metadata."
    );
  }
  const manifest = checksums(readFileSync(join(bundle, "SHA256SUMS")), payload);
  for (const name of payload) {
    requireThat(
      digest(join(bundle, name)) === manifest[name],
      `Candidate checksum mismatch: ${name}`
    );
  }
  const identity = metadata(
    readFileSync(join(bundle, "prerelease.json")),
    version
  );
  if (payload.includes("hack-storage-root-witness")) {
    const path = join(bundle, "native-storage-tool.json");
    requireThat(owned(path).size <= 4096, "Oversized storage tool manifest.");
    const tool = parseJson(readFileSync(path));
    exact(tool, [
      "version",
      "kind",
      "platform",
      "architecture",
      "file",
      "sha256",
      "bytes",
      "sourceRevision",
    ]);
    requireThat(
      tool.version === 1 &&
        tool.kind === "native-storage-root-witness" &&
        tool.platform === "linux" &&
        tool.architecture === "arm64" &&
        tool.file === "hack-storage-root-witness" &&
        Number.isSafeInteger(tool.bytes) &&
        Number(tool.bytes) >= 64 &&
        Number(tool.bytes) <= 2 * 1024 * 1024 &&
        tool.bytes === owned(join(bundle, "hack-storage-root-witness")).size &&
        tool.sha256 === manifest["hack-storage-root-witness"] &&
        tool.sourceRevision === identity.source_revision,
      "Storage tool fingerprint or identity mismatch."
    );
  }
  const nested = payload.filter((name) => MCP.test(name)).sort();
  if (nested.length) {
    const prefix = nested[0]?.split("/").slice(0, 2).join("/") as string;
    const path = join(bundle, prefix, "manifest.json");
    requireThat(owned(path).size <= 8192, "Oversized MCP manifest.");
    const mcp = parseJson(readFileSync(path));
    exact(mcp, [
      "schemaVersion",
      "startupProtocol",
      "wireProtocol",
      "platform",
      "architecture",
      "files",
      "bundleId",
    ]);
    requireThat(
      mcp.schemaVersion === 1 &&
        mcp.startupProtocol === 2 &&
        mcp.wireProtocol === 1 &&
        mcp.platform === "darwin" &&
        mcp.architecture === "arm64",
      "Incompatible MCP protocol or host."
    );
    const files = object(mcp.files);
    exact(files, ["adapter", "owner", "backend"]);
    const canonicalFiles: Record<string, { sha256: unknown; bytes: unknown }> =
      {};
    for (const role of ["adapter", "owner", "backend"]) {
      const entry = object(files[role]);
      exact(entry, ["sha256", "bytes"]);
      const name = `${prefix}/hack-mcp-${role}`;
      requireThat(
        typeof entry.sha256 === "string" &&
          SHA256.test(entry.sha256) &&
          Number.isSafeInteger(entry.bytes) &&
          Number(entry.bytes) > 0 &&
          Number(entry.bytes) <= 256 * 1024 * 1024 &&
          entry.bytes === owned(join(bundle, name)).size &&
          entry.sha256 === manifest[name],
        "MCP asset fingerprint mismatch."
      );
      canonicalFiles[role] = { sha256: entry.sha256, bytes: entry.bytes };
    }
    const body = {
      schemaVersion: 1,
      startupProtocol: 2,
      wireProtocol: 1,
      platform: "darwin",
      architecture: "arm64",
      files: canonicalFiles,
    };
    const id = hash(Buffer.from(JSON.stringify(body)));
    requireThat(
      mcp.bundleId === id && prefix === `mcp/${id}`,
      "MCP bundle identity mismatch."
    );
  }
  return { identity, manifest };
}
/** Structural/ad-hoc signature integrity only, not Developer ID origin authentication.
 * Official HTTPS and pinned release/manager hashes carry the origin trust contract.
 */
export function verifySignatures(bundle: string) {
  const payload = bundleInventory(bundle);
  const names = [
    "hack-native",
    "hack-cli",
    ...payload.filter(
      (name) =>
        name === "hack-config-compiler" ||
        (MCP.test(name) && !name.endsWith("/manifest.json"))
    ),
  ];
  const result = Bun.spawnSync(
    [
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      ...names.map((name) => join(bundle, name)),
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 30_000 }
  );
  requireThat(
    result.exitCode === 0,
    "Candidate code signature failed or verification unavailable."
  );
}
export function extractArchive({
  archive,
  checksum,
  destination,
  version,
  releaseMetadata,
  signatures = verifySignatures,
  afterArchiveOpen,
}: {
  archive: string;
  checksum: string;
  destination: string;
  version: string;
  releaseMetadata?: Record<string, unknown>;
  signatures?: (bundle: string) => void;
  afterArchiveOpen?: (fd: number) => void;
}) {
  owned(archive);
  const entries = archiveEntries(
    readPinnedArchive(archive, checksum, afterArchiveOpen)
  );
  const payload = inventory([...entries.keys()]);
  const get = (name: string) => {
    const bytes = entries.get(name);
    requireThat(bytes, "Missing archive entry.");
    return bytes;
  };
  requireThat(
    get("prerelease.json").length <= 64 * 1024 &&
      get("SHA256SUMS").length <= 64 * 1024,
    "Oversized archive metadata."
  );
  const identity = metadata(get("prerelease.json"), version);
  requireThat(
    !releaseMetadata || sameJson(identity, releaseMetadata),
    "Archive metadata differs from the pinned release."
  );
  const manifest = checksums(get("SHA256SUMS"), payload);
  for (const name of payload) {
    requireThat(
      hash(get(name)) === manifest[name],
      `Candidate checksum mismatch: ${name}`
    );
  }
  mkdirSync(destination, { mode: 0o700 });
  const nested = payload.find((name) => MCP.test(name));
  if (nested) {
    mkdirSync(join(destination, "mcp"), { mode: 0o700 });
    mkdirSync(join(destination, ...nested.split("/").slice(0, 2)), {
      mode: 0o700,
    });
  }
  for (const [name, bytes] of entries) {
    writeFile(join(destination, name), bytes, payloadMode(name));
  }
  const verified = verifyBundle(destination, version);
  signatures(destination);
  for (const directory of nested
    ? [
        join(destination, ...nested.split("/").slice(0, 2)),
        join(destination, "mcp"),
      ]
    : []) {
    syncDirectory(directory);
  }
  syncDirectory(destination);
  return verified;
}
/** Compare parsed JSON without relying on untrusted object field order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  const left = Object.entries(a);
  const right = Object.entries(b);
  return (
    left.length === right.length &&
    left.every(
      ([key, value]) =>
        Object.hasOwn(b, key) &&
        sameJson(value, (b as Record<string, unknown>)[key])
    )
  );
}
