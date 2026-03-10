import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  GLOBAL_HACK_DIR_NAME,
  GLOBAL_REGISTRY_DIR_NAME,
} from "../constants.ts";
import { ensureDir, readTextFile } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";

export type DispatchRunStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "error";

export type DispatchRunTerminalState =
  | "completed"
  | "pr_created"
  | "no_diff"
  | "no_commit"
  | "pr_failed";

export type DispatchRunPolicyDecision = {
  readonly level: "low" | "medium" | "high" | "critical";
  readonly requiresApproval: boolean;
  readonly approved: boolean;
  readonly rationale: readonly string[];
  readonly actor: string;
  readonly decidedAt: string;
  readonly mode: "not_required" | "prompt" | "flag";
};

export type DispatchRunArtifacts = {
  readonly rootDir: string;
  readonly summaryPath: string;
  readonly patchPath: string;
  readonly testsPath: string;
  readonly logPath: string;
  readonly manifestPath: string;
  readonly eventsPath: string;
};

export type DispatchRunRecord = {
  readonly runId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: DispatchRunStatus;
  readonly terminalState?: DispatchRunTerminalState;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly nodeEndpoint: string;
  readonly projectSelector: string;
  readonly projectName?: string;
  readonly projectRoot?: string;
  readonly projectId?: string;
  readonly branch?: string;
  readonly ticketId?: string;
  readonly runner: string;
  readonly command: readonly string[];
  readonly jobId?: string;
  readonly jobStatus?: string;
  readonly logOffset?: number;
  readonly eventsSeq?: number;
  readonly exitCode?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly policy: DispatchRunPolicyDecision;
  readonly artifacts: DispatchRunArtifacts;
};

function resolveGlobalRoot(): string {
  const configPath = (process.env.HACK_GLOBAL_CONFIG_PATH ?? "").trim();
  if (configPath.length > 0) {
    return dirname(configPath);
  }
  const home = (process.env.HOME ?? "").trim();
  if (home.length === 0) {
    throw new Error("HOME is not set");
  }
  return resolve(home, GLOBAL_HACK_DIR_NAME);
}

function getRunsRoot(): string {
  return resolve(resolveGlobalRoot(), GLOBAL_REGISTRY_DIR_NAME, "runs");
}

function getRunRoot(runId: string): string {
  return resolve(getRunsRoot(), runId);
}

function getRunRecordPath(runId: string): string {
  return resolve(getRunRoot(runId), "run.json");
}

function getRunArtifactPaths(runId: string): DispatchRunArtifacts {
  const rootDir = getRunRoot(runId);
  return {
    rootDir,
    summaryPath: resolve(rootDir, "summary.md"),
    patchPath: resolve(rootDir, "patch.diff"),
    testsPath: resolve(rootDir, "tests.json"),
    logPath: resolve(rootDir, "logs.txt"),
    manifestPath: resolve(rootDir, "manifest.json"),
    eventsPath: resolve(rootDir, "events.jsonl"),
  };
}

/**
 * Create a new persisted dispatch run record and initialize artifact files.
 */
export async function createDispatchRunRecord(input: {
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly nodeEndpoint: string;
  readonly projectSelector: string;
  readonly projectName?: string;
  readonly projectRoot?: string;
  readonly projectId?: string;
  readonly branch?: string;
  readonly ticketId?: string;
  readonly runner: string;
  readonly command: readonly string[];
  readonly policy: DispatchRunPolicyDecision;
}): Promise<DispatchRunRecord> {
  const nowIso = new Date().toISOString();
  const artifacts = getRunArtifactPaths(input.runId);
  await ensureDir(artifacts.rootDir);
  const record: DispatchRunRecord = {
    runId: input.runId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: "created",
    nodeId: input.nodeId,
    nodeName: input.nodeName,
    nodeEndpoint: input.nodeEndpoint,
    projectSelector: input.projectSelector,
    ...(input.projectName ? { projectName: input.projectName } : {}),
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.ticketId ? { ticketId: input.ticketId } : {}),
    runner: input.runner,
    command: [...input.command],
    policy: input.policy,
    artifacts,
  };
  await writeDispatchRunRecord({ record });
  await Promise.all([
    Bun.write(artifacts.summaryPath, ""),
    Bun.write(artifacts.patchPath, "# no diff captured\n"),
    Bun.write(artifacts.testsPath, "{}\n"),
    Bun.write(artifacts.logPath, ""),
    Bun.write(artifacts.eventsPath, ""),
    Bun.write(artifacts.manifestPath, "{}\n"),
  ]);
  return record;
}

/**
 * Read persisted dispatch run state by id.
 */
export async function readDispatchRunRecord(input: {
  readonly runId: string;
}): Promise<DispatchRunRecord | null> {
  const text = await readTextFile(getRunRecordPath(input.runId));
  if (!text) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parseDispatchRunRecord(parsed);
}

/**
 * Update persisted dispatch run state by shallow-merging provided fields.
 */
export async function updateDispatchRunRecord(input: {
  readonly runId: string;
  readonly patch: Partial<
    Omit<DispatchRunRecord, "runId" | "createdAt" | "updatedAt" | "artifacts">
  >;
}): Promise<DispatchRunRecord | null> {
  const current = await readDispatchRunRecord({ runId: input.runId });
  if (!current) {
    return null;
  }
  const next: DispatchRunRecord = {
    ...current,
    ...input.patch,
    updatedAt: new Date().toISOString(),
    artifacts: current.artifacts,
    command:
      input.patch.command !== undefined
        ? [...input.patch.command]
        : current.command,
  };
  await writeDispatchRunRecord({ record: next });
  return next;
}

/**
 * Append textual log output for a run.
 */
export async function appendDispatchRunLog(input: {
  readonly runId: string;
  readonly text: string;
}): Promise<void> {
  const artifacts = getRunArtifactPaths(input.runId);
  await ensureDir(artifacts.rootDir);
  await appendFile(artifacts.logPath, input.text, "utf8");
}

/**
 * Read a bounded log tail from persisted artifacts.
 */
export async function readDispatchRunLogTail(input: {
  readonly runId: string;
  readonly maxBytes?: number;
}): Promise<string> {
  const artifacts = getRunArtifactPaths(input.runId);
  const maxBytes = input.maxBytes ?? 100_000;
  try {
    const content = await readFile(artifacts.logPath, "utf8");
    if (content.length <= maxBytes) {
      return content;
    }
    return content.slice(content.length - maxBytes);
  } catch {
    return "";
  }
}

/**
 * Append JSONL event for a dispatch run.
 */
export async function appendDispatchRunEvent(input: {
  readonly runId: string;
  readonly event: Record<string, unknown>;
}): Promise<void> {
  const artifacts = getRunArtifactPaths(input.runId);
  await ensureDir(artifacts.rootDir);
  await appendFile(
    artifacts.eventsPath,
    `${JSON.stringify({ ts: new Date().toISOString(), ...input.event })}\n`,
    "utf8"
  );
}

/**
 * Persist summary/test/manifest artifacts.
 */
export async function writeDispatchRunArtifacts(input: {
  readonly runId: string;
  readonly summaryMarkdown: string;
  readonly patchDiff: string;
  readonly testsManifest: Record<string, unknown>;
  readonly manifest: Record<string, unknown>;
}): Promise<void> {
  const artifacts = getRunArtifactPaths(input.runId);
  await ensureDir(artifacts.rootDir);
  await Promise.all([
    Bun.write(artifacts.summaryPath, `${input.summaryMarkdown.trim()}\n`),
    Bun.write(artifacts.patchPath, `${input.patchDiff.trim()}\n`),
    Bun.write(
      artifacts.testsPath,
      `${JSON.stringify(input.testsManifest, null, 2)}\n`
    ),
    Bun.write(
      artifacts.manifestPath,
      `${JSON.stringify(input.manifest, null, 2)}\n`
    ),
  ]);
}

type DispatchRunRequiredFields = {
  readonly runId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly nodeEndpoint: string;
  readonly projectSelector: string;
  readonly runner: string;
};

function parseRequiredRunFields(
  value: Record<string, unknown>
): DispatchRunRequiredFields | null {
  const runId = getString(value, "runId");
  const createdAt = getString(value, "createdAt");
  const updatedAt = getString(value, "updatedAt");
  const status = getString(value, "status");
  const nodeId = getString(value, "nodeId");
  const nodeName = getString(value, "nodeName");
  const nodeEndpoint = getString(value, "nodeEndpoint");
  const projectSelector = getString(value, "projectSelector");
  const runner = getString(value, "runner");
  if (
    !(
      runId &&
      createdAt &&
      updatedAt &&
      status &&
      nodeId &&
      nodeName &&
      nodeEndpoint &&
      projectSelector &&
      runner
    )
  ) {
    return null;
  }
  return {
    runId,
    createdAt,
    updatedAt,
    status,
    nodeId,
    nodeName,
    nodeEndpoint,
    projectSelector,
    runner,
  };
}

function parseCommand(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const command = value.filter(
    (entry): entry is string => typeof entry === "string"
  );
  return command.length > 0 ? command : null;
}

function parseOptionalFiniteNumber(
  value: Record<string, unknown>,
  key: string
): number | undefined {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return undefined;
  }
  return candidate;
}

function parseOptionalStringField(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  return getString(value, key) ?? undefined;
}

function parseDispatchRunRecord(value: unknown): DispatchRunRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const required = parseRequiredRunFields(value);
  if (!required) {
    return null;
  }
  const command = parseCommand(value.command);
  if (!command) {
    return null;
  }
  const policy = parsePolicyDecision(value.policy);
  const artifacts =
    parseArtifacts(value.artifacts) ?? getRunArtifactPaths(required.runId);
  if (!policy) {
    return null;
  }
  const exitCode = parseOptionalFiniteNumber(value, "exitCode");
  const logOffset = parseOptionalFiniteNumber(value, "logOffset");
  const eventsSeq = parseOptionalFiniteNumber(value, "eventsSeq");
  const projectName = parseOptionalStringField(value, "projectName");
  const projectRoot = parseOptionalStringField(value, "projectRoot");
  const projectId = parseOptionalStringField(value, "projectId");
  const branch = parseOptionalStringField(value, "branch");
  const ticketId = parseOptionalStringField(value, "ticketId");
  const jobId = parseOptionalStringField(value, "jobId");
  const jobStatus = parseOptionalStringField(value, "jobStatus");
  const startedAt = parseOptionalStringField(value, "startedAt");
  const finishedAt = parseOptionalStringField(value, "finishedAt");
  const terminalState = normalizeRunTerminalState(
    parseOptionalStringField(value, "terminalState")
  );

  return {
    runId: required.runId,
    createdAt: required.createdAt,
    updatedAt: required.updatedAt,
    status: normalizeRunStatus(required.status),
    ...(terminalState ? { terminalState } : {}),
    nodeId: required.nodeId,
    nodeName: required.nodeName,
    nodeEndpoint: required.nodeEndpoint,
    projectSelector: required.projectSelector,
    ...(projectName ? { projectName } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...(projectId ? { projectId } : {}),
    ...(branch ? { branch } : {}),
    ...(ticketId ? { ticketId } : {}),
    runner: required.runner,
    command,
    ...(jobId ? { jobId } : {}),
    ...(jobStatus ? { jobStatus } : {}),
    ...(logOffset !== undefined ? { logOffset } : {}),
    ...(eventsSeq !== undefined ? { eventsSeq } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    policy,
    artifacts,
  };
}

function normalizeRunStatus(value: string): DispatchRunStatus {
  if (
    value === "created" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "error"
  ) {
    return value;
  }
  return "error";
}

function normalizeRunTerminalState(
  value: string | undefined
): DispatchRunTerminalState | undefined {
  if (
    value === "completed" ||
    value === "pr_created" ||
    value === "no_diff" ||
    value === "no_commit" ||
    value === "pr_failed"
  ) {
    return value;
  }
  return undefined;
}

function parsePolicyDecision(value: unknown): DispatchRunPolicyDecision | null {
  if (!isRecord(value)) {
    return null;
  }
  const level = getString(value, "level");
  const actor = getString(value, "actor");
  const decidedAt = getString(value, "decidedAt");
  const mode = getString(value, "mode");
  if (!(level && actor && decidedAt && mode)) {
    return null;
  }
  if (
    !(
      level === "low" ||
      level === "medium" ||
      level === "high" ||
      level === "critical"
    )
  ) {
    return null;
  }
  if (!(mode === "not_required" || mode === "prompt" || mode === "flag")) {
    return null;
  }
  const requiresApproval = value.requiresApproval === true;
  const approved = value.approved === true;
  const rationale = Array.isArray(value.rationale)
    ? value.rationale.filter(
        (entry): entry is string => typeof entry === "string"
      )
    : [];
  return {
    level,
    requiresApproval,
    approved,
    rationale,
    actor,
    decidedAt,
    mode,
  };
}

function parseArtifacts(value: unknown): DispatchRunArtifacts | null {
  if (!isRecord(value)) {
    return null;
  }
  const rootDir = getString(value, "rootDir");
  const summaryPath = getString(value, "summaryPath");
  const patchPath = getString(value, "patchPath");
  const testsPath = getString(value, "testsPath");
  const logPath = getString(value, "logPath");
  const manifestPath = getString(value, "manifestPath");
  const eventsPath = getString(value, "eventsPath");
  if (
    !(
      rootDir &&
      summaryPath &&
      patchPath &&
      testsPath &&
      logPath &&
      manifestPath &&
      eventsPath
    )
  ) {
    return null;
  }
  return {
    rootDir,
    summaryPath,
    patchPath,
    testsPath,
    logPath,
    manifestPath,
    eventsPath,
  };
}

async function writeDispatchRunRecord(input: {
  readonly record: DispatchRunRecord;
}): Promise<void> {
  const path = getRunRecordPath(input.record.runId);
  await ensureDir(dirname(path));
  await Bun.write(path, `${JSON.stringify(input.record, null, 2)}\n`);
}
