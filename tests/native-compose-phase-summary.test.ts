import { expect, test } from "bun:test";
import {
  describeNativeComposeStorageTimings,
  summarizeNativeComposeStorageTimings,
} from "./e2e/native-compose-phase-summary.ts";

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({
    diagnostic: "native-compose-phase",
    version: 1,
    sequence: 1,
    span: 1,
    elapsedMs: 0,
    ...fields,
  });
}

test("storage timing evidence reads only closed phase trace fields", () => {
  const canary = "private-storage-canary";
  const stderr = [
    "#1 building with docker driver",
    line({ phase: "storage.proof", boundary: "begin", durationMs: null }),
    line({ phase: "storage.proof", boundary: "end", durationMs: 6200 }),
    line({ phase: "storage.proof", boundary: "fail", durationMs: 14_900 }),
    line({ phase: "storage.enroll", boundary: "end", durationMs: 21_000 }),
    line({ phase: "guard.storage", boundary: "end", durationMs: 7000 }),
    line({ phase: "guard.ownership", boundary: "end", durationMs: 90_000 }),
    line({ phase: canary, boundary: "end", durationMs: 1 }),
    line({ phase: "storage.proof", boundary: "end", durationMs: -1 }),
    line({ phase: "storage.proof", boundary: "end", durationMs: 1.5 }),
    `${line({ phase: "storage.proof", boundary: "end", durationMs: 5 })} ${canary}`,
    "{not json",
  ].join("\n");
  const timings = summarizeNativeComposeStorageTimings(stderr);
  expect(timings).toEqual({
    proofs: 2,
    proofMaxMs: 14_900,
    proofTotalMs: 21_100,
    longestMs: {
      "storage.proof": 14_900,
      "storage.enroll": 21_000,
      "guard.storage": 7000,
    },
  });
  const text = describeNativeComposeStorageTimings(timings);
  expect(text).toBe(
    "storage proofs=2 max=14900ms total=21100ms longest storage.proof=14900ms storage.enroll=21000ms guard.storage=7000ms"
  );
  expect(text).not.toContain(canary);
  expect(
    describeNativeComposeStorageTimings(
      summarizeNativeComposeStorageTimings("")
    )
  ).toBe("storage proofs=0 max=0ms total=0ms");
});
