import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const MAX_ARCHIVE = 512 * 1024 * 1024;
export const SHA256 = /^[0-9a-f]{64}$(?![\s\S])/;
export const VERSION = /^5\.0\.0-next\.([1-9][0-9]*)$(?![\s\S])/;
const CORE = [
  "hack-native",
  "hack-relay-guest",
  "hack-cli",
  "hack-v5",
  "provider-pins.json",
  "README.md",
  "prerelease.json",
];
const COMPILER = [
  "hack-config-compiler",
  "hack.project.schema.json",
  "hack.local.schema.json",
];
const STORAGE = ["hack-storage-root-witness", "native-storage-tool.json"];
export const MCP =
  /^mcp\/([0-9a-f]{64})\/(manifest\.json|hack-mcp-adapter|hack-mcp-owner|hack-mcp-backend)$(?![\s\S])/;
const EXECUTABLES = new Set([
  "hack-native",
  "hack-relay-guest",
  "hack-cli",
  "hack-v5",
  "hack-config-compiler",
]);

export function requireThat(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
export function object(value: unknown): Record<string, unknown> {
  requireThat(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "Expected a JSON object."
  );
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: string[]) {
  requireThat(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    "Unexpected JSON fields."
  );
}
/** JSON.parse validates syntax; a second structural pass refuses duplicate decoded keys. */
export function parseJson(raw: Uint8Array | string): Record<string, unknown> {
  const text =
    typeof raw === "string"
      ? raw
      : new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const parsed: unknown = JSON.parse(text);
  let position = 0;
  const whitespace = () => {
    while (/\s/.test(text[position] ?? "") && position < text.length) {
      position++;
    }
  };
  const string = () => {
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === "\\") {
        position++;
      } else if (char === '"') {
        return JSON.parse(text.slice(start, position)) as string;
      }
    }
    throw new Error("Malformed JSON string.");
  };
  const value = (depth: number): void => {
    requireThat(depth < 64, "JSON nesting exceeds budget.");
    whitespace();
    const char = text[position];
    if (char === '"') {
      string();
      return;
    }
    if (char === "{" || char === "[") {
      position++;
      const end = char === "{" ? "}" : "]";
      const keys = new Set<string>();
      whitespace();
      if (text[position] === end) {
        position++;
        return;
      }
      for (;;) {
        if (char === "{") {
          whitespace();
          const key = string();
          requireThat(!keys.has(key), "Duplicate JSON field.");
          keys.add(key);
          whitespace();
          position++;
        }
        value(depth + 1);
        whitespace();
        if (text[position++] === end) {
          return;
        }
      }
    }
    while (position < text.length && !/[\s,}\]]/.test(text[position] ?? "")) {
      position++;
    }
  };
  value(0);
  return object(parsed);
}
export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
export function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** Hash the opened descriptor with a fixed 1 MiB buffer, including a growth bound. */
export function digest(path: string, afterOpen?: (fd: number) => void): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    afterOpen?.(fd);
    const before = fstatSync(fd);
    requireThat(
      before.isFile() && before.size <= MAX_ARCHIVE,
      "Oversized or nonregular file."
    );
    const value = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (size === 0) {
        break;
      }
      total += size;
      requireThat(
        total <= MAX_ARCHIVE && total <= before.size,
        "File grew beyond its digest size budget."
      );
      value.update(buffer.subarray(0, size));
    }
    const after = fstatSync(fd);
    requireThat(
      total === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      "File changed during digest."
    );
    return value.digest("hex");
  } finally {
    closeSync(fd);
  }
}
/** One no-follow descriptor supplies the exact bounded compressed bytes we pin and parse.
 * A one-byte probe catches growth without allowing readFileSync to allocate past the bound.
 * afterOpen is an in-process fixture seam, never a runtime/environment bypass.
 */
export function readPinnedArchive(
  path: string,
  checksum: string,
  afterOpen?: (fd: number) => void
): Buffer {
  requireThat(SHA256.test(checksum), "Expected archive SHA-256 is required.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    afterOpen?.(fd);
    const before = fstatSync(fd);
    requireThat(
      before.isFile() &&
        before.uid === process.getuid?.() &&
        before.nlink === 1 &&
        before.size <= MAX_ARCHIVE,
      "Foreign, aliased or oversized archive descriptor."
    );
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        fd,
        bytes,
        offset,
        Math.min(1024 * 1024, bytes.length - offset),
        null
      );
      requireThat(count > 0, "Archive was truncated during read.");
      offset += count;
    }
    requireThat(
      readSync(fd, Buffer.alloc(1), 0, 1, null) === 0,
      "Archive grew during read."
    );
    const after = fstatSync(fd);
    requireThat(
      after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs &&
        hash(bytes) === checksum,
      "Archive checksum or size changed while reading pinned bytes."
    );
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function canonical(path: string): string {
  requireThat(
    isAbsolute(path) && resolve(path) === path,
    "Use a canonical absolute path without traversal."
  );
  let ancestor = path;
  while (true) {
    try {
      requireThat(
        realpathSync(ancestor) === ancestor,
        "Use a canonical path without symlinks."
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(ancestor);
      requireThat(parent !== ancestor, "Missing canonical parent.");
      ancestor = parent;
    }
  }
  return path;
}
export function owned(path: string, directory = false, mode?: number) {
  const info = lstatSync(path);
  // Receipts use JSON numbers. Refuse identities that JS could round into aliases.
  requireThat(
    Number.isSafeInteger(info.dev) && Number.isSafeInteger(info.ino),
    "Filesystem identity exceeds the receipt's exact integer range."
  );
  requireThat(
    (directory ? info.isDirectory() : info.isFile()) &&
      info.uid === process.getuid?.(),
    `Foreign or aliased path: ${path}`
  );
  requireThat(directory || info.nlink === 1, `Hard-linked file: ${path}`);
  requireThat(
    mode === undefined || (info.mode & 0o7777) === mode,
    `Unsafe mode: ${path}`
  );
  return info;
}
export function privateJson(path: string) {
  requireThat(
    owned(path, false, 0o600).size <= 1024 * 1024,
    "Oversized installation receipt."
  );
  return parseJson(readFileSync(path));
}
export function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function writeFile(path: string, bytes: Uint8Array, mode = 0o600) {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode
  );
  try {
    fchmodSync(fd, mode);
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function versionNumber(value: unknown): bigint {
  requireThat(
    typeof value === "string" && VERSION.test(value) && value.length <= 80,
    "Version must be 5.0.0-next.N (positive N, no leading zero)."
  );
  return BigInt(value.slice("5.0.0-next.".length));
}
export function metadata(raw: Uint8Array, version: string) {
  const value = parseJson(raw);
  exact(value, ["schema", "version", "tag", "source_revision", "platform"]);
  requireThat(
    value.schema === "hack.prerelease/v1" &&
      value.version === version &&
      value.tag === `v${version}` &&
      value.platform === "darwin-arm64" &&
      typeof value.source_revision === "string" &&
      /^[0-9a-f]{40}$(?![\s\S])/.test(value.source_revision),
    "Prerelease identity mismatch."
  );
  return value;
}
export function inventory(names: string[]): string[] {
  requireThat(
    new Set(names).size === names.length && names.length <= 64,
    "Duplicate or excessive payload inventory."
  );
  const required = [...CORE, "SHA256SUMS"];
  requireThat(
    required.every((name) => names.includes(name)),
    "Incomplete candidate bundle."
  );
  const compiler = COMPILER.filter((name) => names.includes(name));
  requireThat(
    compiler.length === 0 ||
      compiler.length === 3 ||
      (compiler.length === 2 && !compiler.includes("hack.local.schema.json")),
    "Incomplete config compiler payload."
  );
  requireThat(
    STORAGE.filter((name) => names.includes(name)).length % 2 === 0,
    "Incomplete storage tool payload."
  );
  const extras = names.filter(
    (name) => ![...required, ...COMPILER, ...STORAGE].includes(name)
  );
  if (extras.length) {
    const identity = MCP.exec(extras[0] ?? "")?.[1];
    requireThat(
      identity &&
        extras.length === 4 &&
        extras.every((name) => MCP.exec(name)?.[1] === identity),
      "Foreign or incomplete candidate MCP payload."
    );
  }
  return names.filter((name) => name !== "SHA256SUMS");
}
export function payloadMode(name: string): number {
  if (MCP.test(name)) {
    return name.endsWith("/manifest.json") ? 0o400 : 0o500;
  }
  if (name === STORAGE[0]) {
    return 0o500;
  }
  return EXECUTABLES.has(name) ? 0o755 : 0o600;
}
export function checksums(raw: Uint8Array, expected: string[]) {
  const text = new TextDecoder("ascii", { fatal: true }).decode(raw);
  const result: Record<string, string> = Object.create(null);
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9./-]+)$/.exec(line);
    requireThat(
      match &&
        expected.includes(match[2] ?? "") &&
        result[match[2] ?? ""] === undefined,
      "Malformed, duplicate or foreign checksum entry."
    );
    result[match[2] as string] = match[1] as string;
  }
  requireThat(
    Object.keys(result).length === expected.length,
    "Incomplete checksum manifest."
  );
  return result;
}

/** Accept only bounded ustar regular members. No extraction tool sees untrusted paths. */
export function archiveEntries(compressed: Uint8Array) {
  requireThat(compressed.length <= MAX_ARCHIVE, "Oversized archive.");
  const tar = gunzipSync(compressed, {
    maxOutputLength: MAX_ARCHIVE + 65 * 512 + 10_240,
  });
  const entries = new Map<string, Buffer>();
  let offset = 0;
  let total = 0;
  const field = (header: Buffer, start: number, size: number) => {
    const bytes = header.subarray(start, start + size);
    const zero = bytes.indexOf(0);
    requireThat(
      zero < 0 || bytes.subarray(zero).every((byte) => byte === 0),
      "Invalid tar string padding."
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(
      zero < 0 ? bytes : bytes.subarray(0, zero)
    );
  };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      requireThat(
        tar.length - offset >= 512 &&
          tar.subarray(offset).every((byte) => byte === 0),
        "Invalid tar terminator or trailing payload."
      );
      inventory([...entries.keys()]);
      return entries;
    }
    requireThat(entries.size < 64, "Too many archive entries.");
    const octal = (start: number, size: number) => {
      const text = header
        .subarray(start, start + size)
        .toString("ascii")
        .replace(/[\0 ]+$/, "")
        .trim();
      requireThat(/^[0-7]+$/.test(text), "Invalid tar numeric field.");
      return Number.parseInt(text, 8);
    };
    const sum = header.reduce(
      (value, byte, index) => value + (index >= 148 && index < 156 ? 32 : byte),
      0
    );
    requireThat(sum === octal(148, 8), "Invalid tar header checksum.");
    requireThat(
      field(header, 257, 6) === "ustar" &&
        (header[156] === 0 || header[156] === 48),
      "Only ustar regular archive files are accepted."
    );
    const prefix = field(header, 345, 155);
    const name = `${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`;
    requireThat(
      !entries.has(name) &&
        ([...CORE, ...COMPILER, ...STORAGE, "SHA256SUMS"].includes(name) ||
          MCP.test(name)),
      "Foreign, duplicate or traversing archive entry."
    );
    const size = octal(124, 12);
    total += size;
    requireThat(
      size > 0 && total <= MAX_ARCHIVE && offset + size <= tar.length,
      "Oversized or truncated archive."
    );
    entries.set(name, tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error("Truncated archive terminator.");
}
