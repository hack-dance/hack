import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureDir, pathExists, readTextFile, writeTextFile } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";

export type LifecycleBackend = "tmux" | "zellij";

export type LifecycleStateProcess = {
  readonly name: string;
  readonly windowName: string;
  readonly logPath: string;
};

export type LifecycleStateEntry = {
  readonly composeProject: string;
  readonly projectName: string;
  readonly branch: string | null;
  readonly sessionName: string;
  readonly backend: LifecycleBackend;
  readonly processes: readonly LifecycleStateProcess[];
  readonly updatedAt: string;
};

type LifecycleStateFile = {
  readonly entries: readonly LifecycleStateEntry[];
};

export type LifecycleLogStream = "stdout" | "stderr" | "meta";

export type LifecycleLogRecord = {
  readonly timestamp: string;
  readonly service: string;
  readonly stream: LifecycleLogStream;
  readonly message: string;
};

const LIFECYCLE_DIRNAME = "lifecycle" as const;
const LIFECYCLE_STATE_FILENAME = "state.json" as const;
const LIFECYCLE_SERVICE_MAX_LENGTH = 96;

export function resolveLifecycleComposeProjectName(opts: {
  readonly projectName: string;
  readonly branch: string | null;
}): string {
  return opts.branch ? `${opts.projectName}--${opts.branch}` : opts.projectName;
}

export function resolveLifecycleRootDir(opts: {
  readonly projectDir: string;
}): string {
  return resolve(opts.projectDir, ".internal", LIFECYCLE_DIRNAME);
}

export function resolveLifecycleStatePath(opts: {
  readonly projectDir: string;
}): string {
  return resolve(resolveLifecycleRootDir(opts), LIFECYCLE_STATE_FILENAME);
}

export function resolveLifecycleLogPath(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
}): string {
  const safeProject = sanitizeLifecycleToken(opts.composeProject);
  return resolve(resolveLifecycleRootDir(opts), `${safeProject}.log`);
}

export function formatLifecycleLogRecord(record: LifecycleLogRecord): string {
  return [
    sanitizeLifecycleField(record.timestamp),
    sanitizeLifecycleService(record.service),
    sanitizeLifecycleField(record.stream),
    sanitizeLifecycleMessage(record.message),
  ].join("\t");
}

export function parseLifecycleLogRecord(
  line: string
): LifecycleLogRecord | null {
  const firstTab = line.indexOf("\t");
  if (firstTab <= 0) {
    return null;
  }
  const secondTab = line.indexOf("\t", firstTab + 1);
  if (secondTab <= firstTab) {
    return null;
  }
  const thirdTab = line.indexOf("\t", secondTab + 1);
  if (thirdTab <= secondTab) {
    return null;
  }

  const timestamp = line.slice(0, firstTab).trim();
  const service = line.slice(firstTab + 1, secondTab).trim();
  const streamRaw = line.slice(secondTab + 1, thirdTab).trim();
  const message = line.slice(thirdTab + 1);
  if (!(timestamp && service)) {
    return null;
  }
  const stream = normalizeLifecycleStream(streamRaw);
  return {
    timestamp,
    service,
    stream,
    message,
  };
}

export async function appendLifecycleLogRecord(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly record: LifecycleLogRecord;
}): Promise<void> {
  const root = resolveLifecycleRootDir({ projectDir: opts.projectDir });
  const logPath = resolveLifecycleLogPath({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
  await ensureDir(root);
  const line = `${formatLifecycleLogRecord(opts.record)}\n`;
  await appendFile(logPath, line, "utf8");
}

export async function readLifecycleState(opts: {
  readonly projectDir: string;
}): Promise<readonly LifecycleStateEntry[]> {
  const path = resolveLifecycleStatePath({ projectDir: opts.projectDir });
  if (!(await pathExists(path))) {
    return [];
  }
  const text = await readTextFile(path);
  if (!text) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const entriesRaw = parsed.entries;
  if (!Array.isArray(entriesRaw)) {
    return [];
  }
  const entries: LifecycleStateEntry[] = [];
  for (const entry of entriesRaw) {
    const parsedEntry = parseLifecycleStateEntry(entry);
    if (parsedEntry) {
      entries.push(parsedEntry);
    }
  }
  return entries;
}

export async function upsertLifecycleStateEntry(opts: {
  readonly projectDir: string;
  readonly entry: LifecycleStateEntry;
}): Promise<void> {
  const state = await readLifecycleState({ projectDir: opts.projectDir });
  const withoutCurrent = state.filter(
    (entry) => entry.composeProject !== opts.entry.composeProject
  );
  const next: LifecycleStateFile = {
    entries: [...withoutCurrent, opts.entry].sort((a, b) =>
      a.composeProject.localeCompare(b.composeProject)
    ),
  };
  await writeLifecycleStateFile({
    projectDir: opts.projectDir,
    state: next,
  });
}

export async function removeLifecycleStateEntry(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<void> {
  const state = await readLifecycleState({ projectDir: opts.projectDir });
  const nextEntries = state.filter(
    (entry) => entry.composeProject !== opts.composeProject
  );
  if (nextEntries.length === state.length) {
    return;
  }
  await writeLifecycleStateFile({
    projectDir: opts.projectDir,
    state: { entries: nextEntries },
  });
}

function parseLifecycleStateEntry(value: unknown): LifecycleStateEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const composeProject = getString(value, "composeProject")?.trim();
  const projectName = getString(value, "projectName")?.trim();
  const sessionName = getString(value, "sessionName")?.trim();
  const backendRaw = getString(value, "backend")?.trim();
  const updatedAt = getString(value, "updatedAt")?.trim();
  if (
    !(composeProject && projectName && sessionName && backendRaw && updatedAt)
  ) {
    return null;
  }
  if (!(backendRaw === "tmux" || backendRaw === "zellij")) {
    return null;
  }
  const branchRaw = value.branch;
  const branch =
    typeof branchRaw === "string" && branchRaw.trim().length > 0
      ? branchRaw.trim()
      : null;
  const processesRaw = value.processes;
  if (!Array.isArray(processesRaw) || processesRaw.length === 0) {
    return null;
  }
  const processes: LifecycleStateProcess[] = [];
  for (const item of processesRaw) {
    const parsed = parseLifecycleStateProcess(item);
    if (parsed) {
      processes.push(parsed);
    }
  }
  if (processes.length === 0) {
    return null;
  }
  return {
    composeProject,
    projectName,
    branch,
    sessionName,
    backend: backendRaw,
    processes,
    updatedAt,
  };
}

function parseLifecycleStateProcess(
  value: unknown
): LifecycleStateProcess | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = getString(value, "name")?.trim();
  const windowName = getString(value, "windowName")?.trim();
  const logPath = getString(value, "logPath")?.trim();
  if (!(name && windowName && logPath)) {
    return null;
  }
  return {
    name,
    windowName,
    logPath,
  };
}

async function writeLifecycleStateFile(opts: {
  readonly projectDir: string;
  readonly state: LifecycleStateFile;
}): Promise<void> {
  const root = resolveLifecycleRootDir({ projectDir: opts.projectDir });
  const path = resolveLifecycleStatePath({ projectDir: opts.projectDir });
  await ensureDir(root);
  await writeTextFile(path, `${JSON.stringify(opts.state, null, 2)}\n`);
}

function sanitizeLifecycleToken(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const cleaned = trimmed.replaceAll(/[^a-z0-9_.-]+/g, "-");
  return cleaned.length > 0 ? cleaned : "lifecycle";
}

function sanitizeLifecycleService(value: string): string {
  const trimmed = sanitizeLifecycleField(value).trim();
  const compact = trimmed.replaceAll(/\s+/g, " ");
  if (compact.length <= LIFECYCLE_SERVICE_MAX_LENGTH) {
    return compact;
  }
  return compact.slice(0, LIFECYCLE_SERVICE_MAX_LENGTH);
}

function sanitizeLifecycleMessage(value: string): string {
  return value.replaceAll(/\r?\n/g, " ").replaceAll("\t", "    ");
}

function sanitizeLifecycleField(value: string): string {
  return value.replaceAll(/\r?\n/g, " ").replaceAll("\t", " ");
}

function normalizeLifecycleStream(value: string): LifecycleLogStream {
  if (value === "stderr") {
    return "stderr";
  }
  if (value === "meta") {
    return "meta";
  }
  return "stdout";
}
