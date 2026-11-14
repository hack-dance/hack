import { expect, test } from "bun:test";
import { upgradeActionKind } from "../src/lib/upgrade-action-kind.ts";

test("action kinds require known exact commands and fail closed for decisions", () => {
  for (const args of [
    ["upgrade", "snapshot"],
    ["daemon", "status"],
  ]) {
    expect(upgradeActionKind({ args, action: null })).toBe("safe");
    expect(upgradeActionKind({ args, action: "Review the key first." })).toBe(
      "manual"
    );
  }
  for (const args of [
    ["global", "install"],
    ["global", "up"],
    ["daemon", "install"],
    ["daemon", "restart"],
  ]) {
    expect(upgradeActionKind({ args, action: null })).toBe("admin");
  }
  for (const args of [
    null,
    [],
    ["upgrade snapshot"],
    ["upgrade", "snapshot", "--unknown"],
    ["doctor", "--fix"],
    ["setup", "migrate"],
    ["secrets", "retire-store"],
    ["future", "fix"],
  ]) {
    expect(upgradeActionKind({ args, action: null })).toBe("manual");
  }
});
