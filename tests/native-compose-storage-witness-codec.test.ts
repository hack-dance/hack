import { expect, test } from "bun:test";
import {
  encodeNativeComposeStorageWitnessArchive,
  nativeComposeStorageWitnessMarkerValid,
  verifyNativeComposeStorageWitnessArchive,
} from "../src/lib/native-compose-storage-witness-codec.ts";

const marker = {
  name: `.hack-storage-${"a".repeat(64)}.witness`,
  token: "b".repeat(64),
};

function changedHeader(change: (bytes: Buffer) => void): Uint8Array {
  const bytes = Buffer.from(encodeNativeComposeStorageWitnessArchive(marker));
  change(bytes);
  bytes.fill(32, 148, 156);
  const checksum = bytes
    .subarray(0, 512)
    .reduce((sum, value) => sum + value, 0);
  bytes.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return bytes;
}

test("witness codec accepts exactly its random leaf and payload without extraction", () => {
  const archive = encodeNativeComposeStorageWitnessArchive(marker);
  expect(archive.byteLength).toBe(2048);
  expect(() =>
    verifyNativeComposeStorageWitnessArchive({ marker, archive })
  ).not.toThrow();
  expect(() =>
    verifyNativeComposeStorageWitnessArchive({
      marker: { ...marker, token: "c".repeat(64) },
      archive,
    })
  ).toThrow("values omitted");
  expect(() =>
    verifyNativeComposeStorageWitnessArchive({
      marker: { ...marker, name: `.hack-storage-${"c".repeat(64)}.witness` },
      archive,
    })
  ).toThrow("values omitted");
});

test.each([
  { name: "../private-canary", token: "b".repeat(64) },
  { name: marker.name, token: "private-canary" },
  { ...marker, extra: true },
  null,
])("untrusted marker names and tokens refuse without reflection", (value) => {
  expect(nativeComposeStorageWitnessMarkerValid(value)).toBe(false);
});

test.each([
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "x",
  "g",
  "L",
])("witness archive refuses type %s before exposing content", (type) => {
  const archive = changedHeader((bytes) => {
    bytes[156] = type.charCodeAt(0);
  });
  expect(() =>
    verifyNativeComposeStorageWitnessArchive({ marker, archive })
  ).toThrow("values omitted");
});

test.each([
  { change: (bytes: Buffer) => bytes.write("0000644\0", 100, "ascii") },
  { change: (bytes: Buffer) => bytes.write("other", 157, "ascii") },
  { change: (bytes: Buffer) => bytes.write("../private-canary", 345, "ascii") },
  { change: (bytes: Buffer) => bytes.write("\xff", 0, "latin1") },
  {
    change: (bytes: Buffer) => {
      bytes[600] = 1;
    },
  },
  {
    change: (bytes: Buffer) => {
      bytes[1800] = 1;
    },
  },
])("witness archive refuses unsafe fields, wrong contents and hidden members", ({
  change,
}) => {
  expect(() =>
    verifyNativeComposeStorageWitnessArchive({
      marker,
      archive: changedHeader(change),
    })
  ).toThrow("values omitted");
});

test.each([
  0, 512, 1536, 2049, 8704,
])("witness archive length %s fails its bounded exact-member contract", (length) => {
  expect(typeof length).toBe("number");
  expect(() =>
    verifyNativeComposeStorageWitnessArchive({
      marker,
      archive: new Uint8Array(length),
    })
  ).toThrow("values omitted");
});

test("witness archive checksum corruption and duplicate member both refuse", () => {
  const archive = Buffer.from(encodeNativeComposeStorageWitnessArchive(marker));
  archive[108] = 49;
  expect(() =>
    verifyNativeComposeStorageWitnessArchive({ marker, archive })
  ).toThrow("values omitted");
  const duplicate = Buffer.concat([
    Buffer.from(encodeNativeComposeStorageWitnessArchive(marker)).subarray(
      0,
      1024
    ),
    Buffer.from(encodeNativeComposeStorageWitnessArchive(marker)),
  ]);
  expect(() =>
    verifyNativeComposeStorageWitnessArchive({ marker, archive: duplicate })
  ).toThrow("values omitted");
});
