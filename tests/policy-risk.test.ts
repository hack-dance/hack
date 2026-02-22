import { expect, test } from "bun:test";

import { assessCommandRisk } from "../src/control-plane/policy/risk.ts";

test("assessCommandRisk classifies low read command", () => {
  const risk = assessCommandRisk({
    command: ["git", "status"],
    runner: "generic",
  });
  expect(risk.level).toBe("low");
  expect(risk.requiresApproval).toBe(false);
});

test("assessCommandRisk classifies medium build/test command", () => {
  const risk = assessCommandRisk({
    command: ["bun", "test"],
    runner: "generic",
  });
  expect(risk.level).toBe("medium");
  expect(risk.requiresApproval).toBe(false);
});

test("assessCommandRisk classifies high git push command", () => {
  const risk = assessCommandRisk({
    command: ["git", "push", "origin", "main"],
    runner: "generic",
  });
  expect(risk.level).toBe("high");
  expect(risk.requiresApproval).toBe(true);
});

test("assessCommandRisk classifies critical destructive command", () => {
  const risk = assessCommandRisk({
    command: ["bash", "-lc", "rm -rf /tmp/unsafe && rm -rf /"],
    runner: "generic",
  });
  expect(risk.level).toBe("critical");
  expect(risk.requiresApproval).toBe(true);
});

test("assessCommandRisk treats agent runners as at least medium", () => {
  const risk = assessCommandRisk({
    command: ["cat", "README.md"],
    runner: "codex",
  });
  expect(risk.level).toBe("medium");
  expect(risk.requiresApproval).toBe(false);
});
