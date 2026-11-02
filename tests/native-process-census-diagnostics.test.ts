import { expect, test } from "bun:test";
import {
  beginNativeProcessCensusPhase,
  createNativeProcessCensusDiagnostics,
} from "../src/backends/native-process-census-diagnostics.ts";

test("census diagnostics bound retained samples and expose dropped counts", () => {
  const diagnostics = createNativeProcessCensusDiagnostics();
  for (let i = 0; i < 300; i++) {
    const finish = beginNativeProcessCensusPhase({
      diagnostics,
      phase: "metadata",
    });
    finish?.({ outcome: "refused", rowCount: i });
    finish?.({ outcome: "complete", rowCount: 123 });
  }
  const report = diagnostics.snapshot();
  expect(report.samples).toHaveLength(256);
  expect(report.dropped).toBe(44);
  expect(report.samples[0]?.rowCount).toBe(44);
  expect(report.samples.at(-1)?.rowCount).toBe(299);
  expect(report.samples.every((sample) => sample.outcome === "refused")).toBe(
    true
  );
  expect(Object.isFrozen(report.samples)).toBe(true);
  expect(Object.isFrozen(report)).toBe(true);
});

test("a diagnostic snapshot stays immutable as later observations arrive", () => {
  const diagnostics = createNativeProcessCensusDiagnostics();
  const first = diagnostics.snapshot();
  beginNativeProcessCensusPhase({ diagnostics, phase: "census" })?.({
    outcome: "complete",
    rowCount: 0,
  });
  expect(first.samples).toEqual([]);
  expect(diagnostics.snapshot().samples).toHaveLength(1);
  beginNativeProcessCensusPhase({ diagnostics, phase: "metadata" })?.({
    outcome: "refused",
  });
  expect(diagnostics.snapshot().samples.at(-1)?.rowCount).toBeNull();
  expect(
    beginNativeProcessCensusPhase({ diagnostics: undefined, phase: "merge" })
  ).toBeUndefined();
});
