import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HACK_AGENT_INTEGRATION_CONTENT_REVISION } from "../src/agents/integration-revision.ts";
import {
  assertDoctorOptionCompatibility,
  buildDoctorRemediationPlanLines,
  buildDoctorSummaryLines,
  buildDoctorSummaryStatusItems,
  inspectDoctorAgentIntegrations,
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

test("doctor rejects mutating repair flags combined with json", () => {
  expect(() =>
    assertDoctorOptionCompatibility({
      json: true,
      fix: true,
      migrateEnvConfig: false,
    })
  ).toThrow("--json cannot be combined with --fix");
  expect(() =>
    assertDoctorOptionCompatibility({
      json: true,
      fix: false,
      migrateEnvConfig: false,
    })
  ).not.toThrow();
});

test("doctor remediation plan mentions env migration when requested for a legacy project", async () => {
  const root = await createDoctorTestProject({ legacy: true });
  try {
    const lines = await buildDoctorRemediationPlanLines({
      startDir: root,
      migrateEnvConfig: true,
    });

    expect(lines).toEqual([
      "1. Review and repair global Docker networks, CoreDNS, CA, host TLS env, daemon drift, and agent integration freshness where needed.",
      "2. Reconcile lifecycle sessions and remove only ownership-proven sessions whose Compose instance is absent.",
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
      "1. Review and repair global Docker networks, CoreDNS, CA, host TLS env, daemon drift, and agent integration freshness where needed.",
      "2. Reconcile lifecycle sessions and remove only ownership-proven sessions whose Compose instance is absent.",
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

test("doctor guidance routes global agent drift to global sync", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "agent integrations",
        status: "warn",
        message:
          "Global guidance is stale (run: hack setup sync --global, reload the agent session)",
      },
    ],
  });

  expect(guidance.configurationRepair).toEqual(["hack setup sync --global"]);
});

test("doctor audits global agent guidance without a project", async () => {
  const home = await mkdtemp(join(tmpdir(), "hack-doctor-global-agents-"));
  const marker = `Content revision: \`${HACK_AGENT_INTEGRATION_CONTENT_REVISION}\``;
  const paths = [
    join(home, ".cursor", "rules", "hack.mdc"),
    join(home, ".codex", "skills", "hack-cli", "SKILL.md"),
    join(home, ".ai", "skills", "hack-cli", "SKILL.md"),
  ];
  try {
    for (const path of paths) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `${marker}\n`);
    }

    await expect(
      inspectDoctorAgentIntegrations({ projectRoot: null, homeDir: home })
    ).resolves.toEqual({ status: "current" });

    const legacySkillDir = join(home, ".codex", "skills", "hack-tickets");
    const legacySkill = join(legacySkillDir, "SKILL.md");
    await mkdir(legacySkillDir, { recursive: true });
    await writeFile(legacySkill, "---\nname: hack-tickets\n---\n");
    await expect(
      inspectDoctorAgentIntegrations({ projectRoot: null, homeDir: home })
    ).resolves.toEqual({ status: "stale" });
    await rm(legacySkillDir, { recursive: true, force: true });

    await writeFile(paths[0] ?? "", "stale\n");
    await expect(
      inspectDoctorAgentIntegrations({ projectRoot: null, homeDir: home })
    ).resolves.toEqual({ status: "stale" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor guidance routes runtime hygiene drift to projects prune", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "runtime hygiene",
        status: "warn",
        message:
          "1 missing registry entry; 2 orphaned runtime projects (run: hack projects prune)",
      },
    ],
  });

  expect(guidance.temporaryBreakage).toEqual(["hack projects prune"]);
  expect(guidance.configurationRepair).toEqual([]);
  expect(guidance.followUp).toEqual([]);
});

test("doctor guidance preserves project-scoped prune commands", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "runtime hygiene",
        status: "warn",
        message:
          "1 orphaned runtime project: msp--old (run: hack projects prune --project msp)",
      },
    ],
  });

  expect(guidance.temporaryBreakage).toEqual([
    "hack projects prune --project msp",
  ]);
});

test("doctor guidance routes stale lifecycle state to hack down", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "lifecycle hygiene",
        status: "warn",
        message:
          "1 stale lifecycle state entry; 2 orphaned lifecycle process groups (run: hack down)",
      },
    ],
  });

  expect(guidance.temporaryBreakage).toEqual(["hack down"]);
  expect(guidance.configurationRepair).toEqual([]);
  expect(guidance.followUp).toEqual([]);
});

test("doctor guidance routes owned orphan lifecycle sessions to doctor fix", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "lifecycle hygiene",
        status: "warn",
        message:
          "1 owned lifecycle session without a running instance (run: hack doctor --fix)",
      },
    ],
  });

  expect(guidance.temporaryBreakage).toEqual([]);
  expect(guidance.configurationRepair).toEqual(["hack doctor --fix"]);
  expect(guidance.followUp).toEqual([]);
});

test("doctor guidance routes env materialization drift to hack env materialize", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "env materialization",
        status: "warn",
        message:
          "1 env input file changed since materialization (run: hack env materialize)",
      },
    ],
  });

  expect(guidance.temporaryBreakage).toEqual([]);
  expect(guidance.configurationRepair).toEqual(["hack env materialize"]);
  expect(guidance.followUp).toEqual([]);
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

test("doctor guidance ignores skipped and non-project warnings", () => {
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "project",
        status: "warn",
        message: "Missing .hack/ (run 'hack init' in a repo)",
      },
      {
        name: "env mode",
        status: "warn",
        message: "Skipped (no .hack/ found)",
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
        name: "runtime hygiene",
        status: "warn",
        message:
          "1 missing registry entry; 1 orphaned runtime project (run: hack projects prune)",
      },
      {
        name: "lifecycle hygiene",
        status: "warn",
        message:
          "1 stale lifecycle state entry; 2 orphaned lifecycle process groups (run: hack down)",
      },
      {
        name: "env mode",
        status: "warn",
        message:
          "Legacy env format detected (.hack/hack.env.json). Run `hack doctor --migrate-env-config` to upgrade.",
      },
      {
        name: "env materialization",
        status: "warn",
        message:
          "1 env input file changed since materialization (run: hack env materialize)",
      },
    ],
  });

  expect(lines).toEqual([
    "Dependencies: ok",
    "Global runtime & agents: ok",
    "Resolver & DNS: ok",
    "Project & env: warn - runtime hygiene: 1 missing registry entry; 1 orphaned runtime project (run: hack projects prune); lifecycle hygiene: 1 stale lifecycle state entry; 2 orphaned lifecycle process groups (run: hack down); +2 more",
  ]);
});

test("doctor status summary separates health, counts, and wrapped detail", () => {
  const items = buildDoctorSummaryStatusItems({
    results: [
      { name: "bun", status: "ok", message: "/usr/local/bin/bun" },
      { name: "docker daemon", status: "ok", message: "Docker is running" },
      {
        name: "runtime hygiene",
        status: "warn",
        message:
          "3 projects have services stuck in Created (run: hack doctor --fix)",
      },
      {
        name: "lifecycle hygiene",
        status: "warn",
        message: "1 stale state entry; 1 session collision",
      },
    ],
  });

  expect(items).toEqual([
    {
      label: "Dependencies",
      status: "ok",
      meta: "1 checks",
      detail: undefined,
    },
    {
      label: "Global runtime & agents",
      status: "ok",
      meta: "1 checks",
      detail: undefined,
    },
    {
      label: "Project & env",
      status: "warn",
      meta: "2 warnings",
      detail:
        "runtime hygiene: 3 projects have services stuck in Created (run: hack doctor --fix); lifecycle hygiene: 1 stale state entry; 1 session collision",
    },
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

test("recovery next steps preserve already scoped projects prune", () => {
  const nextSteps = buildRecoveryNextSteps({
    guidance: {
      temporaryBreakage: ["hack projects prune --project msp", "hack down"],
      configurationRepair: ["hack doctor --fix", "hack env materialize"],
      followUp: [],
      verify: ["hack doctor"],
      capture: ["hack crash-capture --path <repo>"],
    },
    projectRoot: "/tmp/work repo",
    includeClassifyStep: true,
  });

  expect(nextSteps).toEqual([
    "Run `hack doctor --path '/tmp/work repo'` to classify restart versus repair work.",
    "Temporary breakage: `hack projects prune --project msp`.",
    "Temporary breakage: `hack down --path '/tmp/work repo'`.",
    "Configuration repair: `hack doctor --fix --path '/tmp/work repo'`.",
    "Configuration repair: `hack env materialize --path '/tmp/work repo'`.",
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
    "2. Fix now:",
    "   - `hack restart --path '/tmp/work repo'`",
    "3. Repair configuration:",
    "   - `hack doctor --fix --path '/tmp/work repo'`",
    "4. Investigate:",
    "   - gateway tokens: No active tokens",
    "5. Verify:",
    "   - `hack doctor --path '/tmp/work repo'`",
    "6. If it still fails:",
    "   - `hack crash-capture --path '/tmp/work repo'`",
  ]);
});
