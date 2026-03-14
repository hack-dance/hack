import { expect, test } from "bun:test";

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

test("crash capture summary reports failures and ordered next steps", () => {
  const summary = buildCrashCaptureSummary({
    captureRoot: "/tmp/demo/.tmp/crash-capture-1",
    projectRoot: "/tmp/demo",
    results: [
      {
        name: "hack_doctor_project",
        cmd: ["hack", "doctor", "--path", "/tmp/demo"],
        exitCode: 1,
        file: "/tmp/demo/.tmp/crash-capture-1/hack_doctor_project.log",
        bytes: 120,
      },
      {
        name: "hack_global_status",
        cmd: ["hack", "global", "status", "--json"],
        exitCode: 0,
        file: "/tmp/demo/.tmp/crash-capture-1/hack_global_status.log",
        bytes: 80,
      },
    ],
    errors: ["hack_doctor_project failed (1)"],
  });

  expect(summary.commandCount).toBe(2);
  expect(summary.failureCount).toBe(1);
  expect(summary.failedCommands).toEqual(["hack_doctor_project"]);
  expect(summary.nextSteps).toEqual([
    "Run `hack doctor --path /tmp/demo` to classify restart versus repair work.",
    "If global proxy/runtime is down, run `hack global up`.",
    "If project host mappings are stale, run `hack restart --path /tmp/demo`.",
    "If doctor reports DNS/network/CA drift, run `hack doctor --fix --path /tmp/demo`.",
  ]);
});

test("crash capture readme points operators to the summary and raw logs", () => {
  const text = renderCrashCaptureReadme({
    captureRoot: "/tmp/demo/.tmp/crash-capture-1",
    projectRoot: "/tmp/demo",
    failedCommands: ["hack_doctor_project", "hack_daemon_logs"],
  });

  expect(text).toContain("Crash capture bundle");
  expect(text).toContain("summary.json");
  expect(text).toContain("commands.json");
  expect(text).toContain("hack_doctor_project");
  expect(text).toContain("hack_daemon_logs");
  expect(text).toContain("hack doctor --path /tmp/demo");
});
