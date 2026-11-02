import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { requestNativeHttpsOwner } from "../src/backends/native-https-owner.ts";
import {
  decodeNativeHttpsOwnerFrame,
  encodeNativeHttpsOwnerFrame,
  type NativeHttpsLeaseIdentity,
} from "../src/backends/native-https-owner-protocol.ts";
import {
  nativeHttpsReleaseFailureFrame,
  nativeHttpsReleaseReplyError,
  parseNativeHttpsReleaseFailure,
  sendNativeHttpsReleaseFailure,
} from "../src/backends/native-https-release-failure.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";

const identity: NativeHttpsLeaseIdentity = {
  version: 1,
  ownerGeneration: "a".repeat(32),
  owner: "b".repeat(32),
  leaseId: "c".repeat(32),
  run: "d".repeat(32),
  attempt: "e".repeat(32),
  namespace: "f".repeat(64),
  planId: "1".repeat(64),
};
const canary = "/private/fixture/secret-token-CANARY";
const frame = nativeHttpsReleaseFailureFrame({
  identity,
  stage: "graph-verification",
  error: new NativeRuntimeRequestError({
    message: canary,
    nativeCode: "provider_busy",
    nativeCauseCode: canary,
  }),
});
const failure = decodeNativeHttpsOwnerFrame(frame) as Record<string, unknown>;
const ack = { version: 1, ok: true, released: identity.leaseId };

test("release failure reports only an exact lease, fixed stage and reviewed native code", () => {
  expect(frame.toString()).not.toContain(canary);
  expect(parseNativeHttpsReleaseFailure(failure, identity).message).toBe(
    "Native HTTPS release is unconfirmed (graph-verification: provider_busy); ownership evidence is retained, no request was replayed. Values omitted."
  );
  expect(nativeHttpsReleaseReplyError(ack, identity)).toBeUndefined();
  expect(nativeHttpsReleaseReplyError(failure, identity)).toBeInstanceOf(Error);
});

test.each([
  new Error(canary),
  { nativeCode: "provider_busy", message: canary },
  new NativeRuntimeRequestError({ message: canary, nativeCode: canary }),
  new NativeRuntimeRequestError({ message: canary }),
])("untyped and unreviewed release diagnostics remain value-free", (error) => {
  const bytes = nativeHttpsReleaseFailureFrame({
    identity,
    stage: "frontend-close",
    error,
  });
  expect(bytes.toString()).not.toContain(canary);
  const parsed = decodeNativeHttpsOwnerFrame(bytes);
  expect(parsed).toEqual({
    ...failure,
    stage: "frontend-close",
    nativeCode: null,
  });
  expect(
    parseNativeHttpsReleaseFailure(parsed, identity).message
  ).not.toContain("provider_busy");
});

test.each([
  "ownerGeneration",
  "leaseId",
  "owner",
  "run",
  "attempt",
  "namespace",
  "planId",
] as const)("another %s cannot supply a release diagnostic", (key) => {
  const foreign = { ...identity, [key]: "9".repeat(identity[key].length) };
  expect(
    parseNativeHttpsReleaseFailure({ ...failure, identity: foreign }, identity)
      .message
  ).toContain("ownership is unavailable or unconfirmed");
});

test.each(
  [
    null,
    [],
    {},
    { ...failure, version: 2 },
    { ...failure, ok: true },
    { ...failure, operation: "acquire" },
    { ...failure, stage: canary },
    { ...failure, nativeCode: canary },
    { ...failure, stderr: canary },
    { ...failure, released: identity.leaseId },
    { ...failure, identity: { ...identity, extra: canary } },
    { ...ack, operation: "release" },
    { ...ack, released: "0".repeat(32) },
    { ...ack, error: failure },
  ].map((value) => [value] as const)
)("malformed and extra response data cannot acknowledge release or disclose values", (value) => {
  const error = nativeHttpsReleaseReplyError(value, identity);
  expect(error).toBeInstanceOf(Error);
  expect(error?.message).toContain("ownership is unavailable or unconfirmed");
  expect(error?.message).not.toContain(canary);
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
async function replyFixture(bytes: Buffer | undefined) {
  let requests = 0;
  const peers: Socket[] = [];
  const server = createServer((peer) => {
    peers.push(peer);
    peer.once("data", () => {
      requests += 1;
      if (bytes) {
        peer.end(bytes);
      } else {
        peer.destroy();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing fixture port");
  }
  const socket = createConnection({ host: "127.0.0.1", port: address.port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  cleanups.push(async () => {
    socket.destroy();
    for (const peer of peers) {
      peer.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { socket, requests: () => requests };
}

test.each([
  ["exact diagnostic", frame],
  ["transport close", undefined],
  ["oversized", Buffer.alloc(8193, 65)],
  ["malformed JSON", Buffer.from("{broken}\n")],
  [
    "extra response field",
    encodeNativeHttpsOwnerFrame({ ...failure, extra: canary }),
  ],
  [
    "wrong operation",
    encodeNativeHttpsOwnerFrame({ ...failure, operation: "acquire" }),
  ],
  [
    "foreign identity",
    encodeNativeHttpsOwnerFrame({
      ...failure,
      identity: { ...identity, run: "8".repeat(32) },
    }),
  ],
  [
    "duplicate ok",
    Buffer.from(
      `{"ok":false,"ok":true,"version":1,"released":"${identity.leaseId}"}\n`
    ),
  ],
  [
    "duplicate identity",
    Buffer.from(
      frame.toString().replace('"identity":', `"identity":{},"identity":`)
    ),
  ],
  ["pipelined ack", Buffer.concat([frame, encodeNativeHttpsOwnerFrame(ack)])],
] as const)("real release request refuses %s exactly once", async (name, bytes) => {
  const f = await replyFixture(bytes);
  const result = await requestNativeHttpsOwner(f.socket, {
    version: 1,
    operation: "release",
    identity,
  }).then(
    () => {
      throw new Error("unexpected release acknowledgement");
    },
    (error: unknown) => error
  );
  expect(result).toBeInstanceOf(Error);
  const message = (result as Error).message;
  expect(message).not.toContain(canary);
  expect(message).toContain(
    name === "exact diagnostic"
      ? "graph-verification: provider_busy"
      : "ownership is unavailable or unconfirmed"
  );
  expect(f.requests()).toBe(1);
});

test("best-effort diagnostic delivery is bounded when a socket never flushes", async () => {
  const peer = new EventEmitter();
  Object.assign(peer, { write: () => false });
  const start = Date.now();
  await sendNativeHttpsReleaseFailure(peer as Socket, frame);
  expect(Date.now() - start).toBeLessThan(3000);
  expect(peer.listenerCount("error")).toBe(0);
  expect(peer.listenerCount("close")).toBe(0);
});
