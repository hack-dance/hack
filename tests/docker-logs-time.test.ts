import { expect, test } from "bun:test";
import { dockerLogsTime } from "../src/lib/duration.ts";

test("day and week durations become hours, which docker logs accepts", () => {
  expect(dockerLogsTime("2d")).toBe("48h");
  expect(dockerLogsTime("1w")).toBe("168h");
  expect(dockerLogsTime("3D")).toBe("72h");
  expect(dockerLogsTime("10 m")).toBe("10m");
  expect(dockerLogsTime("30s")).toBe("30s");
});

test("timestamps and Go durations are passed unchanged", () => {
  expect(dockerLogsTime("2026-11-20T10:00:00Z")).toBe("2026-11-20T10:00:00Z");
  expect(dockerLogsTime("1h30m")).toBe("1h30m");
  expect(dockerLogsTime("1700000000")).toBe("1700000000");
});
