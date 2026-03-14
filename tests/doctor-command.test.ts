import { expect, test } from "bun:test";

import { buildDoctorRecoveryGuidance } from "../src/commands/recovery-guidance.ts";

test("doctor guidance distinguishes restartable proxy drift from deeper repair", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "proxy ports",
        status: "warn",
        message: "Caddy not reachable (run: hack global up)",
      },
      {
        name: "caddy hosts",
        status: "warn",
        message: "No internal extra_hosts mapping found (run: hack restart)",
      },
      {
        name: "coredns forwarding",
        status: "warn",
        message: "SERVFAIL (run: hack doctor --fix)",
      },
    ],
  });

  expect(guidance.temporaryBreakage).toEqual([
    "hack global up",
    "hack restart",
  ]);
  expect(guidance.configurationRepair).toEqual(["hack doctor --fix"]);
  expect(guidance.verify).toEqual(["hack doctor"]);
  expect(guidance.capture).toEqual(["hack crash-capture --path <repo>"]);
});

test("doctor guidance includes daemon recovery for stale local api state", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "daemon",
        status: "warn",
        message: "hackd not running (stale pid/socket; run: hack daemon clear)",
      },
    ],
  });

  expect(guidance.temporaryBreakage).toEqual([
    "hack daemon clear",
    "hack daemon start",
  ]);
  expect(guidance.configurationRepair).toEqual([]);
});

test("doctor guidance keeps unmatched failures as follow-up instead of guessing", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "gateway tokens",
        status: "warn",
        message: "No active tokens (run: hack x gateway token-create)",
      },
    ],
  });

  expect(guidance.temporaryBreakage).toEqual([]);
  expect(guidance.configurationRepair).toEqual([]);
  expect(guidance.followUp).toEqual([
    "gateway tokens: No active tokens (run: hack x gateway token-create)",
  ]);
});
