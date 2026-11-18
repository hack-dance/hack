import { expect, test } from "bun:test";
import { constants as osConstants } from "node:os";
import {
  subprocessSignalExitStatus,
  subprocessSignalLabel,
  subprocessSignalNumber,
} from "../src/lib/subprocess-signal.ts";

test("a named signal maps to its number and shell exit status", () => {
  expect(subprocessSignalNumber("SIGTERM", 0)).toBe(
    osConstants.signals.SIGTERM
  );
  expect(subprocessSignalExitStatus("SIGKILL", 0)).toBe(
    128 + osConstants.signals.SIGKILL
  );
  expect(subprocessSignalLabel("SIGINT")).toBe("SIGINT");
});

test("an unnamed signal Bun reports by number keeps that number", () => {
  // Bun reports a signal without a name (a Linux real-time signal) by number.
  expect(subprocessSignalNumber(42, 0)).toBe(42);
  expect(subprocessSignalExitStatus(42, 0)).toBe(170);
  expect(subprocessSignalLabel(42)).toBe("42");
});

test("absent signals and unknown names use the caller's fallback", () => {
  expect(subprocessSignalLabel(null)).toBeNull();
  expect(subprocessSignalLabel(undefined)).toBeNull();
  expect(subprocessSignalExitStatus("SIGNOTREAL" as NodeJS.Signals, 1)).toBe(
    129
  );
});

test("Bun reports a named signal from a real subprocess by name", async () => {
  const proc = Bun.spawn(["sleep", "5"]);
  proc.kill("SIGTERM");
  await proc.exited;
  expect(subprocessSignalLabel(proc.signalCode)).toBe("SIGTERM");
  expect(subprocessSignalExitStatus(proc.signalCode ?? 0, 0)).toBe(
    128 + osConstants.signals.SIGTERM
  );
});
