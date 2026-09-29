import { expect, test } from "bun:test";
import { link, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeNativeHttpsOwnerFrame,
  encodeNativeHttpsOwnerFrame,
  isNativeHttpsLeaseIdentity,
  NATIVE_HTTPS_OWNER_FRAME_LIMIT,
  parseNativeHttpsOwnerRequest,
} from "../src/backends/native-https-owner-protocol.ts";
import { nativeHttpsReadFile } from "../src/backends/native-https-owner-storage.ts";

const identity = {
  version: 1,
  ownerGeneration: "a".repeat(32),
  leaseId: "b".repeat(32),
  run: "c".repeat(32),
  attempt: "d".repeat(32),
  owner: "e".repeat(32),
  namespace: "f".repeat(64),
  planId: "0".repeat(64),
} as const;
test("lease framing refuses oversize, pipelined, partial and malformed requests", () => {
  const request = { version: 1, operation: "release", identity } as const;
  expect(
    parseNativeHttpsOwnerRequest(
      decodeNativeHttpsOwnerFrame(encodeNativeHttpsOwnerFrame(request))
    )
  ).toEqual(request);
  for (const bytes of [
    Buffer.from("{}"),
    Buffer.from("{}\n{}\n"),
    Buffer.from("{}\nextra"),
    Buffer.from("invalid\n"),
    Buffer.alloc(NATIVE_HTTPS_OWNER_FRAME_LIMIT + 1, 10),
  ]) {
    expect(() => decodeNativeHttpsOwnerFrame(bytes)).toThrow();
  }
  for (const invalid of [
    { ...request, version: 2 },
    { ...request, hidden: true },
    { ...request, identity: { ...identity, ownerGeneration: "bad" } },
    {
      version: 1,
      operation: "acquire",
      ownerGeneration: identity.ownerGeneration,
      lease: identity,
    },
  ]) {
    expect(() => parseNativeHttpsOwnerRequest(invalid)).toThrow();
  }
});
test("lease identity requires every exact graph and owner-generation field", () => {
  expect(isNativeHttpsLeaseIdentity(identity)).toBe(true);
  for (const key of Object.keys(identity)) {
    const missing: Record<string, unknown> = { ...identity };
    delete missing[key];
    expect(isNativeHttpsLeaseIdentity(missing)).toBe(false);
  }
  expect(isNativeHttpsLeaseIdentity({ ...identity, pid: 42 })).toBe(false);
});

test("publication reader tolerates the bounded two-link transition but refuses a persistent hardlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "hk-owner-publication-"));
  const path = join(root, "receipt.json");
  const temporary = join(root, "receipt.pending");
  try {
    await writeFile(path, "private-fixture", { mode: 0o600 });
    await link(path, temporary);
    await expect(nativeHttpsReadFile(path)).rejects.toThrow();
    await unlink(temporary);
    await link(path, temporary);
    const observing = nativeHttpsReadFile(path);
    await Bun.sleep(15);
    await unlink(temporary);
    expect((await observing).bytes.toString()).toBe("private-fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
