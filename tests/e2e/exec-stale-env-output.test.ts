import { describe, expect, test } from "bun:test";
import { execProbeValue } from "./scenarios/exec-stale-env.ts";

describe("execProbeValue", () => {
  test("returns the child's value after Hack diagnostic lines", () => {
    const stdout = [
      "▲  CoreDNS is not reachable; internal DNS for *.hack is disabled.",
      "▲  Caddy is not reachable; internal *.hack host mappings are disabled.",
      "synthetic-stale-probe-at-up",
      "",
    ].join("\n");
    expect(execProbeValue({ stdout })).toBe("synthetic-stale-probe-at-up");
  });

  test("trims CRLF and surrounding whitespace", () => {
    expect(execProbeValue({ stdout: "  value\r\n\r\n" })).toBe("value");
  });

  test("does not match when the value is wrong or missing", () => {
    expect(
      execProbeValue({ stdout: "synthetic-stale-probe-at-up\nother\n" })
    ).toBe("other");
    expect(execProbeValue({ stdout: "" })).toBeNull();
    expect(execProbeValue({ stdout: "\n  \n" })).toBeNull();
  });
});
