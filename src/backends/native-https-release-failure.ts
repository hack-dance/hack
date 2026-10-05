import type { Socket } from "node:net";
import { isRecord } from "../lib/guards.ts";
import {
  encodeNativeHttpsOwnerFrame,
  isNativeHttpsLeaseIdentity,
  type NativeHttpsLeaseIdentity,
  nativeHttpsOwnerRefused,
  sameNativeHttpsLease,
} from "./native-https-owner-protocol.ts";
import { NativeRuntimeRequestError } from "./native-runtime-client.ts";

const STAGES = [
  "owner-validation",
  "lease-validation",
  "graph-verification",
  "idle-verification",
  "frontend-close",
  "release-publication",
  "owner-retirement",
] as const;
export type NativeHttpsReleaseStage = (typeof STAGES)[number];
const CODES = new Set([
  "provider_busy",
  "provider_state",
  "foreign_state",
  "invalid_receipt",
  "recovery_required",
  "host_endpoint_identity",
  "engine_protocol",
]);

/** A failure response carries no proof of effects: successful retirement requires its normal acknowledgement. */
export function nativeHttpsReleaseFailureFrame(opts: {
  readonly identity: NativeHttpsLeaseIdentity;
  readonly stage: NativeHttpsReleaseStage;
  readonly error: unknown;
}): Buffer {
  if (
    !(
      isNativeHttpsLeaseIdentity(opts.identity) &&
      STAGES.some((stage) => stage === opts.stage)
    )
  ) {
    throw nativeHttpsOwnerRefused();
  }
  const nativeCode =
    opts.error instanceof NativeRuntimeRequestError &&
    opts.error.nativeCode &&
    CODES.has(opts.error.nativeCode)
      ? opts.error.nativeCode
      : null;
  return encodeNativeHttpsOwnerFrame({
    version: 1,
    ok: false,
    operation: "release",
    identity: opts.identity,
    stage: opts.stage,
    nativeCode,
  });
}

/** Reject extra fields, arbitrary diagnostics and another attempt's response before reporting any code. */
export function parseNativeHttpsReleaseFailure(
  value: unknown,
  identity: NativeHttpsLeaseIdentity
): Error {
  if (
    !(
      isRecord(value) &&
      Object.keys(value).sort().join() ===
        "identity,nativeCode,ok,operation,stage,version" &&
      value.version === 1 &&
      value.ok === false &&
      value.operation === "release" &&
      isNativeHttpsLeaseIdentity(value.identity) &&
      sameNativeHttpsLease(identity, value.identity) &&
      STAGES.some((stage) => stage === value.stage) &&
      (value.nativeCode === null ||
        (typeof value.nativeCode === "string" && CODES.has(value.nativeCode)))
    )
  ) {
    return nativeHttpsOwnerRefused();
  }
  return new Error(
    `Native HTTPS release is unconfirmed (${value.stage}${value.nativeCode ? `: ${value.nativeCode}` : ""}); ownership evidence is retained, no request was replayed. Values omitted.`
  );
}

/** Best-effort bounded delivery, then the caller closes the failed request connection. */
export async function sendNativeHttpsReleaseFailure(
  socket: Socket,
  frame: Buffer
): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      socket.off("close", finish);
      socket.off("error", finish);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    socket.once("close", finish);
    socket.once("error", finish);
    try {
      socket.write(frame, finish);
    } catch {
      finish();
    }
  });
}

/** A diagnostic, malformed reply, or lost response never acknowledges release. */
export function nativeHttpsReleaseReplyError(
  value: unknown,
  identity: NativeHttpsLeaseIdentity
): Error | undefined {
  if (
    isRecord(value) &&
    Object.keys(value).sort().join() === "ok,released,version" &&
    value.version === 1 &&
    value.ok === true &&
    value.released === identity.leaseId
  ) {
    return;
  }
  return parseNativeHttpsReleaseFailure(value, identity);
}
