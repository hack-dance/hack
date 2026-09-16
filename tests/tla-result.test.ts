import { describe, expect, test } from "bun:test";
import { verifyAdmissionModelResult } from "../scripts/lib/tla-result.ts";

describe("TLC admission evidence", () => {
  test("requires completed state exploration for the positive model", () => {
    const output =
      "Model checking completed. No error has been found.\n5 distinct states found, 0 states left on queue.";
    expect(
      verifyAdmissionModelResult({ negative: false, exitCode: 0, output })
    ).toBe(true);
    for (const invalid of [
      "",
      "Model checking completed. No error has been found.",
      "5 distinct states found, 1 states left on queue",
    ]) {
      expect(
        verifyAdmissionModelResult({
          negative: false,
          exitCode: 0,
          output: invalid,
        })
      ).toBe(false);
    }
    expect(
      verifyAdmissionModelResult({ negative: false, exitCode: null, output })
    ).toBe(false);
  });
  test("accepts only the intended negative invariant and counterexample", () => {
    const output = "Invariant Capacity is violated.\nused = {1, 2}";
    expect(
      verifyAdmissionModelResult({ negative: true, exitCode: 12, output })
    ).toBe(true);
    for (const exitCode of [0, 1, 150, null]) {
      expect(
        verifyAdmissionModelResult({ negative: true, exitCode, output })
      ).toBe(false);
    }
    for (const invalid of [
      "Parse error",
      "Invariant Other is violated.\nused = {1, 2}",
      "Invariant Capacity is violated.\nused = {1}",
    ]) {
      expect(
        verifyAdmissionModelResult({
          negative: true,
          exitCode: 12,
          output: invalid,
        })
      ).toBe(false);
    }
  });
});
