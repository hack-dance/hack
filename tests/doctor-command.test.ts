import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDoctorRemediationPlanLines,
  buildDoctorSummaryLines,
} from "../src/commands/doctor.ts";
import {
  buildDoctorRecoveryGuidance,
  buildRecoveryNextSteps,
  buildRecoveryWorkflowLines,
} from "../src/commands/recovery-guidance.ts";

async function createDoctorTestProject(opts: {
  readonly modern?: boolean;
  readonly legacy?: boolean;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-doctor-"));
  const hackDir = join(root, ".hack");
  await mkdir(hackDir, { recursive: true });
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.19\n"
  );
  if (opts.legacy) {
    await writeFile(
      join(hackDir, "hack.env.json"),
      '{"version":1,"vars":[]}\n'
    );
  }
  if (opts.modern) {
    await writeFile(
      join(hackDir, "hack.env.default.yaml"),
      "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
    );
  }
  return root;
}

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

test("doctor remediation plan mentions env migration when requested for a legacy project", async () => {
  const root = await createDoctorTestProject({ legacy: true });
  try {
    const lines = await buildDoctorRemediationPlanLines({
      startDir: root,
      migrateEnvConfig: true,
    });

    expect(lines).toEqual([
      "1. Review and repair local network, CoreDNS, CA, host TLS env, and daemon drift where needed.",
      "2. Repair tickets refs if the project repo needs it.",
      "3. Prompt to migrate legacy env config (.hack/hack.env.json) to hack.env.*.yaml.",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor remediation plan skips env migration when modern env files already exist", async () => {
  const root = await createDoctorTestProject({ modern: true });
  try {
    const lines = await buildDoctorRemediationPlanLines({
      startDir: root,
      migrateEnvConfig: true,
    });

    expect(lines).toEqual([
      "1. Review and repair local network, CoreDNS, CA, host TLS env, and daemon drift where needed.",
      "2. Repair tickets refs if the project repo needs it.",
      "3. Skip env migration because this project already uses hack.env.*.yaml.",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
        name: "custom check",
        status: "warn",
        message: "Needs manual attention",
      },
    ],
  });

  expect(guidance.temporaryBreakage).toEqual([]);
  expect(guidance.configurationRepair).toEqual([]);
  expect(guidance.followUp).toEqual(["custom check: Needs manual attention"]);
});

test("doctor guidance ignores optional dependency noise and inactive gateway tokens", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "caddy (optional)",
        status: "warn",
        message: "Not found (optional)",
      },
      {
        name: "asdf (optional)",
        status: "warn",
        message: "Not found (optional)",
      },
      {
        name: "gateway tokens",
        status: "warn",
        message: "No active tokens (run: hack x gateway token-create)",
      },
    ],
  });

  expect(guidance.temporaryBreakage).toEqual([]);
  expect(guidance.configurationRepair).toEqual([]);
  expect(guidance.followUp).toEqual([]);
});

test("doctor summary groups detailed checks into concise sections", () => {
  const lines = buildDoctorSummaryLines({
    results: [
      { name: "bun", status: "ok", message: "/usr/local/bin/bun" },
      {
        name: "caddy (optional)",
        status: "warn",
        message: "Not found (optional)",
      },
      { name: "docker daemon", status: "ok", message: "Docker is running" },
      { name: "gateway tokens", status: "warn", message: "No active tokens" },
      { name: "dns:hack", status: "ok", message: "logs.hack -> 127.0.0.1" },
      {
        name: "env mode",
        status: "warn",
        message:
          "Legacy env format detected (.hack/hack.env.json). Run `hack doctor --migrate-env-config` to upgrade.",
      },
      {
        name: "tickets git",
        status: "ok",
        message: "Healthy (refs/hack/tickets)",
      },
    ],
  });

  expect(lines).toEqual([
    "Dependencies: warn - optional missing: caddy",
    "Runtime: warn - no active gateway tokens",
    "Resolver & DNS: ok",
    "Project & env: warn - legacy env format detected",
    "Sessions & tickets: ok",
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

test("recovery workflow lines scope repo-specific commands for doctor output", () => {
  const lines = buildRecoveryWorkflowLines({
    guidance: {
      temporaryBreakage: ["hack restart"],
      configurationRepair: ["hack doctor --fix"],
      followUp: ["gateway tokens: No active tokens"],
      verify: ["hack doctor"],
      capture: ["hack crash-capture --path <repo>"],
    },
    projectRoot: "/tmp/work repo",
    includeClassifyStep: true,
  });

  expect(lines).toEqual([
    "1. Classify:",
    "   - `hack doctor --path '/tmp/work repo'`",
    "2. Temporary breakage:",
    "   - `hack restart --path '/tmp/work repo'`",
    "3. Configuration repair:",
    "   - `hack doctor --fix --path '/tmp/work repo'`",
    "4. Manual follow-up:",
    "   - gateway tokens: No active tokens",
    "5. Verify:",
    "   - `hack doctor --path '/tmp/work repo'`",
    "6. If it still fails:",
    "   - `hack crash-capture --path '/tmp/work repo'`",
  ]);
});
