import { expect, test } from "bun:test";
import { McpCommandAdmission } from "../src/mcp/command-admission.ts";

test("busy command admission rejects without running or queuing work", async () => {
  const admission = new McpCommandAdmission(1);
  const release = Promise.withResolvers<void>();
  let ran = false;
  let drained = false;
  const active = admission.run(() => release.promise);
  const drain = admission.drain().then(() => {
    drained = true;
  });
  await expect(
    admission.run(async () => {
      ran = true;
    })
  ).rejects.toThrow("busy");
  expect(ran).toBe(false);
  expect(drained).toBe(false);
  release.resolve();
  await active;
  await drain;
  expect(drained).toBe(true);
  expect(await admission.run(async () => 42)).toBe(42);
  expect(ran).toBe(false);
});

test("failed work releases its slot and drain completes", async () => {
  const admission = new McpCommandAdmission(1);
  await expect(
    admission.run(async () => {
      throw new Error("failed child");
    })
  ).rejects.toThrow("failed child");
  await admission.drain();
  expect(await admission.run(async () => "recovered")).toBe("recovered");
});

test("admission rejects invalid resource limits", () => {
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => new McpCommandAdmission(limit)).toThrow(RangeError);
  }
});

test("shutdown refuses late arrivals while admitted work drains", async () => {
  const admission = new McpCommandAdmission(1);
  const release = Promise.withResolvers<void>();
  const active = admission.run(() => release.promise);
  admission.stop();
  await expect(admission.run(async () => 1)).rejects.toThrow("shutting down");
  release.resolve();
  await active;
  await admission.drain();
  await expect(admission.run(async () => 1)).rejects.toThrow("shutting down");
});
