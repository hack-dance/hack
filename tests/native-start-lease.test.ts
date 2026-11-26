import { expect, test } from "bun:test";
import {
  NATIVE_START_LEASE_REQUEST_TIMEOUT_MS,
  NATIVE_START_LEASE_WAIT_SECONDS,
  nativeStartLeaseHolder,
  nativeStartLeaseRefusal,
  nativeStartLeaseWaitLine,
} from "../src/backends/native-start-lease.ts";

const PROJECT_STOP =
  "Provider lease acquisition refused; recorded holder: project stop; no operation was admitted.";

test("HACK-2724: the start's progress line names the holder the runtime reported", () => {
  expect(nativeStartLeaseWaitLine("project-stop")).toBe(
    "Waiting for the native runtime lock, held by a project stop. This start continues once it is released (up to 35 s)."
  );
  expect(nativeStartLeaseWaitLine("cleanup")).toContain("held by a cleanup.");
  expect(nativeStartLeaseWaitLine("start")).toContain("held by another start.");
  // A token outside the closed set, and the runtime's catch-all kinds, name no holder.
  for (const token of ["native-operation", "unknown", "made-up", undefined]) {
    expect(nativeStartLeaseWaitLine(token)).toContain(
      "held by another native runtime operation."
    );
  }
});

test("HACK-2724: the refusal names the holder and a plain retry of the command the user ran", () => {
  expect(nativeStartLeaseHolder(PROJECT_STOP)).toBe("project stop");
  expect(
    nativeStartLeaseRefusal({
      nativeMessage: PROJECT_STOP,
      command: "hack up -d",
    }).split("\n")
  ).toEqual([
    "Native startup could not acquire the native runtime lock (provider_busy); nothing was started.",
    "Holder: project stop.",
    "Retry hack up -d once that project stop finishes.",
  ]);
  // A refusal that names no holder still says what to do.
  expect(
    nativeStartLeaseRefusal({
      nativeMessage: "synthetic-private-value",
      command: "hack up",
    }).split("\n")
  ).toEqual([
    "Native startup could not acquire the native runtime lock (provider_busy); nothing was started.",
    "Holder: unavailable.",
    "Retry hack up once the holder finishes.",
  ]);
});

test("HACK-2724: a short start read outlasts the runtime's lease wait", () => {
  expect(NATIVE_START_LEASE_REQUEST_TIMEOUT_MS).toBeGreaterThan(
    NATIVE_START_LEASE_WAIT_SECONDS * 1000 + 10_000
  );
});
