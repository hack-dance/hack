import { resolve } from "node:path";
import * as p from "@clack/prompts";
import type {
  CliContext,
  CommandArgs,
  CommandHandlerFor,
} from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson, optPretty } from "../cli/options.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { type ProjectContext, sanitizeBranchSlug } from "../lib/project.ts";
import type { RegisteredProject } from "../lib/projects-registry.ts";
import { readProjectsRegistry } from "../lib/projects-registry.ts";
import { exec, run } from "../lib/shell.ts";
import type { MuxBackendName, MuxSession } from "../mux/mux-backend.ts";
import {
  listMuxSessions,
  resolveDefaultBackendName,
  resolveMux,
} from "../mux/mux-resolver.ts";
import {
  buildSessionName,
  getNextNumericSessionSuffix,
  parseSessionBase,
} from "../mux/session-names.ts";
import { attachTmuxSession, createTmuxBackend } from "../mux/tmux-backend.ts";
import {
  attachZellijSession,
  createZellijBackend,
} from "../mux/zellij-backend.ts";
import { logger } from "../ui/logger.ts";
import {
  buildSessionPanesEndEvent,
  buildSessionPanesErrorEvent,
  buildSessionPanesLogEvent,
  buildSessionPanesStartEvent,
  buildSessionStreamEndEvent,
  buildSessionStreamErrorEvent,
  buildSessionStreamLogEvent,
  buildSessionStreamStartEvent,
  diffNewLines,
  parseTmuxPanesOutput,
  type SessionStreamContext,
  splitLines,
  writeSessionStreamEvent,
} from "./session-utils.ts";

const tmuxBackend = createTmuxBackend();
const zellijBackend = createZellijBackend();

const optUp = defineOption({
  name: "up",
  type: "boolean",
  long: "--up",
  description: "Run hack up -d before attaching",
} as const);

const optNew = defineOption({
  name: "new",
  type: "boolean",
  long: "--new",
  description: "Force create new session even if one exists",
} as const);

const optName = defineOption({
  name: "name",
  type: "string",
  long: "--name",
  description: "Custom suffix for new session (e.g., agent-1)",
} as const);

const optTarget = defineOption({
  name: "target",
  type: "string",
  long: "--target",
  valueHint: "<target>",
  description: "Tmux pane target (default: active pane)",
} as const);

const optLines = defineOption({
  name: "lines",
  type: "number",
  long: "--lines",
  valueHint: "<n>",
  description: "Number of lines to capture",
  defaultValue: "200",
} as const);

const optIntervalMs = defineOption({
  name: "intervalMs",
  type: "number",
  long: "--interval-ms",
  valueHint: "<ms>",
  description: "Polling interval in milliseconds",
  defaultValue: "500",
} as const);

const optMaxMs = defineOption({
  name: "maxMs",
  type: "number",
  long: "--max-ms",
  valueHint: "<ms>",
  description: "Stop tailing after N milliseconds",
  defaultValue: "5000",
} as const);

// Subcommand specs
const listSpec = defineCommand({
  name: "list",
  summary: "List active sessions",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const startSpec = defineCommand({
  name: "start",
  summary: "Start or attach to a session for a project",
  group: "Project",
  options: [optUp, optNew, optName],
  positionals: [
    { name: "project", description: "Project name or path", required: false },
  ],
  subcommands: [],
} as const);

const stopSpec = defineCommand({
  name: "stop",
  summary: "Stop (kill) a session",
  group: "Project",
  options: [],
  positionals: [
    { name: "session", description: "Session name", required: true },
  ],
  subcommands: [],
} as const);

const attachSpec = defineCommand({
  name: "attach",
  summary: "Attach to an existing session",
  group: "Project",
  options: [],
  positionals: [
    { name: "session", description: "Session name", required: true },
  ],
  subcommands: [],
} as const);

const execSpec = defineCommand({
  name: "exec",
  summary: "Execute a command in a session",
  group: "Project",
  options: [],
  positionals: [
    { name: "session", description: "Session name", required: true },
    {
      name: "command",
      description: "Command to execute in session",
      required: true,
    },
  ],
  subcommands: [],
} as const);

const panesSpec = defineCommand({
  name: "panes",
  summary: "List panes in a tmux session",
  group: "Project",
  options: [optJson, optPretty],
  positionals: [
    { name: "session", description: "Session name", required: true },
  ],
  subcommands: [],
} as const);

const captureSpec = defineCommand({
  name: "capture",
  summary: "Capture recent output from a tmux session",
  group: "Project",
  options: [optTarget, optLines, optJson, optPretty],
  positionals: [
    { name: "session", description: "Session name", required: true },
  ],
  subcommands: [],
} as const);

const tailSpec = defineCommand({
  name: "tail",
  summary: "Tail output from a tmux session",
  group: "Project",
  options: [optTarget, optLines, optIntervalMs, optMaxMs, optJson, optPretty],
  positionals: [
    { name: "session", description: "Session name", required: true },
  ],
  subcommands: [],
} as const);

type StartArgs = CommandArgs<
  typeof startSpec.options,
  typeof startSpec.positionals
>;
type StopArgs = CommandArgs<
  typeof stopSpec.options,
  typeof stopSpec.positionals
>;
type AttachArgs = CommandArgs<
  typeof attachSpec.options,
  typeof attachSpec.positionals
>;
type ExecArgs = CommandArgs<
  typeof execSpec.options,
  typeof execSpec.positionals
>;
type PanesArgs = CommandArgs<
  typeof panesSpec.options,
  typeof panesSpec.positionals
>;
type CaptureArgs = CommandArgs<
  typeof captureSpec.options,
  typeof captureSpec.positionals
>;
type TailArgs = CommandArgs<
  typeof tailSpec.options,
  typeof tailSpec.positionals
>;

/**
 * Interactive session picker (default when no subcommand).
 *
 * Uses clack prompts with grouped options for sessions and projects.
 */
async function handleSessionPicker(): Promise<number> {
  const mux = await resolveMux({ project: null });
  const sessions = await listMuxSessions({
    mode: mux.mode,
    backends: mux.backends,
  });
  const registry = await readProjectsRegistry();
  const projects = registry.projects;

  p.intro("Sessions");

  const options = buildSessionPickerOptions({
    sessions,
    projects,
    home: process.env.HOME ?? "",
  });

  if (options.length === 0) {
    p.log.warn(
      "No sessions or projects found. Run 'hack init' in a project first."
    );
    p.outro("");
    return 1;
  }

  const selection = await p.select({
    message: "Select session or project",
    options,
  });

  if (p.isCancel(selection)) {
    p.outro("Cancelled");
    return 0;
  }

  const parsed = parseSessionPickerSelection({ selection });
  if (!parsed) {
    p.log.error("Invalid selection");
    return 1;
  }

  if (parsed.kind === "session") {
    return await handlePickedSession({
      selection: parsed,
      sessions,
      projects,
    });
  }

  const project = projects.find(
    (proj: RegisteredProject) => proj.name === parsed.name
  );
  if (!project) {
    p.log.error(`Project not found: ${parsed.name}`);
    return 1;
  }

  return await startProjectSession({
    project,
    forceNew: false,
    runUp: false,
    customSuffix: null,
  });
}

type SessionPickerOption = {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
};

type SessionPickerSelection =
  | {
      readonly kind: "session";
      readonly backend: MuxBackendName;
      readonly name: string;
    }
  | { readonly kind: "project"; readonly name: string };

function buildSessionPickerOptions(opts: {
  readonly sessions: readonly MuxSession[];
  readonly projects: readonly RegisteredProject[];
  readonly home: string;
}): SessionPickerOption[] {
  const sessionNames = new Set(opts.sessions.map((s) => s.name));
  const shortenPath = (path: string): string => {
    if (opts.home && path.startsWith(opts.home)) {
      return `~${path.slice(opts.home.length)}`;
    }
    return path;
  };

  const options: SessionPickerOption[] = [];

  const attachedSessions = opts.sessions.filter((s) => s.attached === true);
  const detachedSessions = opts.sessions.filter((s) => s.attached !== true);

  for (const session of attachedSessions) {
    options.push({
      value: `session:${session.backend}:${session.name}`,
      label: session.name,
      hint: formatSessionHint({
        backend: session.backend,
        status: "attached",
        path: session.path ? shortenPath(session.path) : null,
      }),
    });
  }

  for (const session of detachedSessions) {
    const status = session.attached === false ? "detached" : "unknown";
    options.push({
      value: `session:${session.backend}:${session.name}`,
      label: session.name,
      hint: formatSessionHint({
        backend: session.backend,
        status,
        path: session.path ? shortenPath(session.path) : null,
      }),
    });
  }

  for (const project of opts.projects) {
    const base = project.name;
    const hasSessions = [...sessionNames].some(
      (name) => name === base || name.startsWith(`${base}--`)
    );
    options.push({
      value: `project:${project.name}`,
      label: project.name,
      hint: `${hasSessions ? "sessions" : "new"} • ${shortenPath(project.repoRoot)}`,
    });
  }

  return options;
}

function formatSessionHint(opts: {
  readonly backend: MuxBackendName;
  readonly status: "attached" | "detached" | "unknown";
  readonly path: string | null;
}): string | undefined {
  const parts = [opts.backend, opts.status, opts.path].filter(
    (part): part is string => typeof part === "string" && part.length > 0
  );
  return parts.length > 0 ? parts.join(" • ") : undefined;
}

function parseSessionPickerSelection(opts: {
  readonly selection: string;
}): SessionPickerSelection | null {
  const [kind, a, ...rest] = opts.selection.split(":");

  if (kind === "project") {
    const name = [a, ...rest].join(":");
    return name.length > 0 ? { kind: "project", name } : null;
  }

  if (kind === "session") {
    const backend =
      a === "tmux" || a === "zellij" ? (a as MuxBackendName) : null;
    const name = rest.join(":");
    if (!backend || name.length === 0) {
      return null;
    }
    return { kind: "session", backend, name };
  }

  return null;
}

async function handlePickedSession(opts: {
  readonly selection: Extract<SessionPickerSelection, { kind: "session" }>;
  readonly sessions: readonly MuxSession[];
  readonly projects: readonly RegisteredProject[];
}): Promise<number> {
  const session =
    opts.sessions.find(
      (s) =>
        s.name === opts.selection.name && s.backend === opts.selection.backend
    ) ?? null;
  if (!session) {
    p.log.error(`Session not found: ${opts.selection.name}`);
    return 1;
  }

  const handled = await maybeHandleAttachedTmuxSession({
    session,
    sessions: opts.sessions,
    projects: opts.projects,
  });
  if (handled !== null) {
    return handled;
  }

  return await attachToSession({
    backend: opts.selection.backend,
    name: opts.selection.name,
  });
}

async function maybeHandleAttachedTmuxSession(opts: {
  readonly session: MuxSession;
  readonly sessions: readonly MuxSession[];
  readonly projects: readonly RegisteredProject[];
}): Promise<number | null> {
  if (!(opts.session.backend === "tmux" && opts.session.attached === true)) {
    return null;
  }

  const base = parseSessionBase({ name: opts.session.name });
  const nextNum = getNextNumericSessionSuffix({
    sessions: opts.sessions,
    base,
  });
  const newName = buildSessionName({ base, suffix: String(nextNum) });

  const action = await p.select({
    message: `Session '${opts.session.name}' is attached elsewhere`,
    options: [
      { value: "attach", label: "Attach", hint: "detaches other clients" },
      { value: "new", label: "Create new", hint: newName },
    ],
  });
  if (p.isCancel(action)) {
    p.outro("Cancelled");
    return 0;
  }
  if (action !== "new") {
    return null;
  }

  const project = opts.projects.find(
    (proj: RegisteredProject) => proj.name === base
  );
  const cwd = project?.repoRoot ?? opts.session.path ?? process.cwd();

  return await createAndAttachSession({
    backend: opts.session.backend,
    name: newName,
    cwd,
  });
}

function buildProjectContext(project: RegisteredProject): ProjectContext {
  return {
    projectRoot: project.repoRoot,
    projectDirName: project.projectDirName,
    projectDir: project.projectDir,
    composeFile: resolve(project.projectDir, PROJECT_COMPOSE_FILENAME),
    envFile: resolve(project.projectDir, PROJECT_ENV_FILENAME),
    configFile: resolve(project.projectDir, PROJECT_CONFIG_FILENAME),
  };
}

const handleList: CommandHandlerFor<
  typeof listSpec
> = async (): Promise<number> => {
  const mux = await resolveMux({ project: null });
  const sessions = await listMuxSessions({
    mode: mux.mode,
    backends: mux.backends,
  });
  const registry = await readProjectsRegistry();
  const projects = registry.projects;

  if (sessions.length === 0) {
    logger.info({ message: "No active sessions" });
    return 0;
  }

  console.log(
    `${"Session".padEnd(26) + "Backend".padEnd(10) + "Project".padEnd(20)}Status`
  );
  console.log("-".repeat(60));

  for (const session of sessions) {
    const base = parseSessionBase({ name: session.name });
    const project = projects.find((p: RegisteredProject) => p.name === base);
    const projectName = project?.name ?? "-";
    let status = "unknown";
    if (session.attached === true) {
      status = "attached";
    } else if (session.attached === false) {
      status = "detached";
    }
    console.log(
      session.name.padEnd(26) +
        session.backend.padEnd(10) +
        projectName.padEnd(20) +
        status
    );
  }

  return 0;
};

const handleStart = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: StartArgs;
}): Promise<number> => {
  const projectNameOrPath = args.positionals.project;
  const forceNew = args.options.new === true;
  const runUp = args.options.up === true;
  const customName = args.options.name;

  // Find project
  const registry = await readProjectsRegistry();
  const projects = registry.projects;
  let project = projectNameOrPath
    ? projects.find(
        (p: RegisteredProject) =>
          p.name === projectNameOrPath ||
          p.projectDir === resolve(projectNameOrPath)
      )
    : null;

  if (!project && projectNameOrPath) {
    // Try as path
    const resolvedPath = resolve(projectNameOrPath);
    project = projects.find(
      (p: RegisteredProject) => p.projectDir === resolvedPath
    );
  }

  if (!project) {
    if (projectNameOrPath) {
      logger.error({ message: `Project not found: ${projectNameOrPath}` });
    } else {
      logger.error({
        message: "No project specified. Use: hack session start <project>",
      });
    }
    return 1;
  }

  return await startProjectSession({
    project,
    forceNew,
    runUp,
    customSuffix: typeof customName === "string" ? customName : null,
  });
};

const handleStop = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: StopArgs;
}): Promise<number> => {
  const sessionName = args.positionals.session;

  const session = await findSession({ name: sessionName });
  if (!session) {
    logger.error({ message: `Session not found: ${sessionName}` });
    return 1;
  }

  const backend = session.backend === "tmux" ? tmuxBackend : zellijBackend;
  const result = await backend.killSession({ name: sessionName });
  if (result.exitCode !== 0) {
    logger.error({ message: `Failed to stop session: ${sessionName}` });
    return 1;
  }

  logger.success({ message: `Stopped session: ${sessionName}` });
  return 0;
};

const handleAttach = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: AttachArgs;
}): Promise<number> => {
  const sessionName = args.positionals.session;
  const session = await findSession({ name: sessionName });
  if (!session) {
    logger.error({ message: `Session not found: ${sessionName}` });
    return 1;
  }
  return await attachToSession({ backend: session.backend, name: sessionName });
};

const handleExec = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: ExecArgs;
}): Promise<number> => {
  const sessionName = args.positionals.session;
  const command = args.positionals.command;

  const session = await findSession({ name: sessionName });
  if (!session) {
    logger.error({ message: `Session not found: ${sessionName}` });
    return 1;
  }

  const backend = session.backend === "tmux" ? tmuxBackend : zellijBackend;
  const result = await backend.execInSession({ name: sessionName, command });
  if (result.exitCode !== 0) {
    logger.error({ message: `Failed to execute in session: ${sessionName}` });
    return 1;
  }

  logger.success({ message: `Executed in ${sessionName}: ${command}` });
  return 0;
};

const handlePanes = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PanesArgs;
}): Promise<number> => {
  const sessionName = args.positionals.session;
  const session = await findSession({ name: sessionName });
  if (!session) {
    process.stderr.write(`Session not found: ${sessionName}\n`);
    return 1;
  }
  if (session.backend !== "tmux") {
    process.stderr.write(
      `Session panes are only supported for tmux sessions (got ${session.backend}).\n`
    );
    return 1;
  }
  const pretty = args.options.pretty === true;
  const json = args.options.json === true || !pretty;

  if (json && pretty) {
    process.stderr.write("Cannot combine --json with --pretty.\n");
    return 1;
  }

  const context = { session: sessionName };

  if (json) {
    writeSessionStreamEvent({
      event: buildSessionPanesStartEvent({ context }),
    });
  }

  const result = await listTmuxPanes(sessionName);
  if (result.exitCode !== 0) {
    const message = result.stderr || `Failed to list panes for ${sessionName}`;
    if (json) {
      writeSessionStreamEvent({
        event: buildSessionPanesErrorEvent({ context, message }),
      });
      writeSessionStreamEvent({
        event: buildSessionPanesEndEvent({ context, reason: "error" }),
      });
    } else {
      console.error(message);
    }
    return 1;
  }

  const panes = parseTmuxPanesOutput(result.stdout);

  if (json) {
    for (const pane of panes) {
      writeSessionStreamEvent({
        event: buildSessionPanesLogEvent({ context, pane }),
      });
    }
    writeSessionStreamEvent({
      event: buildSessionPanesEndEvent({ context, reason: "snapshot" }),
    });
    return 0;
  }

  process.stdout.write(
    `${JSON.stringify({ session: sessionName, panes }, null, 2)}\n`
  );
  return 0;
};

const handleCapture = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: CaptureArgs;
}): Promise<number> => {
  const sessionName = args.positionals.session;
  const session = await findSession({ name: sessionName });
  if (!session) {
    process.stderr.write(`Session not found: ${sessionName}\n`);
    return 1;
  }
  if (session.backend !== "tmux") {
    process.stderr.write(
      `Session capture is only supported for tmux sessions (got ${session.backend}).\n`
    );
    return 1;
  }
  const target =
    args.options.target ?? (await resolveActiveTarget(sessionName));
  const lines = args.options.lines ?? 200;
  const pretty = args.options.pretty === true;
  const json = args.options.json === true || !pretty;

  if (json && pretty) {
    process.stderr.write("Cannot combine --json with --pretty.\n");
    return 1;
  }

  const context = {
    session: sessionName,
    target,
    lines,
    follow: false,
  };

  if (json) {
    writeSessionStreamEvent({
      event: buildSessionStreamStartEvent({ context }),
    });
  }

  const result = await capturePane({ target, lines });
  if (result.exitCode !== 0) {
    const message = result.stderr || `Failed to capture ${sessionName}`;
    if (json) {
      writeSessionStreamEvent({
        event: buildSessionStreamErrorEvent({ context, message }),
      });
      writeSessionStreamEvent({
        event: buildSessionStreamEndEvent({ context, reason: "error" }),
      });
    } else {
      console.error(message);
    }
    return 1;
  }

  if (json) {
    for (const line of splitLines(result.stdout)) {
      writeSessionStreamEvent({
        event: buildSessionStreamLogEvent({ context, line }),
      });
    }
    writeSessionStreamEvent({
      event: buildSessionStreamEndEvent({ context, reason: "snapshot" }),
    });
    return 0;
  }

  process.stdout.write(result.stdout);
  return 0;
};

const handleTail = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: TailArgs;
}): Promise<number> => {
  const sessionName = args.positionals.session;
  const resolved = await resolveTailSession({ sessionName });
  if (!resolved.ok) {
    process.stderr.write(`${resolved.error}\n`);
    return 1;
  }

  const outputMode = resolveTailOutputMode({
    json: args.options.json === true,
    pretty: args.options.pretty === true,
  });
  if (!outputMode.ok) {
    process.stderr.write(`${outputMode.error}\n`);
    return 1;
  }

  const target =
    args.options.target ?? (await resolveActiveTarget(sessionName));
  const lines = args.options.lines ?? 200;
  const intervalMs = args.options.intervalMs ?? 500;
  const maxMs = args.options.maxMs ?? 5000;

  return await runTailStream({
    sessionName,
    target,
    lines,
    intervalMs,
    maxMs,
    json: outputMode.json,
  });
};

async function resolveTailSession(opts: {
  readonly sessionName: string;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const session = await findSession({ name: opts.sessionName });
  if (!session) {
    return { ok: false, error: `Session not found: ${opts.sessionName}` };
  }

  if (session.backend !== "tmux") {
    return {
      ok: false,
      error: `Session tail is only supported for tmux sessions (got ${session.backend}).`,
    };
  }

  return { ok: true };
}

function resolveTailOutputMode(opts: {
  readonly json: boolean;
  readonly pretty: boolean;
}):
  | { readonly ok: true; readonly json: boolean }
  | { readonly ok: false; readonly error: string } {
  const json = opts.json || !opts.pretty;
  if (json && opts.pretty) {
    return { ok: false, error: "Cannot combine --json with --pretty." };
  }

  return { ok: true, json };
}

async function runTailStream(opts: {
  readonly sessionName: string;
  readonly target: string;
  readonly lines: number;
  readonly intervalMs: number;
  readonly maxMs: number;
  readonly json: boolean;
}): Promise<number> {
  const context = {
    session: opts.sessionName,
    target: opts.target,
    lines: opts.lines,
    follow: true,
    intervalMs: opts.intervalMs,
    maxMs: opts.maxMs,
  };

  if (opts.json) {
    writeSessionStreamEvent({
      event: buildSessionStreamStartEvent({ context }),
    });
  }

  const initial = await capturePaneOrError({
    sessionName: opts.sessionName,
    target: opts.target,
    lines: opts.lines,
  });
  if (!initial.ok) {
    return renderTailCaptureError({
      context,
      json: opts.json,
      message: initial.error,
    });
  }

  let lastOutput = initial.stdout;
  const start = Date.now();

  while (Date.now() - start < opts.maxMs) {
    await delay(opts.intervalMs);

    const result = await capturePaneOrError({
      sessionName: opts.sessionName,
      target: opts.target,
      lines: opts.lines,
    });
    if (!result.ok) {
      return renderTailCaptureError({
        context,
        json: opts.json,
        message: result.error,
      });
    }

    const suffix = diffNewLines({ previous: lastOutput, next: result.stdout });
    if (suffix) {
      writeTailOutput({
        json: opts.json,
        context,
        output: suffix,
      });
    }

    lastOutput = result.stdout;
  }

  if (opts.json) {
    writeSessionStreamEvent({
      event: buildSessionStreamEndEvent({ context, reason: "timeout" }),
    });
  }

  return 0;
}

async function capturePaneOrError(opts: {
  readonly sessionName: string;
  readonly target: string;
  readonly lines: number;
}): Promise<
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly error: string }
> {
  const result = await capturePane({ target: opts.target, lines: opts.lines });
  if (result.exitCode !== 0) {
    const message = result.stderr || `Failed to capture ${opts.sessionName}`;
    return { ok: false, error: message };
  }
  return { ok: true, stdout: result.stdout };
}

function renderTailCaptureError(opts: {
  readonly context: SessionStreamContext;
  readonly json: boolean;
  readonly message: string;
}): number {
  if (opts.json) {
    writeSessionStreamEvent({
      event: buildSessionStreamErrorEvent({
        context: opts.context,
        message: opts.message,
      }),
    });
    writeSessionStreamEvent({
      event: buildSessionStreamEndEvent({
        context: opts.context,
        reason: "error",
      }),
    });
  } else {
    console.error(opts.message);
  }
  return 1;
}

function writeTailOutput(opts: {
  readonly json: boolean;
  readonly context: SessionStreamContext;
  readonly output: string;
}): void {
  if (opts.json) {
    for (const line of splitLines(opts.output)) {
      writeSessionStreamEvent({
        event: buildSessionStreamLogEvent({ context: opts.context, line }),
      });
    }
    return;
  }

  process.stdout.write(opts.output);
}

export const sessionCommand = defineCommand({
  name: "session",
  summary: "Manage terminal sessions for hack projects",
  group: "Project",
  options: [],
  positionals: [],
  handler: handleSessionPicker,
  subcommands: [
    withHandler(listSpec, handleList),
    withHandler(startSpec, handleStart),
    withHandler(stopSpec, handleStop),
    withHandler(attachSpec, handleAttach),
    withHandler(execSpec, handleExec),
    withHandler(panesSpec, handlePanes),
    withHandler(captureSpec, handleCapture),
    withHandler(tailSpec, handleTail),
  ],
} as const);

/**
 * Capture tmux pane output.
 */
async function capturePane(opts: {
  readonly target: string;
  readonly lines: number;
}) {
  const lines =
    Number.isFinite(opts.lines) && opts.lines > 0 ? opts.lines : 200;
  return await exec(
    ["tmux", "capture-pane", "-p", "-J", "-t", opts.target, "-S", `-${lines}`],
    { stdin: "ignore" }
  );
}

async function listTmuxPanes(sessionName: string) {
  const format = [
    "#{session_name}:#{window_index}.#{pane_index}",
    "#{pane_active}",
    "#{window_index}",
    "#{window_name}",
    "#{pane_index}",
    "#{pane_current_command}",
    "#{pane_current_path}",
  ].join("\t");

  return await exec(["tmux", "list-panes", "-t", sessionName, "-F", format], {
    stdin: "ignore",
  });
}

async function resolveActiveTarget(sessionName: string): Promise<string> {
  const result = await exec(
    [
      "tmux",
      "display-message",
      "-p",
      "-t",
      sessionName,
      "#{session_name}:#{window_index}.#{pane_index}",
    ],
    { stdin: "ignore" }
  );

  const activeTarget = result.exitCode === 0 ? result.stdout.trim() : "";
  if (activeTarget) {
    return activeTarget;
  }

  const panesResult = await listTmuxPanes(sessionName);
  if (panesResult.exitCode === 0) {
    const panes = parseTmuxPanesOutput(panesResult.stdout);
    const [firstPane] = panes;
    if (firstPane) {
      return firstPane.target;
    }
  }

  return `${sessionName}:0.0`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveBackend(backend: MuxBackendName) {
  return backend === "tmux" ? tmuxBackend : zellijBackend;
}

async function listAllSessions(): Promise<readonly MuxSession[]> {
  const out: MuxSession[] = [];
  if (tmuxBackend.available) {
    out.push(...(await tmuxBackend.listSessions()));
  }
  if (zellijBackend.available) {
    out.push(...(await zellijBackend.listSessions()));
  }
  return out;
}

async function findSession(opts: {
  readonly name: string;
}): Promise<MuxSession | null> {
  const sessions = await listAllSessions();
  return sessions.find((s) => s.name === opts.name) ?? null;
}

async function attachToSession(opts: {
  readonly backend: MuxBackendName;
  readonly name: string;
}): Promise<number> {
  if (opts.backend === "tmux") {
    return await attachTmuxSession({ name: opts.name, run });
  }
  return await attachZellijSession({
    name: opts.name,
    createIfMissing: false,
    run,
  });
}

async function createAndAttachSession(opts: {
  readonly backend: MuxBackendName;
  readonly name: string;
  readonly cwd: string;
}): Promise<number> {
  const backend = resolveBackend(opts.backend);
  if (!backend.available) {
    logger.error({ message: `${opts.backend} is not available` });
    return 1;
  }

  const create = await backend.createSession({
    name: opts.name,
    cwd: opts.cwd,
  });
  if (!create.ok) {
    logger.error({
      message: `Failed to create session: ${opts.name}`,
      fields: { error: create.error },
    });
    if (create.stderr) {
      logger.error({ message: create.stderr });
    }
    return 1;
  }

  logger.info({ message: `Created session: ${opts.name}` });
  return await attachToSession({ backend: opts.backend, name: opts.name });
}

async function startProjectSession(opts: {
  readonly project: RegisteredProject;
  readonly forceNew: boolean;
  readonly runUp: boolean;
  readonly customSuffix: string | null;
}): Promise<number> {
  const ctx = buildProjectContext(opts.project);
  const mux = await resolveMux({ project: ctx });

  if (mux.mode === "none") {
    logger.error({
      message:
        "Sessions are disabled (sessions.mux=none). Set sessions.mux to auto|tmux|zellij to enable.",
    });
    return 1;
  }

  const sessions = await listMuxSessions({
    mode: mux.mode,
    backends: mux.backends,
  });
  const baseName = opts.project.name;

  const baseSession = sessions.find((s) => s.name === baseName) ?? null;

  const desiredName = resolveDesiredSessionName({
    baseName,
    sessions,
    baseSession,
    forceNew: opts.forceNew,
    customSuffix: opts.customSuffix,
  });
  if (!desiredName.ok) {
    logger.error({ message: desiredName.error });
    return 1;
  }

  const defaultBackend = resolveDefaultBackendName({
    mode: mux.mode,
    backends: mux.backends,
  });
  const backend = resolveProjectSessionBackend({
    mode: mux.mode,
    backends: mux.backends,
    baseSession,
    defaultBackend,
  });
  if (!backend.ok) {
    logger.error({ message: backend.error });
    return 1;
  }

  if (opts.runUp) {
    await runHackUp(opts.project.repoRoot);
  }

  const existing =
    sessions.find(
      (s) => s.backend === backend.value && s.name === desiredName.value
    ) ?? null;
  if (
    existing &&
    shouldAttachToExistingProjectSession({
      baseName,
      desiredName: desiredName.value,
      forceNew: opts.forceNew,
      customSuffix: opts.customSuffix,
    })
  ) {
    logger.info({
      message: `Attaching to existing session: ${desiredName.value}`,
    });
    return await attachToSession({
      backend: backend.value,
      name: desiredName.value,
    });
  }

  return await createAndAttachSession({
    backend: backend.value,
    name: desiredName.value,
    cwd: opts.project.repoRoot,
  });
}

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function resolveDesiredSessionName(opts: {
  readonly baseName: string;
  readonly sessions: readonly MuxSession[];
  readonly baseSession: MuxSession | null;
  readonly forceNew: boolean;
  readonly customSuffix: string | null;
}): ParseResult<string> {
  if (opts.customSuffix) {
    const suffix = sanitizeBranchSlug(opts.customSuffix);
    if (suffix.length === 0) {
      return { ok: false, error: "Invalid --name (empty after sanitization)." };
    }
    return {
      ok: true,
      value: buildSessionName({ base: opts.baseName, suffix }),
    };
  }

  if (!opts.forceNew) {
    return { ok: true, value: opts.baseName };
  }

  if (!opts.baseSession) {
    return { ok: true, value: opts.baseName };
  }

  const n = getNextNumericSessionSuffix({
    sessions: opts.sessions,
    base: opts.baseName,
  });
  return {
    ok: true,
    value: buildSessionName({ base: opts.baseName, suffix: String(n) }),
  };
}

function resolveProjectSessionBackend(opts: {
  readonly mode: Awaited<ReturnType<typeof resolveMux>>["mode"];
  readonly backends: Awaited<ReturnType<typeof resolveMux>>["backends"];
  readonly baseSession: MuxSession | null;
  readonly defaultBackend: MuxBackendName | null;
}): ParseResult<MuxBackendName> {
  const backend: MuxBackendName | null =
    opts.baseSession?.backend ?? opts.defaultBackend;
  if (backend) {
    return { ok: true, value: backend };
  }

  const available = [
    opts.backends.get("tmux")?.available ? "tmux" : null,
    opts.backends.get("zellij")?.available ? "zellij" : null,
  ]
    .filter((v): v is string => typeof v === "string")
    .join(", ");

  if (available.length > 0) {
    return {
      ok: false,
      error: `No session backend available for sessions.mux=${opts.mode}. Available: ${available}`,
    };
  }

  return {
    ok: false,
    error:
      "No session backend available (install tmux or zellij, or set sessions.mux=none).",
  };
}

function shouldAttachToExistingProjectSession(opts: {
  readonly baseName: string;
  readonly desiredName: string;
  readonly forceNew: boolean;
  readonly customSuffix: string | null;
}): boolean {
  return (
    !(opts.forceNew || opts.customSuffix) && opts.desiredName === opts.baseName
  );
}

/**
 * Run hack up -d in a project directory.
 */
async function runHackUp(projectPath: string): Promise<void> {
  logger.info({ message: `Running hack up -d in ${projectPath}...` });
  await run(["hack", "up", "-d"], { cwd: projectPath, stdin: "inherit" });
}
