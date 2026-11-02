import { randomBytes, timingSafeEqual } from "node:crypto";
import { isRecord } from "./guards.ts";

/** Distinct from the regular-file/USTAR carrier; never reinterpret one as the other. */
export const NATIVE_STORAGE_XATTR_KIND = "directory-xattr" as const;
export const NATIVE_STORAGE_XATTR_VERSION = 1 as const;
export const NATIVE_STORAGE_XATTR_BYTES = 32;
export const NATIVE_STORAGE_XATTR_INPUT_LIMIT = 4096;
export const NATIVE_STORAGE_XATTR_OUTPUT_LIMIT = 1024;
const NAME = /^user\.hack\.storage\.[a-f0-9]{64}$/;
const VALUE = /^[a-f0-9]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const UINT32_MAX = 4_294_967_295;

export type NativeComposeStorageXattrRoot = {
  readonly device: string;
  readonly inode: string;
  readonly uid: number;
  readonly gid: number;
};
export type NativeComposeStorageXattrMarker = {
  readonly kind: typeof NATIVE_STORAGE_XATTR_KIND;
  readonly version: typeof NATIVE_STORAGE_XATTR_VERSION;
  readonly name: string;
  readonly valueHex: string;
};
export type NativeComposeStorageXattrRequest =
  | {
      readonly kind: typeof NATIVE_STORAGE_XATTR_KIND;
      readonly version: typeof NATIVE_STORAGE_XATTR_VERSION;
      readonly operation: "root";
    }
  | (NativeComposeStorageXattrMarker & {
      readonly operation: "seed" | "verify";
      readonly root: NativeComposeStorageXattrRoot;
    });
export type NativeComposeStorageXattrResponse =
  | {
      readonly kind: typeof NATIVE_STORAGE_XATTR_KIND;
      readonly version: typeof NATIVE_STORAGE_XATTR_VERSION;
      readonly outcome: "refused";
    }
  | {
      readonly kind: typeof NATIVE_STORAGE_XATTR_KIND;
      readonly version: typeof NATIVE_STORAGE_XATTR_VERSION;
      readonly outcome: "root" | "seeded";
      readonly root: NativeComposeStorageXattrRoot;
    }
  | {
      readonly kind: typeof NATIVE_STORAGE_XATTR_KIND;
      readonly version: typeof NATIVE_STORAGE_XATTR_VERSION;
      readonly outcome: "verified";
      readonly root: NativeComposeStorageXattrRoot;
      readonly valueHex: string;
    };

export function refuseNativeComposeStorageXattr(): never {
  throw new Error("Native storage xattr proof refused; values omitted.");
}
function keys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(",") === expected;
}
function uint32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Object.is(value, -0) &&
    value >= 0 &&
    value <= UINT32_MAX
  );
}
function uint64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    DECIMAL.test(value) &&
    BigInt(value) <= UINT64_MAX
  );
}
export function nativeComposeStorageXattrRootValid(
  value: unknown
): value is NativeComposeStorageXattrRoot {
  return (
    isRecord(value) &&
    keys(value, "device,gid,inode,uid") &&
    uint64(value.device) &&
    uint64(value.inode) &&
    value.inode !== "0" &&
    uint32(value.uid) &&
    uint32(value.gid)
  );
}
export function sameNativeComposeStorageXattrRoot(
  left: NativeComposeStorageXattrRoot,
  right: NativeComposeStorageXattrRoot
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}
function markerValid(
  value: Record<string, unknown>
): value is Record<string, unknown> & NativeComposeStorageXattrMarker {
  return (
    value.kind === NATIVE_STORAGE_XATTR_KIND &&
    value.version === NATIVE_STORAGE_XATTR_VERSION &&
    typeof value.name === "string" &&
    NAME.test(value.name) &&
    typeof value.valueHex === "string" &&
    VALUE.test(value.valueHex)
  );
}
export function createNativeComposeStorageXattrMarker(): NativeComposeStorageXattrMarker {
  return Object.freeze({
    kind: NATIVE_STORAGE_XATTR_KIND,
    version: NATIVE_STORAGE_XATTR_VERSION,
    name: `user.hack.storage.${randomBytes(32).toString("hex")}`,
    valueHex: randomBytes(NATIVE_STORAGE_XATTR_BYTES).toString("hex"),
  });
}
export function decodeNativeComposeStorageXattrRequest(
  value: unknown
): NativeComposeStorageXattrRequest {
  if (!isRecord(value)) {
    return refuseNativeComposeStorageXattr();
  }
  if (
    keys(value, "kind,operation,version") &&
    value.kind === NATIVE_STORAGE_XATTR_KIND &&
    value.version === NATIVE_STORAGE_XATTR_VERSION &&
    value.operation === "root"
  ) {
    return Object.freeze({
      kind: NATIVE_STORAGE_XATTR_KIND,
      version: NATIVE_STORAGE_XATTR_VERSION,
      operation: "root",
    });
  }
  if (
    !(
      keys(value, "kind,name,operation,root,valueHex,version") &&
      markerValid(value) &&
      (value.operation === "seed" || value.operation === "verify") &&
      nativeComposeStorageXattrRootValid(value.root)
    )
  ) {
    return refuseNativeComposeStorageXattr();
  }
  return Object.freeze({
    kind: NATIVE_STORAGE_XATTR_KIND,
    version: NATIVE_STORAGE_XATTR_VERSION,
    operation: value.operation,
    name: value.name,
    valueHex: value.valueHex,
    root: Object.freeze({ ...value.root }),
  });
}
export function decodeNativeComposeStorageXattrResponse(
  value: unknown
): NativeComposeStorageXattrResponse {
  if (
    !(
      isRecord(value) &&
      value.kind === NATIVE_STORAGE_XATTR_KIND &&
      value.version === NATIVE_STORAGE_XATTR_VERSION
    )
  ) {
    return refuseNativeComposeStorageXattr();
  }
  if (value.outcome === "refused" && keys(value, "kind,outcome,version")) {
    return Object.freeze({
      kind: NATIVE_STORAGE_XATTR_KIND,
      version: NATIVE_STORAGE_XATTR_VERSION,
      outcome: "refused",
    });
  }
  if (!nativeComposeStorageXattrRootValid(value.root)) {
    return refuseNativeComposeStorageXattr();
  }
  const root = Object.freeze({ ...value.root });
  if (
    (value.outcome === "root" || value.outcome === "seeded") &&
    keys(value, "kind,outcome,root,version")
  ) {
    return Object.freeze({
      kind: NATIVE_STORAGE_XATTR_KIND,
      version: NATIVE_STORAGE_XATTR_VERSION,
      outcome: value.outcome,
      root,
    });
  }
  if (
    value.outcome === "verified" &&
    keys(value, "kind,outcome,root,valueHex,version") &&
    typeof value.valueHex === "string" &&
    VALUE.test(value.valueHex)
  ) {
    return Object.freeze({
      kind: NATIVE_STORAGE_XATTR_KIND,
      version: NATIVE_STORAGE_XATTR_VERSION,
      outcome: "verified",
      root,
      valueHex: value.valueHex,
    });
  }
  return refuseNativeComposeStorageXattr();
}
export function encodeNativeComposeStorageXattrRequest(
  value: NativeComposeStorageXattrRequest
): string {
  return `${JSON.stringify(decodeNativeComposeStorageXattrRequest(value))}\n`;
}
export function encodeNativeComposeStorageXattrResponse(
  value: NativeComposeStorageXattrResponse
): string {
  return `${JSON.stringify(decodeNativeComposeStorageXattrResponse(value))}\n`;
}
function parse<T>(
  text: string,
  limit: number,
  decode: (value: unknown) => T
): T {
  if (Buffer.byteLength(text) > limit) {
    return refuseNativeComposeStorageXattr();
  }
  try {
    const value = decode(JSON.parse(text));
    // One canonical member rejects duplicate keys, suffixes and alternate encodings.
    if (text !== `${JSON.stringify(value)}\n`) {
      return refuseNativeComposeStorageXattr();
    }
    return value;
  } catch {
    return refuseNativeComposeStorageXattr();
  }
}
export function parseNativeComposeStorageXattrRequest(
  text: string
): NativeComposeStorageXattrRequest {
  return parse(
    text,
    NATIVE_STORAGE_XATTR_INPUT_LIMIT,
    decodeNativeComposeStorageXattrRequest
  );
}
export function parseNativeComposeStorageXattrResponse(
  text: string
): NativeComposeStorageXattrResponse {
  return parse(
    text,
    NATIVE_STORAGE_XATTR_OUTPUT_LIMIT,
    decodeNativeComposeStorageXattrResponse
  );
}
export function nativeComposeStorageXattrValueMatches(
  actual: Uint8Array,
  expectedHex: string
): boolean {
  return (
    actual.byteLength === NATIVE_STORAGE_XATTR_BYTES &&
    VALUE.test(expectedHex) &&
    timingSafeEqual(actual, Buffer.from(expectedHex, "hex"))
  );
}
