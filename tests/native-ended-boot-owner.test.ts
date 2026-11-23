import { expect, test } from "bun:test";
import {
  awaitNativeEndedBootOwner,
  NATIVE_ENDED_BOOT_OWNER_NOTICE,
  nativePoolBootProvenEnded,
} from "../src/backends/native-ended-boot-owner.ts";

const pool = (fields: Record<string, unknown>) => async () => ({
  token: "a".repeat(32),
  guest_boot_id: "12345678-1234-1234-1234-123456789abc",
  ...fields,
});

test("only a stopped pool record proves the earlier boot ended", async () => {
  for (const phase of ["stopped", "stopped-before-engine"]) {
    expect(await nativePoolBootProvenEnded("/fixture", pool({ phase }))).toBe(
      true
    );
  }
  for (const read of [
    pool({ phase: "running" }),
    pool({ phase: "starting" }),
    pool({ phase: "stopping" }),
    async () => "not a record",
    () => Promise.reject(new Error("unreadable")),
  ]) {
    expect(await nativePoolBootProvenEnded("/fixture", read)).toBe(false);
  }
});

test("the wait ends as soon as the owner goes, says so once, and never waits on a running pool", async () => {
  const lines: string[] = [];
  let checks = 0;
  await awaitNativeEndedBootOwner({
    home: "/fixture",
    read: pool({ phase: "stopped" }),
    notice: (line) => lines.push(line),
    pollMs: 1,
    ownerRunning: async () => {
      checks += 1;
      return checks < 4;
    },
  });
  expect(checks).toBe(4);
  expect(lines).toEqual([NATIVE_ENDED_BOOT_OWNER_NOTICE]);
  // A running pool proves nothing: no owner check, no line.
  let asked = false;
  await awaitNativeEndedBootOwner({
    home: "/fixture",
    read: pool({ phase: "running" }),
    notice: (line) => lines.push(line),
    ownerRunning: async () => {
      asked = true;
      return true;
    },
  });
  expect(asked).toBe(false);
  expect(lines).toHaveLength(1);
});

test("the wait is bounded and stops when the pool is no longer proven stopped", async () => {
  const started = performance.now();
  await awaitNativeEndedBootOwner({
    home: "/fixture",
    read: pool({ phase: "stopped" }),
    notice: () => undefined,
    waitMs: 30,
    pollMs: 5,
    ownerRunning: async () => true,
  });
  expect(performance.now() - started).toBeLessThan(1000);
  // Something booted the pool meanwhile: the wait ends and the caller decides.
  let reads = 0;
  let checks = 0;
  await awaitNativeEndedBootOwner({
    home: "/fixture",
    read: async () => {
      reads += 1;
      return (await pool({
        phase: reads < 3 ? "stopped" : "running",
      })()) as unknown;
    },
    notice: () => undefined,
    pollMs: 1,
    ownerRunning: async () => {
      checks += 1;
      return true;
    },
  });
  expect(checks).toBe(2);
});
