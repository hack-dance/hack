import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  buildBaseCaptureCommands,
  buildCrashCaptureSummary,
  renderCrashCaptureReadme,
} from "../src/commands/crash-capture.ts";

test("crash capture includes doctor and proxy-relevant diagnostics", () => {
  const commands = buildBaseCaptureCommands({
    projectRoot: "/tmp/demo",
    logWindow: "45m",
  });

  expect(commands.map((command) => command.name)).toEqual(
    expect.arrayContaining([
      "hack_doctor_project",
      "hack_global_status",
      "hack_daemon_logs",
      "docker_network_inspect_hack-dev",
      "docker_network_inspect_hack-logging",
    ])
  );

  const processSnapshot = commands.find(
    (command) => command.name === "ps_orbstack_processes"
  );
  expect(processSnapshot?.cmd.join(" ")).not.toContain("rg ");
});

test("crash capture summary restores doctor recovery guidance from warning-only doctor logs", async () => {
  const captureRoot = await mkdtemp(resolve(tmpdir(), "hack-crash-capture-"));
  const doctorLog = resolve(captureRoot, "hack_doctor_project.log");
  await Bun.write(
    doctorLog,
    [
      "$ hack doctor --path /tmp/demo",
      "exit_code=1",
      "",
      "Temporary breakage:",
      "- hack restart",
      "",
      "Configuration repair:",
      "- hack doctor --fix",
      "",
      "Manual follow-up:",
      "- gateway tokens: No active tokens (run: hack x gateway token-create)",
    ].join("\n")
  );

  try {
    const summary = await buildCrashCaptureSummary({
      captureRoot,
      projectRoot: "/tmp/demo",
      results: [
        {
          name: "hack_doctor_project",
          cmd: ["hack", "doctor", "--path", "/tmp/demo"],
          exitCode: 0,
          file: doctorLog,
          bytes: 120,
        },
        {
          name: "hack_global_status",
          cmd: ["hack", "global", "status", "--json"],
          exitCode: 0,
          file: resolve(captureRoot, "hack_global_status.log"),
          bytes: 80,
        },
      ],
      errors: ["hack_doctor_project failed (1)"],
    });

    expect(summary.commandCount).toBe(2);
    expect(summary.failureCount).toBe(0);
    expect(summary.failedCommands).toEqual([]);
    expect(summary.recovery.temporaryBreakage).toEqual(["hack restart"]);
    expect(summary.recovery.configurationRepair).toEqual(["hack doctor --fix"]);
    expect(summary.recovery.followUp).toEqual([]);
    expect(summary.nextSteps).toEqual([
      "Run `hack doctor --path /tmp/demo` to classify restart versus repair work.",
      "Temporary breakage: `hack restart --path /tmp/demo`.",
      "Configuration repair: `hack doctor --fix --path /tmp/demo`.",
      "Verify with `hack doctor --path /tmp/demo`.",
      "If it still fails, run `hack crash-capture --path /tmp/demo` again after the next repro.",
    ]);
  } finally {
    await rm(captureRoot, { force: true, recursive: true });
  }
});

test("crash capture summary infers stale daemon recovery from captured failures", async () => {
  const captureRoot = await mkdtemp(resolve(tmpdir(), "hack-crash-capture-"));
  const globalStatusLog = resolve(captureRoot, "hack_global_status.log");
  const daemonLog = resolve(captureRoot, "hack_daemon_status.log");
  await Bun.write(
    globalStatusLog,
    [
      "$ hack global status --json",
      "exit_code=0",
      "",
      "## stdout",
      JSON.stringify({
        caddy: { ok: false, error: "caddy down", services: [] },
        logging: { ok: true, error: null, services: [] },
        networks: { ok: true, missing: [], networks: [] },
        gateway: {
          gateway_enabled: false,
          warnings: [],
          exposures: [],
          tokens: [],
          tokens_active: 0,
          tokens_revoked: 0,
          tokens_write: 0,
          tokens_read: 0,
          config_path: "/tmp/global.json",
          gateway_url: "http://127.0.0.1:7777",
          gateway_bind: "127.0.0.1",
          gateway_port: 7777,
          allow_writes: false,
          gateway_projects_enabled: 0,
        },
        summary: {
          ok: false,
          caddy_ok: false,
          logging_ok: true,
          networks_ok: true,
          gateway_enabled: false,
        },
      }),
      "",
      "## stderr",
    ].join("\n")
  );
  await Bun.write(
    daemonLog,
    [
      "$ hack daemon status",
      "exit_code=1",
      "",
      "hackd not running (stale pid/socket; run: hack daemon clear)",
    ].join("\n")
  );

  try {
    const summary = await buildCrashCaptureSummary({
      captureRoot,
      projectRoot: "/tmp/demo",
      results: [
        {
          name: "hack_global_status",
          cmd: ["hack", "global", "status", "--json"],
          exitCode: 0,
          file: globalStatusLog,
          bytes: 80,
        },
        {
          name: "hack_daemon_status",
          cmd: ["hack", "daemon", "status"],
          exitCode: 1,
          file: daemonLog,
          bytes: 80,
        },
      ],
      errors: [],
    });

    expect(summary.recovery.temporaryBreakage).toEqual([
      "hack global up",
      "hack daemon clear",
      "hack daemon start",
    ]);
    expect(summary.recovery.configurationRepair).toEqual([]);
    expect(summary.nextSteps).toEqual([
      "Run `hack doctor --path /tmp/demo` to classify restart versus repair work.",
      "Temporary breakage: `hack global up`.",
      "Temporary breakage: `hack daemon clear`.",
      "Temporary breakage: `hack daemon start`.",
      "Verify with `hack doctor --path /tmp/demo`.",
      "If it still fails, run `hack crash-capture --path /tmp/demo` again after the next repro.",
    ]);
  } finally {
    await rm(captureRoot, { force: true, recursive: true });
  }
});

test("crash capture summary restores projects prune guidance from doctor logs", async () => {
  const captureRoot = await mkdtemp(resolve(tmpdir(), "hack-crash-capture-"));
  const doctorLog = resolve(captureRoot, "hack_doctor_project.log");
  await Bun.write(
    doctorLog,
    [
      "$ hack doctor --path /tmp/demo",
      "exit_code=1",
      "",
      "Temporary breakage:",
      "- hack projects prune",
    ].join("\n")
  );

  try {
    const summary = await buildCrashCaptureSummary({
      captureRoot,
      projectRoot: "/tmp/demo",
      results: [
        {
          name: "hack_doctor_project",
          cmd: ["hack", "doctor", "--path", "/tmp/demo"],
          exitCode: 0,
          file: doctorLog,
          bytes: 80,
        },
      ],
      errors: ["hack_doctor_project failed (1)"],
    });

    expect(summary.recovery.temporaryBreakage).toEqual(["hack projects prune"]);
    expect(summary.recovery.configurationRepair).toEqual([]);
    expect(summary.nextSteps).toEqual([
      "Run `hack doctor --path /tmp/demo` to classify restart versus repair work.",
      "Temporary breakage: `hack projects prune`.",
      "Verify with `hack doctor --path /tmp/demo`.",
      "If it still fails, run `hack crash-capture --path /tmp/demo` again after the next repro.",
    ]);
  } finally {
    await rm(captureRoot, { force: true, recursive: true });
  }
});

test("crash capture summary restores lifecycle cleanup guidance from doctor logs", async () => {
  const captureRoot = await mkdtemp(resolve(tmpdir(), "hack-crash-capture-"));
  const doctorLog = resolve(captureRoot, "hack_doctor_project.log");
  await Bun.write(
    doctorLog,
    [
      "$ hack doctor --path /tmp/demo",
      "exit_code=1",
      "",
      "Temporary breakage:",
      "- hack down",
    ].join("\n")
  );

  try {
    const summary = await buildCrashCaptureSummary({
      captureRoot,
      projectRoot: "/tmp/demo",
      results: [
        {
          name: "hack_doctor_project",
          cmd: ["hack", "doctor", "--path", "/tmp/demo"],
          exitCode: 0,
          file: doctorLog,
          bytes: 80,
        },
      ],
      errors: ["hack_doctor_project failed (1)"],
    });

    expect(summary.recovery.temporaryBreakage).toEqual(["hack down"]);
    expect(summary.recovery.configurationRepair).toEqual([]);
    expect(summary.nextSteps).toEqual([
      "Run `hack doctor --path /tmp/demo` to classify restart versus repair work.",
      "Temporary breakage: `hack down --path /tmp/demo`.",
      "Verify with `hack doctor --path /tmp/demo`.",
      "If it still fails, run `hack crash-capture --path /tmp/demo` again after the next repro.",
    ]);
  } finally {
    await rm(captureRoot, { force: true, recursive: true });
  }
});

test("crash capture summary restores env materialization guidance from doctor logs", async () => {
  const captureRoot = await mkdtemp(resolve(tmpdir(), "hack-crash-capture-"));
  const doctorLog = resolve(captureRoot, "hack_doctor_project.log");
  await Bun.write(
    doctorLog,
    [
      "$ hack doctor --path /tmp/demo",
      "exit_code=1",
      "",
      "Configuration repair:",
      "- hack env materialize",
    ].join("\n")
  );

  try {
    const summary = await buildCrashCaptureSummary({
      captureRoot,
      projectRoot: "/tmp/demo",
      results: [
        {
          name: "hack_doctor_project",
          cmd: ["hack", "doctor", "--path", "/tmp/demo"],
          exitCode: 0,
          file: doctorLog,
          bytes: 80,
        },
      ],
      errors: ["hack_doctor_project failed (1)"],
    });

    expect(summary.recovery.temporaryBreakage).toEqual([]);
    expect(summary.recovery.configurationRepair).toEqual([
      "hack env materialize",
    ]);
    expect(summary.nextSteps).toEqual([
      "Run `hack doctor --path /tmp/demo` to classify restart versus repair work.",
      "Configuration repair: `hack env materialize --path /tmp/demo`.",
      "Verify with `hack doctor --path /tmp/demo`.",
      "If it still fails, run `hack crash-capture --path /tmp/demo` again after the next repro.",
    ]);
  } finally {
    await rm(captureRoot, { force: true, recursive: true });
  }
});

test("crash capture keeps unknown status failures as manual follow-up", async () => {
  const captureRoot = await mkdtemp(resolve(tmpdir(), "hack-crash-capture-"));
  const globalStatusLog = resolve(captureRoot, "hack_global_status.log");
  const daemonLog = resolve(captureRoot, "hack_daemon_status.log");
  await Bun.write(
    globalStatusLog,
    [
      "$ hack global status --json",
      "exit_code=1",
      "",
      "permission denied",
    ].join("\n")
  );
  await Bun.write(
    daemonLog,
    ["$ hack daemon status", "exit_code=1", "", "internal rpc error"].join("\n")
  );

  try {
    const summary = await buildCrashCaptureSummary({
      captureRoot,
      projectRoot: "/tmp/demo",
      results: [
        {
          name: "hack_global_status",
          cmd: ["hack", "global", "status", "--json"],
          exitCode: 1,
          file: globalStatusLog,
          bytes: 32,
        },
        {
          name: "hack_daemon_status",
          cmd: ["hack", "daemon", "status"],
          exitCode: 1,
          file: daemonLog,
          bytes: 24,
        },
      ],
      errors: [],
    });

    expect(summary.recovery.temporaryBreakage).toEqual([]);
    expect(summary.recovery.configurationRepair).toEqual([]);
    expect(summary.recovery.followUp).toEqual([
      "hack global status: Review hack_global_status.log for detailed recovery guidance",
      "hack daemon status: Review hack_daemon_status.log for detailed recovery guidance",
    ]);
    expect(summary.nextSteps).toEqual([
      "Run `hack doctor --path /tmp/demo` to classify restart versus repair work.",
      "Manual follow-up: hack global status: Review hack_global_status.log for detailed recovery guidance",
      "Manual follow-up: hack daemon status: Review hack_daemon_status.log for detailed recovery guidance",
      "Verify with `hack doctor --path /tmp/demo`.",
      "If it still fails, run `hack crash-capture --path /tmp/demo` again after the next repro.",
    ]);
  } finally {
    await rm(captureRoot, { force: true, recursive: true });
  }
});

test("crash capture readme points operators to the summary and raw logs", () => {
  const text = renderCrashCaptureReadme({
    captureRoot: "/tmp/demo/.tmp/crash-capture-1",
    projectRoot: "/tmp/demo",
    recovery: {
      temporaryBreakage: [],
      configurationRepair: [],
      followUp: [],
      verify: ["hack doctor"],
      capture: ["hack crash-capture --path <repo>"],
    },
    failedCommands: ["hack_doctor_project", "hack_daemon_logs"],
  });

  expect(text).toContain("Crash capture bundle");
  expect(text).toContain("summary.json");
  expect(text).toContain("commands.json");
  expect(text).toContain("hack_doctor_project");
  expect(text).toContain("hack_daemon_logs");
  expect(text).toContain("hack doctor --path /tmp/demo");
  expect(text).toContain("Verify:");
  expect(text).toContain("- `hack doctor --path /tmp/demo`");
  expect(text).toContain("If it still fails:");
  expect(text).toContain("- `hack crash-capture --path /tmp/demo`");
});

test("crash capture readme groups inferred restart actions into sections", () => {
  const text = renderCrashCaptureReadme({
    captureRoot: "/tmp/demo/.tmp/crash-capture-1",
    projectRoot: "/tmp/demo",
    recovery: {
      temporaryBreakage: ["hack global up", "hack daemon start"],
      configurationRepair: [],
      followUp: [],
      verify: ["hack doctor"],
      capture: ["hack crash-capture --path <repo>"],
    },
    failedCommands: ["hack_global_status", "hack_daemon_status"],
  });

  expect(text).toContain("Temporary breakage:");
  expect(text).toContain("- `hack global up`");
  expect(text).toContain("- `hack daemon start`");
  expect(text).toContain("Verify:");
  expect(text).toContain("If it still fails:");
});

test("crash capture readme quotes repo paths in recovery commands", () => {
  const text = renderCrashCaptureReadme({
    captureRoot: "/tmp/demo/.tmp/crash-capture-1",
    projectRoot: "/tmp/work repo",
    recovery: {
      temporaryBreakage: ["hack restart"],
      configurationRepair: ["hack doctor --fix"],
      followUp: [],
      verify: ["hack doctor"],
      capture: ["hack crash-capture --path <repo>"],
    },
    failedCommands: [],
  });

  expect(text).toContain("`hack doctor --path '/tmp/work repo'`");
  expect(text).toContain("`hack restart --path '/tmp/work repo'`");
  expect(text).toContain("`hack doctor --fix --path '/tmp/work repo'`");
  expect(text).toContain("`hack crash-capture --path '/tmp/work repo'`");
});
