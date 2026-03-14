import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optPath } from "../cli/options.ts";
import {
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_LOGGING_NETWORK,
} from "../constants.ts";
import { findProjectContext, readProjectConfig } from "../lib/project.ts";
import { exec } from "../lib/shell.ts";
import { display } from "../ui/display.ts";
import {
  buildDoctorRecoveryGuidance,
  buildRecoveryNextSteps,
  type DoctorRecoveryGuidance,
  type RecoveryCheckResult,
  scopeDoctorRecoveryGuidance,
} from "./recovery-guidance.ts";

const DEFAULT_LOG_WINDOW = "45m";
const DEFAULT_DOCKER_LOG_LINES = 300;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const MAX_LOG_LINES = 2500;

const optCaptureSince = defineOption({
  name: "since",
  type: "string",
  long: "--since",
  valueHint: "<duration>",
  description: "Look-back window for system logs (for example: 30m, 2h)",
} as const);

const options = [optPath, optCaptureSince] as const;
const positionals = [] as const;

const crashCaptureSpec = defineCommand({
  name: "crash-capture",
  summary:
    "Capture OrbStack/system/docker diagnostics into .tmp for post-failure triage",
  group: "Diagnostics",
  description:
    "Collects structured snapshots after a runtime failure: hack status/logs, docker state, OrbStack process details, and filtered macOS unified logs.",
  options,
  positionals,
  subcommands: [],
  expandInRootHelp: true,
} as const);

type CaptureCommandSpec = {
  readonly name: string;
  readonly cmd: readonly string[];
  readonly optional?: boolean;
};

type CaptureCommandResult = {
  readonly name: string;
  readonly cmd: readonly string[];
  readonly exitCode: number;
  readonly file: string;
  readonly bytes: number;
};

type CrashCaptureSummary = {
  readonly captureRoot: string;
  readonly projectRoot: string | null;
  readonly commandCount: number;
  readonly failureCount: number;
  readonly failedCommands: readonly string[];
  readonly errors: readonly string[];
  readonly recovery: DoctorRecoveryGuidance;
  readonly nextSteps: readonly string[];
};

type CaptureMetadata = {
  readonly capturedAt: string;
  readonly platform: string;
  readonly arch: string;
  readonly cwd: string;
  readonly captureRoot: string;
  readonly startDir: string;
  readonly logWindow: string;
  readonly projectRoot: string | null;
  readonly projectName: string | null;
  readonly composeProject: string | null;
};

const handleCrashCapture: CommandHandlerFor<typeof crashCaptureSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const startDir = resolve(args.options.path ?? process.cwd());
  const logWindow = normalizeLogWindow({ value: args.options.since });
  const project = await findProjectContext(startDir);
  const captureRoot = await createCaptureRoot({
    baseDir: project
      ? resolve(project.projectRoot, ".tmp")
      : resolve(startDir, ".tmp"),
  });

  const projectName = await resolveProjectName({
    projectRoot: project?.projectRoot ?? null,
  });
  const composeProject = await resolveComposeProject({
    projectRoot: project?.projectRoot ?? null,
  });

  const metadata: CaptureMetadata = {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    cwd: ctx.cwd,
    captureRoot,
    startDir,
    logWindow,
    projectRoot: project?.projectRoot ?? null,
    projectName,
    composeProject,
  };
  await writeJsonFile({
    path: resolve(captureRoot, "metadata.json"),
    value: metadata,
  });

  const results: CaptureCommandResult[] = [];
  const errors: string[] = [];

  const baseCommands = buildBaseCaptureCommands({
    projectRoot: project?.projectRoot ?? null,
    logWindow,
  });
  for (const command of baseCommands) {
    const result = await runCaptureCommand({
      captureRoot,
      command,
    });
    if (result.ok) {
      results.push(result.value);
    } else if (!command.optional) {
      errors.push(result.error);
    }
  }

  const containerNames = await resolveProjectContainerNames({
    composeProject,
  });
  await writeJsonFile({
    path: resolve(captureRoot, "containers.json"),
    value: { composeProject, containers: containerNames },
  });

  for (const name of containerNames) {
    const inspect = await runCaptureCommand({
      captureRoot,
      command: {
        name: `docker_inspect_${name}`,
        cmd: ["docker", "inspect", name],
        optional: true,
      },
    });
    if (inspect.ok) {
      results.push(inspect.value);
    }

    const logs = await runCaptureCommand({
      captureRoot,
      command: {
        name: `docker_logs_${name}`,
        cmd: [
          "docker",
          "logs",
          "--timestamps",
          "--tail",
          String(DEFAULT_DOCKER_LOG_LINES),
          name,
        ],
        optional: true,
      },
    });
    if (logs.ok) {
      results.push(logs.value);
    }
  }

  await writeJsonFile({
    path: resolve(captureRoot, "commands.json"),
    value: {
      results,
      errors,
    },
  });

  const summary = await buildCrashCaptureSummary({
    captureRoot,
    projectRoot: project?.projectRoot ?? null,
    results,
    errors,
  });
  await writeJsonFile({
    path: resolve(captureRoot, "summary.json"),
    value: summary,
  });
  await Bun.write(
    resolve(captureRoot, "README.txt"),
    renderCrashCaptureReadme({
      captureRoot,
      projectRoot: project?.projectRoot ?? null,
      recovery: summary.recovery,
      failedCommands: summary.failedCommands,
    }),
    { createPath: true }
  );

  await display.kv({
    title: "Crash capture complete",
    entries: [
      ["output", captureRoot],
      ["commands", String(results.length)],
      ["errors", String(errors.length)],
      ["containers", String(containerNames.length)],
    ],
  });

  if (errors.length > 0) {
    await display.panel({
      title: "Capture warnings",
      lines: errors,
      tone: "warn",
    });
  }

  return errors.length > 0 ? 1 : 0;
};

export const crashCaptureCommand = withHandler(
  crashCaptureSpec,
  handleCrashCapture
);

function normalizeLogWindow(input: {
  readonly value: string | undefined;
}): string {
  const value = input.value?.trim();
  return value && value.length > 0 ? value : DEFAULT_LOG_WINDOW;
}

async function createCaptureRoot(input: {
  readonly baseDir: string;
}): Promise<string> {
  await mkdir(input.baseDir, { recursive: true });
  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  const directory = resolve(input.baseDir, `crash-capture-${timestamp}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function resolveProjectName(input: {
  readonly projectRoot: string | null;
}): Promise<string | null> {
  if (!input.projectRoot) {
    return null;
  }
  const project = await findProjectContext(input.projectRoot);
  if (!project) {
    return basename(input.projectRoot);
  }
  const config = await readProjectConfig(project);
  return config.name?.trim() || basename(input.projectRoot);
}

async function resolveComposeProject(input: {
  readonly projectRoot: string | null;
}): Promise<string | null> {
  if (!input.projectRoot) {
    return null;
  }
  const command = await exec(
    ["hack", "ps", "--json", "--path", input.projectRoot],
    { stdin: "ignore" }
  );
  if (command.exitCode !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(command.stdout) as Record<string, unknown>;
    const composeProject = parsed.composeProject;
    return typeof composeProject === "string" &&
      composeProject.trim().length > 0
      ? composeProject.trim()
      : null;
  } catch {
    return null;
  }
}

export function buildBaseCaptureCommands(input: {
  readonly projectRoot: string | null;
  readonly logWindow: string;
}): readonly CaptureCommandSpec[] {
  const projectCommands: CaptureCommandSpec[] = input.projectRoot
    ? [
        {
          name: "hack_doctor_project",
          cmd: ["hack", "doctor", "--path", input.projectRoot],
          optional: true,
        },
        {
          name: "hack_ps_project",
          cmd: ["hack", "ps", "--json", "--path", input.projectRoot],
          optional: true,
        },
        {
          name: "hack_logs_project",
          cmd: [
            "hack",
            "logs",
            "--json",
            "--no-follow",
            "--path",
            input.projectRoot,
          ],
          optional: true,
        },
      ]
    : [];

  const orbStackCommands: CaptureCommandSpec[] =
    process.platform === "darwin"
      ? [
          {
            name: "mac_log_orbstack",
            cmd: [
              "/bin/sh",
              "-lc",
              `/usr/bin/log show --last '${input.logWindow}' --style compact --predicate 'process CONTAINS[c] "OrbStack" OR process CONTAINS[c] "OrbStack Helper"' | tail -n ${MAX_LOG_LINES}`,
            ],
            optional: true,
          },
          {
            name: "mac_log_kernel_container_events",
            cmd: [
              "/bin/sh",
              "-lc",
              `/usr/bin/log show --last '${input.logWindow}' --style compact --predicate 'process == "kernel" AND (eventMessage CONTAINS[c] "veth" OR eventMessage CONTAINS[c] "bridge" OR eventMessage CONTAINS[c] "killed" OR eventMessage CONTAINS[c] "SIGKILL")' | tail -n ${MAX_LOG_LINES}`,
            ],
            optional: true,
          },
        ]
      : [];

  return [
    { name: "hack_version", cmd: ["hack", "version"], optional: true },
    {
      name: "hack_daemon_status",
      cmd: ["hack", "daemon", "status"],
      optional: true,
    },
    { name: "docker_version", cmd: ["docker", "version"], optional: true },
    { name: "docker_info", cmd: ["docker", "info"], optional: true },
    {
      name: "docker_ps_all",
      cmd: [
        "docker",
        "ps",
        "-a",
        "--format",
        "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.RunningFor}}",
      ],
      optional: true,
    },
    {
      name: "docker_system_df",
      cmd: ["docker", "system", "df"],
      optional: true,
    },
    {
      name: "hack_daemon_logs",
      cmd: ["hack", "daemon", "logs", "--no-follow"],
      optional: true,
    },
    {
      name: "hack_global_status",
      cmd: ["hack", "global", "status", "--json"],
      optional: true,
    },
    {
      name: "hack_global_logs_caddy",
      cmd: ["hack", "global", "logs", "caddy", "--no-follow", "--tail", "200"],
      optional: true,
    },
    {
      name: `docker_network_inspect_${DEFAULT_INGRESS_NETWORK}`,
      cmd: ["docker", "network", "inspect", DEFAULT_INGRESS_NETWORK],
      optional: true,
    },
    {
      name: `docker_network_inspect_${DEFAULT_LOGGING_NETWORK}`,
      cmd: ["docker", "network", "inspect", DEFAULT_LOGGING_NETWORK],
      optional: true,
    },
    {
      name: "ps_orbstack_processes",
      cmd: [
        "/bin/sh",
        "-lc",
        "ps -Ao pid,ppid,etime,command | grep -iE 'orbstack|vz|docker' || true",
      ],
      optional: true,
    },
    ...projectCommands,
    ...orbStackCommands,
  ];
}

async function resolveProjectContainerNames(input: {
  readonly composeProject: string | null;
}): Promise<readonly string[]> {
  if (!input.composeProject) {
    return [];
  }
  const command = await exec(
    [
      "docker",
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${input.composeProject}`,
      "--format",
      "{{.Names}}",
    ],
    { stdin: "ignore" }
  );
  if (command.exitCode !== 0) {
    return [];
  }
  const names = command.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(names)];
}

async function runCaptureCommand(input: {
  readonly captureRoot: string;
  readonly command: CaptureCommandSpec;
}): Promise<
  | { readonly ok: true; readonly value: CaptureCommandResult }
  | { readonly ok: false; readonly error: string }
> {
  const output = await exec(input.command.cmd, { stdin: "ignore" });
  const file = captureFilePath({
    captureRoot: input.captureRoot,
    commandName: input.command.name,
  });
  const serialized = serializeCommandOutput({
    command: input.command.cmd,
    exitCode: output.exitCode,
    stdout: output.stdout,
    stderr: output.stderr,
  });
  const bounded = boundTextSize({
    text: serialized,
    maxBytes: MAX_COMMAND_OUTPUT_BYTES,
  });
  await Bun.write(file, bounded, { createPath: true });

  if (output.exitCode !== 0 && !input.command.optional) {
    return {
      ok: false,
      error: `${input.command.name} failed (${output.exitCode})`,
    };
  }

  return {
    ok: true,
    value: {
      name: input.command.name,
      cmd: input.command.cmd,
      exitCode: output.exitCode,
      file,
      bytes: Buffer.byteLength(bounded, "utf8"),
    },
  };
}

function captureFilePath(input: {
  readonly captureRoot: string;
  readonly commandName: string;
}): string {
  return resolve(
    input.captureRoot,
    `${sanitizeFilename(input.commandName)}.log`
  );
}

function sanitizeFilename(value: string): string {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9.-]+/g, "-");
  return (
    normalized.replaceAll(/-+/g, "-").replaceAll(/^-|-$/g, "") || "capture"
  );
}

function serializeCommandOutput(input: {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): string {
  return [
    `$ ${input.command.join(" ")}`,
    `exit_code=${input.exitCode}`,
    "",
    "## stdout",
    input.stdout.trimEnd(),
    "",
    "## stderr",
    input.stderr.trimEnd(),
    "",
  ].join("\n");
}

function boundTextSize(input: {
  readonly text: string;
  readonly maxBytes: number;
}): string {
  const bytes = Buffer.byteLength(input.text, "utf8");
  if (bytes <= input.maxBytes) {
    return input.text;
  }
  const tail = input.text.slice(
    Math.max(0, input.text.length - input.maxBytes)
  );
  return [`<<truncated: kept last ${input.maxBytes} bytes>>`, "", tail].join(
    "\n"
  );
}

async function writeJsonFile(input: {
  readonly path: string;
  readonly value: unknown;
}): Promise<void> {
  await Bun.write(input.path, `${JSON.stringify(input.value, null, 2)}\n`, {
    createPath: true,
  });
}

export async function buildCrashCaptureSummary(input: {
  readonly captureRoot: string;
  readonly projectRoot: string | null;
  readonly results: readonly CaptureCommandResult[];
  readonly errors: readonly string[];
}): Promise<CrashCaptureSummary> {
  const failedCommands = input.results
    .filter((result) => result.exitCode !== 0)
    .map((result) => result.name);
  const recovery = buildDoctorRecoveryGuidance({
    results: await inferRecoveryCheckResults({ results: input.results }),
  });

  return {
    captureRoot: input.captureRoot,
    projectRoot: input.projectRoot,
    commandCount: input.results.length,
    failureCount: failedCommands.length,
    failedCommands,
    errors: input.errors,
    recovery,
    nextSteps: buildRecoveryNextSteps({
      guidance: recovery,
      projectRoot: input.projectRoot,
      includeClassifyStep: true,
    }),
  };
}

async function inferRecoveryCheckResults(input: {
  readonly results: readonly CaptureCommandResult[];
}): Promise<readonly RecoveryCheckResult[]> {
  const inferred: RecoveryCheckResult[] = [];
  const seen = new Set<string>();

  for (const result of input.results) {
    if (!shouldInferRecoveryFromResult({ result })) {
      continue;
    }

    const checkResults = await inferRecoveryCheckResult({ result });
    for (const checkResult of checkResults) {
      pushRecoveryCheckResult({
        target: inferred,
        seen,
        result: checkResult,
      });
    }
  }

  return inferred;
}

async function inferRecoveryCheckResult(input: {
  readonly result: CaptureCommandResult;
}): Promise<readonly RecoveryCheckResult[]> {
  const inferred: RecoveryCheckResult[] = [];
  const seen = new Set<string>();
  const output = await readCaptureOutput({
    path: input.result.file,
  });

  if (output) {
    pushRecoveryCheckResults({
      target: inferred,
      seen,
      results: inferRecoveryCheckResultsFromOutput({ output }),
    });
  }

  if (
    input.result.name === "hack_global_status" &&
    input.result.exitCode !== 0 &&
    inferred.length === 0
  ) {
    pushRecoveryCheckResult({
      target: inferred,
      seen,
      result: buildRecoveryFollowUpResult({
        name: "hack global status",
        logFile: "hack_global_status.log",
      }),
    });
  }

  if (
    input.result.name === "hack_daemon_status" &&
    input.result.exitCode !== 0 &&
    inferred.length === 0
  ) {
    pushRecoveryCheckResult({
      target: inferred,
      seen,
      result: buildRecoveryFollowUpResult({
        name: "hack daemon status",
        logFile: "hack_daemon_status.log",
      }),
    });
  }

  if (
    input.result.name === "hack_doctor_project" &&
    input.result.exitCode !== 0 &&
    inferred.length === 0
  ) {
    pushRecoveryCheckResult({
      target: inferred,
      seen,
      result: buildRecoveryFollowUpResult({
        name: "doctor",
        logFile: "hack_doctor_project.log",
      }),
    });
  }

  return inferred;
}

async function readCaptureOutput(input: {
  readonly path: string;
}): Promise<string | null> {
  try {
    return await Bun.file(input.path).text();
  } catch {
    return null;
  }
}

function shouldInferRecoveryFromResult(input: {
  readonly result: CaptureCommandResult;
}): boolean {
  if (input.result.name === "hack_doctor_project") {
    return true;
  }

  return input.result.exitCode !== 0;
}

function inferRecoveryCheckResultsFromOutput(input: {
  readonly output: string;
}): readonly RecoveryCheckResult[] {
  const inferred: RecoveryCheckResult[] = [];

  if (input.output.includes("hack global up")) {
    inferred.push({
      name: "proxy ports",
      status: "warn",
      message: "Captured recovery guidance (run: hack global up)",
    });
  }

  if (input.output.includes("hack restart")) {
    inferred.push({
      name: "caddy hosts",
      status: "warn",
      message: "Captured recovery guidance (run: hack restart)",
    });
  }

  if (input.output.includes("hack daemon clear")) {
    inferred.push({
      name: "daemon",
      status: "warn",
      message: "Captured daemon status failure (run: hack daemon clear)",
    });
  } else if (input.output.includes("hack daemon start")) {
    inferred.push({
      name: "daemon",
      status: "warn",
      message: "Captured daemon status failure (run: hack daemon start)",
    });
  }

  if (input.output.includes("hack doctor --fix")) {
    inferred.push({
      name: "coredns forwarding",
      status: "warn",
      message:
        "Captured configuration repair guidance (run: hack doctor --fix)",
    });
  }

  for (const item of extractManualFollowUpItems({ output: input.output })) {
    const followUp = parseManualFollowUpItem({ item });
    inferred.push({
      name: followUp.name,
      status: "warn",
      message: followUp.message,
    });
  }

  return inferred;
}

function extractManualFollowUpItems(input: {
  readonly output: string;
}): readonly string[] {
  const lines = input.output.split("\n");
  const items: string[] = [];
  let inManualFollowUp = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "Manual follow-up:") {
      inManualFollowUp = true;
      continue;
    }

    if (!inManualFollowUp) {
      continue;
    }

    if (trimmed.length === 0) {
      break;
    }

    if (trimmed.endsWith(":") && !trimmed.startsWith("- ")) {
      break;
    }

    if (trimmed.startsWith("- ")) {
      items.push(trimmed.slice(2));
    }
  }

  return items;
}

function parseManualFollowUpItem(input: { readonly item: string }): {
  readonly name: string;
  readonly message: string;
} {
  const separatorIndex = input.item.indexOf(": ");
  if (separatorIndex === -1) {
    return {
      name: "doctor follow-up",
      message: input.item,
    };
  }

  return {
    name: input.item.slice(0, separatorIndex),
    message: input.item.slice(separatorIndex + 2),
  };
}

function buildRecoveryFollowUpResult(input: {
  readonly name: string;
  readonly logFile: string;
}): RecoveryCheckResult {
  return {
    name: input.name,
    status: "warn",
    message: `Review ${input.logFile} for detailed recovery guidance`,
  };
}

function pushRecoveryCheckResults(input: {
  readonly target: RecoveryCheckResult[];
  readonly seen: Set<string>;
  readonly results: readonly RecoveryCheckResult[];
}): void {
  for (const result of input.results) {
    pushRecoveryCheckResult({
      target: input.target,
      seen: input.seen,
      result,
    });
  }
}

function pushRecoveryCheckResult(input: {
  readonly target: RecoveryCheckResult[];
  readonly seen: Set<string>;
  readonly result: RecoveryCheckResult;
}): void {
  const key = `${input.result.name}\u0000${input.result.message}`;
  if (input.seen.has(key)) {
    return;
  }

  input.seen.add(key);
  input.target.push(input.result);
}

export function renderCrashCaptureReadme(input: {
  readonly captureRoot: string;
  readonly projectRoot: string | null;
  readonly recovery: DoctorRecoveryGuidance;
  readonly failedCommands: readonly string[];
}): string {
  const projectRoot = input.projectRoot ?? "<repo>";
  const failedCommands =
    input.failedCommands.length > 0
      ? input.failedCommands.map((command) => `- ${command}`)
      : ["- none"];

  return [
    "Crash capture bundle",
    "",
    `Location: ${input.captureRoot}`,
    `Project root: ${projectRoot}`,
    "",
    "Read in this order:",
    "- summary.json",
    "- commands.json",
    "- *.log command captures",
    "",
    "Failed commands:",
    ...failedCommands,
    "",
    "Suggested recovery flow:",
    ...renderRecoveryWorkflow({
      guidance: input.recovery,
      projectRoot: input.projectRoot,
    }),
  ].join("\n");
}

function renderRecoveryWorkflow(input: {
  readonly guidance: DoctorRecoveryGuidance;
  readonly projectRoot: string | null;
}): readonly string[] {
  const scoped = scopeDoctorRecoveryGuidance({
    guidance: input.guidance,
    projectRoot: input.projectRoot,
  });
  const projectRoot = input.projectRoot ?? "<repo>";
  const lines = ["1. Classify:", `   - \`hack doctor --path ${projectRoot}\``];
  let stepNumber = 2;

  if (scoped.temporaryBreakage.length > 0) {
    lines.push(`${stepNumber}. Temporary breakage:`);
    for (const command of scoped.temporaryBreakage) {
      lines.push(`   - \`${command}\``);
    }
    stepNumber += 1;
  }

  if (scoped.configurationRepair.length > 0) {
    lines.push(`${stepNumber}. Configuration repair:`);
    for (const command of scoped.configurationRepair) {
      lines.push(`   - \`${command}\``);
    }
    stepNumber += 1;
  }

  if (scoped.followUp.length > 0) {
    lines.push(`${stepNumber}. Manual follow-up:`);
    for (const item of scoped.followUp) {
      lines.push(`   - ${item}`);
    }
    stepNumber += 1;
  }

  lines.push(`${stepNumber}. Verify:`);
  for (const command of scoped.verify) {
    lines.push(`   - \`${command}\``);
  }
  stepNumber += 1;

  lines.push(`${stepNumber}. If it still fails:`);
  for (const command of scoped.capture) {
    lines.push(`   - \`${command}\``);
  }

  return lines;
}
