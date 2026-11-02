import { describe, expect, test } from "bun:test";
import {
  verifyAdmissionModelResult,
  verifyBalloonReuseModelResult,
  verifyRestoreHistoryModelResult,
} from "../scripts/lib/tla-result.ts";

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
      "Model checking completed. No error has been found.\n15 distinct states found, 0 states left on queue.",
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

describe("TLC balloon reuse evidence", () => {
  test("requires complete seven-state positive exploration", () => {
    const output =
      "Model checking completed. No error has been found.\n7 distinct states found, 0 states left on queue.";
    expect(
      verifyBalloonReuseModelResult({ negative: false, exitCode: 0, output })
    ).toBe(true);
    for (const invalid of [
      "",
      output.replace("7 distinct", "6 distinct"),
      output.replace("7 distinct", "17 distinct"),
      output.replace("0 states left", "1 states left"),
    ]) {
      expect(
        verifyBalloonReuseModelResult({
          negative: false,
          exitCode: 0,
          output: invalid,
        })
      ).toBe(false);
    }
    expect(
      verifyBalloonReuseModelResult({ negative: false, exitCode: null, output })
    ).toBe(false);
  });
  test("requires an unaccounted mapped state in the same remap step", () => {
    const output =
      'Invariant MappedMemoryAccounted is violated.\nState 5: <Remap line 14 of module BalloonReuse>\n/\\ phase = "mapped"\n/\\ reusable = TRUE\n';
    expect(
      verifyBalloonReuseModelResult({ negative: true, exitCode: 12, output })
    ).toBe(true);
    for (const exitCode of [0, 1, 150, null]) {
      expect(
        verifyBalloonReuseModelResult({ negative: true, exitCode, output })
      ).toBe(false);
    }
    for (const invalid of [
      "Parse error",
      output.replace("MappedMemoryAccounted", "Other"),
      output.replace("TRUE", "FALSE"),
      output.replace("<Remap", "<Stop"),
      output.replace(
        "/\\ reusable = TRUE",
        "State 6: <Discard>\n/\\ reusable = TRUE"
      ),
    ]) {
      expect(
        verifyBalloonReuseModelResult({
          negative: true,
          exitCode: 12,
          output: invalid,
        })
      ).toBe(false);
    }
  });
});

describe("TLC restore history evidence", () => {
  test("requires complete exploration and the intended same-state loss of history", () => {
    const positive =
      "Model checking completed. No error has been found.\n27 distinct states found, 0 states left on queue.";
    expect(
      verifyRestoreHistoryModelResult({
        negative: false,
        exitCode: 0,
        output: positive,
      })
    ).toBe(true);
    expect(
      verifyRestoreHistoryModelResult({
        negative: false,
        exitCode: 0,
        output: positive.replace("27 distinct", "127 distinct"),
      })
    ).toBe(false);
    const output =
      'Invariant HistoryPreserved is violated.\nState 2: <Prepare line 1>\n/\\ legacy = <<>>\n/\\ manifest = <<>>\n/\\ phase = "writing"\n';
    expect(
      verifyRestoreHistoryModelResult({ negative: true, exitCode: 12, output })
    ).toBe(true);
    for (const exitCode of [0, 1, 150, null]) {
      expect(
        verifyRestoreHistoryModelResult({ negative: true, exitCode, output })
      ).toBe(false);
    }
    for (const invalid of [
      "Parse error",
      output.replace("HistoryPreserved", "Other"),
      output.replace("legacy = <<>>", "legacy = <<1>>"),
      output.replace("/\\ manifest", "State 3: <Publish>\n/\\ manifest"),
    ]) {
      expect(
        verifyRestoreHistoryModelResult({
          negative: true,
          exitCode: 12,
          output: invalid,
        })
      ).toBe(false);
    }
  });
});
