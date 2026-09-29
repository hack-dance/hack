import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isRecord } from "../lib/guards.ts";
import type { NativeRuntimeSelection } from "./native-runtime-client.ts";

const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const BOOT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const NATIVE_HTTPS_OWNER_FRAME_LIMIT = 8192;
export const NATIVE_HTTPS_OWNER_ARGUMENT = "--internal-native-https-owner";

export interface NativeHttpsLeaseRequest {
  readonly run: string;
  readonly attempt: string;
  readonly namespace: string;
  readonly planId: string;
}
/** Persist this exact identity with frontend finalization, never just a PID. */
export interface NativeHttpsLeaseIdentity extends NativeHttpsLeaseRequest {
  readonly version: 1;
  readonly ownerGeneration: string;
  readonly leaseId: string;
  readonly owner: string;
}
export interface NativeHttpsOwnerBinding {
  readonly runtime: NativeRuntimeSelection;
  readonly frontend: { readonly binary: string; readonly sha256: string };
  readonly runtimeSha256: string;
  readonly pool: { readonly owner: string; readonly bootId: string };
  readonly caddyBinary: string;
  readonly caddySha256: string;
  readonly httpsPort: number;
  readonly certificateNameLimit: number;
}
export interface NativeHttpsOwnerConfiguration {
  readonly version: 1;
  readonly ownerGeneration: string;
  readonly binding: NativeHttpsOwnerBinding;
}
export interface NativeHttpsOwnerEndpoint {
  readonly version: 1;
  readonly ownerGeneration: string;
  readonly socket: string;
  readonly dev: number;
  readonly ino: number;
}
export interface NativeHttpsLeaseRelease {
  readonly version: 1;
  readonly identity: NativeHttpsLeaseIdentity;
  readonly binding: NativeHttpsOwnerBinding;
  readonly finalOwner: boolean;
}
/** A per-attempt address is known before delivery; it is not proof of admission. */
export function nativeHttpsLeaseIdentity(
  configuration: NativeHttpsOwnerConfiguration,
  lease: NativeHttpsLeaseRequest
): NativeHttpsLeaseIdentity {
  const { ownerGeneration, binding } = configuration;
  const leaseId = createHash("sha256")
    .update(
      JSON.stringify([
        "native-https-lease-v1",
        ownerGeneration,
        binding.pool.owner,
        lease.run,
        lease.attempt,
        lease.namespace,
        lease.planId,
      ])
    )
    .digest("hex")
    .slice(0, 32);
  return {
    version: 1,
    ownerGeneration,
    leaseId,
    owner: binding.pool.owner,
    run: lease.run,
    attempt: lease.attempt,
    namespace: lease.namespace,
    planId: lease.planId,
  };
}
export function sameNativeHttpsLease(
  a: NativeHttpsLeaseIdentity,
  b: NativeHttpsLeaseIdentity
): boolean {
  return (
    a.ownerGeneration === b.ownerGeneration &&
    a.leaseId === b.leaseId &&
    a.owner === b.owner &&
    a.run === b.run &&
    a.attempt === b.attempt &&
    a.namespace === b.namespace &&
    a.planId === b.planId
  );
}
export function isNativeHttpsLeaseRelease(
  value: unknown
): value is NativeHttpsLeaseRelease {
  return (
    isRecord(value) &&
    keys(value, "binding,finalOwner,identity,version") &&
    value.version === 1 &&
    typeof value.finalOwner === "boolean" &&
    isNativeHttpsLeaseIdentity(value.identity) &&
    isNativeHttpsOwnerConfiguration({
      version: 1,
      ownerGeneration: value.identity.ownerGeneration,
      binding: value.binding,
    }) &&
    isRecord(value.binding) &&
    isRecord(value.binding.pool) &&
    value.binding.pool.owner === value.identity.owner
  );
}
export type NativeHttpsOwnerRequest =
  | {
      readonly version: 1;
      readonly operation: "acquire";
      readonly ownerGeneration: string;
      readonly lease: NativeHttpsLeaseRequest;
    }
  | {
      readonly version: 1;
      readonly operation: "release";
      readonly identity: NativeHttpsLeaseIdentity;
    };

export function nativeHttpsOwnerRefused(): Error {
  return new Error(
    "Shared native HTTPS ownership is unavailable or unconfirmed; retained ownership was not adopted or replaced."
  );
}
function keys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(",") === expected;
}
export function isNativeHttpsLeaseRequest(
  value: unknown
): value is NativeHttpsLeaseRequest {
  return (
    isRecord(value) &&
    keys(value, "attempt,namespace,planId,run") &&
    [value.run, value.attempt].every(
      (v) => typeof v === "string" && HEX32.test(v)
    ) &&
    [value.namespace, value.planId].every(
      (v) => typeof v === "string" && HEX64.test(v)
    )
  );
}
export function isNativeHttpsLeaseIdentity(
  value: unknown
): value is NativeHttpsLeaseIdentity {
  return (
    isRecord(value) &&
    keys(
      value,
      "attempt,leaseId,namespace,owner,ownerGeneration,planId,run,version"
    ) &&
    value.version === 1 &&
    [value.ownerGeneration, value.leaseId, value.owner].every(
      (v) => typeof v === "string" && HEX32.test(v)
    ) &&
    isNativeHttpsLeaseRequest({
      run: value.run,
      attempt: value.attempt,
      namespace: value.namespace,
      planId: value.planId,
    })
  );
}
export function isNativeHttpsOwnerConfiguration(
  value: unknown
): value is NativeHttpsOwnerConfiguration {
  if (
    !(
      isRecord(value) &&
      keys(value, "binding,ownerGeneration,version") &&
      value.version === 1 &&
      typeof value.ownerGeneration === "string" &&
      HEX32.test(value.ownerGeneration) &&
      isRecord(value.binding)
    )
  ) {
    return false;
  }
  const b = value.binding;
  return (
    keys(
      b,
      "caddyBinary,caddySha256,certificateNameLimit,frontend,httpsPort,pool,runtime,runtimeSha256"
    ) &&
    isRecord(b.runtime) &&
    keys(b.runtime, "binary,home") &&
    isRecord(b.frontend) &&
    keys(b.frontend, "binary,sha256") &&
    isRecord(b.pool) &&
    keys(b.pool, "bootId,owner") &&
    [b.runtime.binary, b.runtime.home, b.frontend.binary, b.caddyBinary].every(
      (v) => typeof v === "string" && v.length < 4096 && isAbsolute(v)
    ) &&
    [b.runtimeSha256, b.frontend.sha256, b.caddySha256].every(
      (v) => typeof v === "string" && HEX64.test(v)
    ) &&
    typeof b.pool.owner === "string" &&
    HEX32.test(b.pool.owner) &&
    typeof b.pool.bootId === "string" &&
    BOOT.test(b.pool.bootId) &&
    typeof b.httpsPort === "number" &&
    Number.isSafeInteger(b.httpsPort) &&
    b.httpsPort > 0 &&
    b.httpsPort <= 65_535 &&
    typeof b.certificateNameLimit === "number" &&
    Number.isSafeInteger(b.certificateNameLimit) &&
    b.certificateNameLimit > 0 &&
    b.certificateNameLimit <= 4096
  );
}
export function isNativeHttpsOwnerEndpoint(
  value: unknown
): value is NativeHttpsOwnerEndpoint {
  return (
    isRecord(value) &&
    keys(value, "dev,ino,ownerGeneration,socket,version") &&
    value.version === 1 &&
    typeof value.ownerGeneration === "string" &&
    HEX32.test(value.ownerGeneration) &&
    typeof value.socket === "string" &&
    isAbsolute(value.socket) &&
    Buffer.byteLength(value.socket) < 100 &&
    [value.dev, value.ino].every(
      (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    )
  );
}
export function parseNativeHttpsOwnerRequest(
  value: unknown
): NativeHttpsOwnerRequest {
  if (isRecord(value) && value.version === 1) {
    if (
      keys(value, "lease,operation,ownerGeneration,version") &&
      value.operation === "acquire" &&
      typeof value.ownerGeneration === "string" &&
      HEX32.test(value.ownerGeneration) &&
      isNativeHttpsLeaseRequest(value.lease)
    ) {
      return {
        version: 1,
        operation: "acquire",
        ownerGeneration: value.ownerGeneration,
        lease: value.lease,
      };
    }
    if (
      keys(value, "identity,operation,version") &&
      value.operation === "release" &&
      isNativeHttpsLeaseIdentity(value.identity)
    ) {
      return { version: 1, operation: "release", identity: value.identity };
    }
  }
  throw nativeHttpsOwnerRefused();
}
/** One bounded newline frame; pipelining and trailing bytes are refused. */
export function decodeNativeHttpsOwnerFrame(bytes: Buffer): unknown {
  if (
    bytes.length > NATIVE_HTTPS_OWNER_FRAME_LIMIT ||
    bytes.at(-1) !== 10 ||
    bytes.indexOf(10) !== bytes.length - 1
  ) {
    throw nativeHttpsOwnerRefused();
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw nativeHttpsOwnerRefused();
  }
}
export function encodeNativeHttpsOwnerFrame(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > NATIVE_HTTPS_OWNER_FRAME_LIMIT) {
    throw nativeHttpsOwnerRefused();
  }
  return bytes;
}
