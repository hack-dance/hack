import { expect, test } from "bun:test";

import {
  buildDoctorRecoveryGuidance,
  buildRecoveryNextSteps,
} from "../src/commands/recovery-guidance.ts";

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

test("doctor guidance keeps CoreDNS restartable outages out of doctor --fix", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "coredns forwarding",
        status: "warn",
        message: "CoreDNS not running (run: hack global up)",
      },
    ],
  });

  expect(guidance.temporaryBreakage).toEqual(["hack global up"]);
  expect(guidance.configurationRepair).toEqual([]);
});

test("doctor guidance keeps dnsmasq restarts out of doctor --fix", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "dnsmasq:53",
        status: "warn",
        message:
          "No DNS response from 127.0.0.1:53 (run: sudo brew services restart dnsmasq)",
      },
    ],
  });

  expect(guidance.temporaryBreakage).toEqual([
    "sudo brew services restart dnsmasq",
  ]);
  expect(guidance.configurationRepair).toEqual([]);
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

test("recovery next steps quote repo paths for copy-paste safety", () => {
  const nextSteps = buildRecoveryNextSteps({
    guidance: {
      temporaryBreakage: ["hack restart"],
      configurationRepair: ["hack doctor --fix"],
      followUp: [],
      verify: ["hack doctor"],
      capture: ["hack crash-capture --path <repo>"],
    },
    projectRoot: "/tmp/work repo",
    includeClassifyStep: true,
  });

  expect(nextSteps).toEqual([
    "Run `hack doctor --path '/tmp/work repo'` to classify restart versus repair work.",
    "Temporary breakage: `hack restart --path '/tmp/work repo'`.",
    "Configuration repair: `hack doctor --fix --path '/tmp/work repo'`.",
    "Verify with `hack doctor --path '/tmp/work repo'`.",
    "If it still fails, run `hack crash-capture --path '/tmp/work repo'` again after the next repro.",
  ]);
});
