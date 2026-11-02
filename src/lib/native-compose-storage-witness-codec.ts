import { timingSafeEqual } from "node:crypto";
import { isRecord } from "./guards.ts";

const MARKER = /^\.hack-storage-[a-f0-9]{64}\.witness$/;
const TOKEN = /^[a-f0-9]{64}$/;
const BLOCK = 512;
const ARCHIVE_LIMIT = 8192;
const CONTENT_PREFIX = "hack-native-storage-witness-v1\n";

/** A private random leaf and token; never include either in public reports or argv. */
export type NativeComposeStorageWitnessMarker = {
  readonly name: string;
  readonly token: string;
};

export function refuseNativeComposeStorageWitness(): never {
  throw new Error(
    "Native storage witness is missing, unsafe or changed; values omitted. No storage repair was attempted."
  );
}

export function nativeComposeStorageWitnessMarkerValid(
  value: unknown
): value is NativeComposeStorageWitnessMarker {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join() === "name,token" &&
    typeof value.name === "string" &&
    MARKER.test(value.name) &&
    typeof value.token === "string" &&
    TOKEN.test(value.token)
  );
}

function content(marker: NativeComposeStorageWitnessMarker): Buffer {
  if (!nativeComposeStorageWitnessMarkerValid(marker)) {
    return refuseNativeComposeStorageWitness();
  }
  return Buffer.from(`${CONTENT_PREFIX}${marker.token}\n`);
}

function writeOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number
) {
  header.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii"
  );
}

/** A single regular USTAR member. The transport must create exclusively, never extract over an existing path. */
export function encodeNativeComposeStorageWitnessArchive(
  marker: NativeComposeStorageWitnessMarker
): Uint8Array {
  const bytes = content(marker);
  const archive = Buffer.alloc(BLOCK * 4);
  const header = archive.subarray(0, BLOCK);
  header.write(marker.name, 0, "ascii");
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes.length);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  bytes.copy(archive, BLOCK);
  return archive;
}

function field(header: Buffer, offset: number, length: number): string {
  const bytes = header.subarray(offset, offset + length);
  const nul = bytes.indexOf(0);
  if (nul !== -1 && bytes.subarray(nul).some((value) => value !== 0)) {
    return refuseNativeComposeStorageWitness();
  }
  const used = nul === -1 ? bytes : bytes.subarray(0, nul);
  if (used.some((value) => value > 127)) {
    return refuseNativeComposeStorageWitness();
  }
  return used.toString("ascii");
}

function octal(header: Buffer, offset: number, length: number): number {
  const bytes = header.subarray(offset, offset + length);
  const nul = bytes.indexOf(0);
  let end = nul === -1 ? bytes.length : nul;
  if (nul !== -1 && bytes.subarray(nul + 1).some((byte) => byte !== 32)) {
    return refuseNativeComposeStorageWitness();
  }
  if (nul === -1) {
    while (end > 0 && bytes[end - 1] === 32) {
      end--;
    }
  }
  if (end === 0) {
    return refuseNativeComposeStorageWitness();
  }
  let value = 0;
  for (const byte of bytes.subarray(0, end)) {
    if (byte < 48 || byte > 55) {
      return refuseNativeComposeStorageWitness();
    }
    value = value * 8 + byte - 48;
  }
  if (!Number.isSafeInteger(value)) {
    return refuseNativeComposeStorageWitness();
  }
  return value;
}

/**
 * Decode nothing onto the host. Accept one bounded regular member with the exact
 * random name, permissions and contents. Links, special files, PAX/GNU extensions,
 * extra members and nonzero padding refuse. This is content continuity, not a
 * daemon-provided nlink check or protection against copying an entire witness.
 */
export function verifyNativeComposeStorageWitnessArchive(opts: {
  readonly marker: NativeComposeStorageWitnessMarker;
  readonly archive: Uint8Array;
}): void {
  const expected = content(opts.marker);
  if (
    opts.archive.byteLength < BLOCK * 4 ||
    opts.archive.byteLength > ARCHIVE_LIMIT ||
    opts.archive.byteLength % BLOCK !== 0
  ) {
    refuseNativeComposeStorageWitness();
  }
  const archive = Buffer.from(opts.archive);
  const header = archive.subarray(0, BLOCK);
  const checksum = header.reduce(
    (sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value),
    0
  );
  if (
    field(header, 0, 100) !== opts.marker.name ||
    octal(header, 100, 8) !== 0o600 ||
    octal(header, 124, 12) !== expected.length ||
    octal(header, 148, 8) !== checksum ||
    ![0, 48].includes(header[156] ?? -1) ||
    field(header, 157, 100) !== "" ||
    field(header, 257, 6) !== "ustar" ||
    field(header, 263, 2) !== "00" ||
    field(header, 345, 155) !== "" ||
    !timingSafeEqual(
      archive.subarray(BLOCK, BLOCK + expected.length),
      expected
    ) ||
    archive.subarray(BLOCK + expected.length).some((value) => value !== 0)
  ) {
    refuseNativeComposeStorageWitness();
  }
}
