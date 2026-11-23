import { expect, test } from "bun:test";
import { readTimingLine } from "../src/lib/timing-record.ts";

const record = {
  schema: "hack.timings/1",
  trace: "4bf92f3577b34da6a3ce929d0e0e4736",
  span: "00f067aa0ba902b7",
  parent: null,
  proc: "runtime",
  clock: "host",
  origin_unix_us: 1,
  origin_mono_us: 1,
  step: "container.start",
  start_us: 0,
  dur_us: 1,
  outcome: "ok",
  attrs: {},
};
test("unknown roles/outcomes survive; unsafe names and text attributes do not", () => {
  const line = JSON.stringify({
    schema: "hack.timings/1",
    trace: "4bf92f3577b34da6a3ce929d0e0e4736",
    span: "00f067aa0ba902b7",
    proc: "future",
    clock: "future",
    origin_unix_us: 1,
    origin_mono_us: 1,
    step: "future.step",
    start_us: 0,
    dur_us: 1,
    outcome: "future",
    attrs: { safe: 1, "../unsafe": 2, text: "private-value" },
  });
  const record = readTimingLine(line);
  expect(record?.proc).toBe("unknown");
  expect(record?.outcome).toBe("unknown");
  expect(record?.attrs).toEqual({ safe: 1 });
  expect(
    readTimingLine(line.replace("future.step", "../unsafe"))
  ).toBeUndefined();
});

test("wire identity, integer bounds and required names are validated", () => {
  for (const patch of [
    { schema: "other" },
    { trace: "0".repeat(32) },
    { span: "bad" },
    { parent: record.span },
    { step: "unsafe/name" },
    { origin_mono_us: -1 },
    { dur_us: 0.5 },
    { start_us: Number.MAX_SAFE_INTEGER },
  ]) {
    expect(
      readTimingLine(JSON.stringify({ ...record, ...patch }))
    ).toBeUndefined();
  }
  expect(readTimingLine("{")).toBeUndefined();
  expect(readTimingLine(" ".repeat(16_385))).toBeUndefined();
  expect(
    readTimingLine(JSON.stringify({ ...record, extra: "€".repeat(6000) }))
  ).toBeUndefined();
});
test("additive fields survive safely while optional unsafe values are omitted", () => {
  const value = readTimingLine(
    JSON.stringify({
      ...record,
      parent: undefined,
      code: "../unsafe",
      cached: true,
      extra: { anything: true },
      attrs: { count: 2.5, flag: true, string: "private", huge: 1e30 },
    })
  );
  expect(value?.parent).toBeNull();
  expect(value?.cached).toBe(true);
  expect(value?.code).toBeUndefined();
  expect(value?.attrs).toEqual({ count: 2.5, flag: true });
  expect(
    readTimingLine(
      JSON.stringify({ ...record, outcome: "future", cached: true })
    )?.cached
  ).toBeUndefined();
});
