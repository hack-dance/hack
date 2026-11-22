import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NATIVE_HTTPS_OWNER_ARGUMENT } from "../src/backends/native-https-owner-protocol.ts";
import { nativeHttpsPoolBootEnded } from "../src/backends/native-https-pool-boot.ts";

const pool = {
  owner: "a".repeat(32),
  bootId: "12345678-1234-1234-1234-123456789abc",
};
const record = (fields: Record<string, unknown>) => ({
  token: pool.owner,
  guest_boot_id: pool.bootId,
  phase: "running",
  ...fields,
});

test("the owner's boot continues while the pool runs or changes state in that boot", () => {
  expect(nativeHttpsPoolBootEnded(record({}), pool)).toBe(false);
  // Transitional phases prove nothing: an operation may still be changing them.
  for (const phase of ["starting", "stopping", "initializing", "unknown"]) {
    expect(nativeHttpsPoolBootEnded(record({ phase }), pool)).toBe(false);
  }
});

test("a stopped phase, a new boot or another pool ends the owner's boot", () => {
  for (const phase of [
    "stopped",
    "stopped-before-engine",
    "stopped-after-engine-failure",
    "recovered-unclean",
    "failed-boot-stopped",
  ]) {
    expect(nativeHttpsPoolBootEnded(record({ phase }), pool)).toBe(true);
  }
  expect(
    nativeHttpsPoolBootEnded(
      record({ guest_boot_id: "87654321-4321-4321-4321-cba987654321" }),
      pool
    )
  ).toBe(true);
  expect(
    nativeHttpsPoolBootEnded(record({ token: "b".repeat(32) }), pool)
  ).toBe(true);
});

test("an unreadable or partial pool record never ends the owner's boot", () => {
  for (const value of [null, "text", 7, [], {}, { token: 1 }]) {
    expect(nativeHttpsPoolBootEnded(value, pool)).toBe(false);
  }
  // No boot id yet (a pool between boots) is not a new boot.
  expect(nativeHttpsPoolBootEnded(record({ guest_boot_id: null }), pool)).toBe(
    false
  );
  expect(nativeHttpsPoolBootEnded(record({ guest_boot_id: "" }), pool)).toBe(
    false
  );
});

test("the runtime's previous-boot archive matches the owner by the same argument", async () => {
  const source = await readFile(
    join(
      import.meta.dir,
      "../packages/runtime-core/src/provider/shared_https_recovery.rs"
    ),
    "utf8"
  );
  expect(source).toContain(
    `const OWNER_ARGUMENT: &str = "${NATIVE_HTTPS_OWNER_ARGUMENT}";`
  );
});
