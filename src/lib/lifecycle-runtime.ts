import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { readLinesFromStream } from "../ui/lines.ts";
import { getString, isRecord } from "./guards.ts";
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  openPrivateAppend,
  PrivatePathRefusedError,
  readReplaceablePrivateFile,
  replacePrivateFileAtomic,
} from "./private-file.ts";
import { withProjectsRegistryLock } from "./projects-registry-lock.ts";

export type LifecycleBackend = "tmux" | "zellij" | "supervisor";

export type LifecycleStateProcess = {
  readonly name: string;
  readonly windowName: string;
  readonly logPath: string;
  readonly panePid?: number;
  readonly paneBirth?: string;
  readonly processGroupId?: number;
  readonly guardPid?: number;
  readonly guardStartTime?: number;
  readonly commandPid?: number;
  readonly bootId?: string;
  readonly processGroupBirth?: string;
};

export type LifecycleStateEntry = {
  readonly composeProject: string;
  readonly projectName: string;
  readonly branch: string | null;
  readonly sessionName: string;
  readonly backend: LifecycleBackend;
  readonly ownershipToken?: string;
  readonly definitionHash?: string;
  readonly processes: readonly LifecycleStateProcess[];
  readonly updatedAt: string;
  readonly supervisorPid?: number;
  readonly cleanupEpoch?: string;
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
  await ensurePrivateDirectory(root);
  await appendPrivateFile({
    path: logPath,
    data: `${formatLifecycleLogRecord(opts.record)}\n`,
  });
}

/**
 * Lifecycle output is stored verbatim and unredacted, so its directory and
 * log are private (0700 and 0600, owner-checked, never through a symlink,
 * an older broadly readable log moved aside and a new private one started). Called before the first record and before a
 * persistent session's shell appends to the log.
 */
export async function ensurePrivateLifecycleLog(opts: {
  readonly root: string;
  readonly logPath: string;
}): Promise<void> {
  await ensurePrivateDirectory(opts.root);
  await (await openPrivateAppend(opts.logPath)).close();
}

export async function readLifecycleState(opts: {
  readonly projectDir: string;
}): Promise<readonly LifecycleStateEntry[]> {
  const root = resolveLifecycleRootDir(opts);
  const path = resolveLifecycleStatePath(opts);
  const rootInfo = await lstat(root).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!rootInfo) {
    return [];
  }
  if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid?.()) {
    throw lifecycleStateRefused();
  }
  await verifyLifecycleStateTarget(path);
  const file = await readReplaceablePrivateFile({
    path,
    directories: [root],
    maxBytes: 1024 * 1024,
    refusal: lifecycleStateRefused,
  });
  if (file === null) {
    return [];
  }
  await verifyLifecycleStateTarget(path);
  const text = file.text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw lifecycleStateRefused();
  }
  if (!isRecord(parsed)) {
    throw lifecycleStateRefused();
  }
  const entriesRaw = parsed.entries;
  if (!Array.isArray(entriesRaw)) {
    throw lifecycleStateRefused();
  }
  const entries: LifecycleStateEntry[] = [];
  for (const entry of entriesRaw) {
    const parsedEntry = parseLifecycleStateEntry(entry);
    if (
      !parsedEntry ||
      entries.some(
        (current) => current.composeProject === parsedEntry.composeProject
      )
    ) {
      throw lifecycleStateRefused();
    }
    entries.push(parsedEntry);
  }
  return entries;
}

export async function upsertLifecycleStateEntry(opts: {
  readonly projectDir: string;
  readonly entry: LifecycleStateEntry;
}): Promise<void> {
  return await mutateLifecycleState(opts.projectDir, async () => {
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
  });
}

export async function removeLifecycleStateEntry(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<void> {
  return await mutateLifecycleState(opts.projectDir, async () => {
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
  });
}

export async function removeLifecycleStateEntryIfOwned(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly ownershipToken: string;
}): Promise<boolean> {
  return await mutateLifecycleState(opts.projectDir, async () => {
    const state = await readLifecycleState({ projectDir: opts.projectDir });
    const current = state.find(
      (entry) => entry.composeProject === opts.composeProject
    );
    if (current?.ownershipToken !== opts.ownershipToken) {
      return false;
    }
    await writeLifecycleStateFile({
      projectDir: opts.projectDir,
      state: {
        entries: state.filter(
          (entry) => entry.composeProject !== opts.composeProject
        ),
      },
    });
    return true;
  });
}

export async function removeLifecycleStateEntryIfMatching(opts: {
  readonly projectDir: string;
  readonly expectedEntry: LifecycleStateEntry;
}): Promise<boolean> {
  return await mutateLifecycleState(opts.projectDir, async () => {
    const state = await readLifecycleState({ projectDir: opts.projectDir });
    const current = state.find(
      (entry) => entry.composeProject === opts.expectedEntry.composeProject
    );
    if (
      !current ||
      current.sessionName !== opts.expectedEntry.sessionName ||
      current.backend !== opts.expectedEntry.backend ||
      current.updatedAt !== opts.expectedEntry.updatedAt ||
      current.cleanupEpoch !== opts.expectedEntry.cleanupEpoch ||
      current.ownershipToken !== opts.expectedEntry.ownershipToken
    ) {
      return false;
    }
    await writeLifecycleStateFile({
      projectDir: opts.projectDir,
      state: {
        entries: state.filter(
          (entry) => entry.composeProject !== opts.expectedEntry.composeProject
        ),
      },
    });
    return true;
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
  const ownershipToken = getString(value, "ownershipToken")?.trim();
  const definitionHash = getString(value, "definitionHash")?.trim();
  if (
    !(composeProject && projectName && sessionName && backendRaw && updatedAt)
  ) {
    return null;
  }
  if (
    !(
      backendRaw === "tmux" ||
      backendRaw === "zellij" ||
      backendRaw === "supervisor"
    )
  ) {
    return null;
  }
  const branchRaw = value.branch;
  const branch =
    typeof branchRaw === "string" && branchRaw.trim().length > 0
      ? branchRaw.trim()
      : null;
  const processesRaw = value.processes;
  if (!Array.isArray(processesRaw)) {
    return null;
  }
  const processes: LifecycleStateProcess[] = [];
  for (const item of processesRaw) {
    const parsed = parseLifecycleStateProcess(item);
    if (!parsed) {
      return null;
    }
    processes.push(parsed);
  }
  const supervisorPid = parseLifecycleOptionalPositiveInteger(
    value.supervisorPid
  );
  const cleanupEpoch = getString(value, "cleanupEpoch")?.trim();
  return {
    composeProject,
    projectName,
    branch,
    sessionName,
    backend: backendRaw,
    ...(ownershipToken ? { ownershipToken } : {}),
    ...(definitionHash ? { definitionHash } : {}),
    processes,
    updatedAt,
    ...(supervisorPid ? { supervisorPid } : {}),
    ...(cleanupEpoch ? { cleanupEpoch } : {}),
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
  const panePid = parseLifecycleOptionalPositiveInteger(value.panePid);
  const paneBirth = getString(value, "paneBirth")?.trim();
  const processGroupId = parseLifecycleOptionalPositiveInteger(
    value.processGroupId
  );
  const guardPid = parseLifecycleOptionalPositiveInteger(value.guardPid);
  const guardStartTime = parseLifecycleOptionalPositiveInteger(
    value.guardStartTime
  );
  const commandPid = parseLifecycleOptionalPositiveInteger(value.commandPid);
  const bootId = getString(value, "bootId");
  const processGroupBirth = getString(value, "processGroupBirth")?.trim();
  return {
    name,
    windowName,
    logPath,
    ...(panePid ? { panePid } : {}),
    ...(paneBirth ? { paneBirth } : {}),
    ...(processGroupId ? { processGroupId } : {}),
    ...(guardPid ? { guardPid } : {}),
    ...(guardStartTime ? { guardStartTime } : {}),
    ...(commandPid ? { commandPid } : {}),
    ...(bootId ? { bootId } : {}),
    ...(processGroupBirth ? { processGroupBirth } : {}),
  };
}

function parseLifecycleOptionalPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

async function writeLifecycleStateFile(opts: {
  readonly projectDir: string;
  readonly state: LifecycleStateFile;
}): Promise<void> {
  const root = resolveLifecycleRootDir({ projectDir: opts.projectDir });
  const path = resolveLifecycleStatePath({ projectDir: opts.projectDir });
  const text = `${JSON.stringify(opts.state, null, 2)}\n`;
  if (Buffer.byteLength(text) > 1024 * 1024) {
    throw lifecycleStateRefused();
  }
  await ensurePrivateDirectory(root);
  await verifyLifecycleStateTarget(path);
  await replacePrivateFileAtomic({
    path,
    directories: [root],
    staging: "sibling",
    text,
    refusal: lifecycleStateRefused,
    beforeRename: () => verifyLifecycleStateTarget(path),
  });
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

/**
 * Where a running hook's output is persisted. `append` never throws: the
 * first failure (a refused path, an I/O error) is reported once through
 * `warn`, value-free, and persistence stops for this hook while its output
 * keeps reaching the terminal. One sink is shared by a hook's stdout and
 * stderr, so the refusal is reported once.
 */
export type LifecycleLogSink = {
  readonly append: (record: LifecycleLogRecord) => Promise<void>;
};

export function createLifecycleLogSink(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly warn: (message: string) => void;
}): LifecycleLogSink {
  let failed = false;
  return {
    append: async (record) => {
      if (failed) {
        return;
      }
      try {
        await appendLifecycleLogRecord({ ...opts, record });
      } catch (error: unknown) {
        failed = true;
        // A refusal names the path only; other errors are reported by code,
        // never by message, since they may quote the record.
        const reason =
          error instanceof PrivatePathRefusedError
            ? error.message
            : `write failed (${isRecord(error) && typeof error.code === "string" ? error.code : "unknown error"})`;
        opts.warn(
          `Lifecycle output is no longer saved to the log for this hook: ${reason}`
        );
      }
    },
  };
}

/**
 * Drain one stream of a running hook to the terminal and the log, line by
 * line, until it ends. Persistence failures never stop the drain (see
 * {@link LifecycleLogSink}), so the hook cannot block on a full pipe.
 */
export async function drainLifecycleOutput(opts: {
  readonly stream: ReadableStream<Uint8Array> | number | null;
  readonly output: "stdout" | "stderr";
  readonly service: string;
  readonly sink: LifecycleLogSink;
  readonly write?: (output: "stdout" | "stderr", text: string) => void;
}): Promise<void> {
  if (!opts.stream || typeof opts.stream === "number") {
    return;
  }
  const write =
    opts.write ??
    ((output: "stdout" | "stderr", text: string) => {
      (output === "stderr" ? process.stderr : process.stdout).write(text);
    });
  for await (const line of readLinesFromStream(opts.stream)) {
    write(opts.output, `${line}\n`);
    await opts.sink.append({
      timestamp: new Date().toISOString(),
      service: opts.service,
      stream: opts.output,
      message: line,
    });
  }
}

function lifecycleStateRefused(): Error {
  return new Error(
    "Lifecycle ownership state is invalid or unsafe; kept existing state. Values omitted."
  );
}

async function verifyLifecycleStateTarget(path: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  // A concurrent atomic replacement can unlink the observed inode before
  // the asynchronous stat result is delivered (nlink=0). That is not an
  // alias; the replaceable reader separately binds its actual opened file.
  if (
    info &&
    (!info.isFile() || info.uid !== process.getuid?.() || info.nlink > 1)
  ) {
    throw lifecycleStateRefused();
  }
}

async function mutateLifecycleState<T>(
  projectDir: string,
  run: () => Promise<T>
): Promise<T> {
  const root = resolveLifecycleRootDir({ projectDir });
  await ensurePrivateDirectory(root);
  return await withProjectsRegistryLock({
    lockPath: resolve(root, "state.lock"),
    label: "Lifecycle state",
    run,
  });
}
