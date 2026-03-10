import { resolve } from "node:path";
import * as p from "@clack/prompts";
import type {
  CliContext,
  CommandArgs,
  CommandHandlerFor,
} from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson, optPretty } from "../cli/options.ts";
import type { RegisteredProject } from "../lib/projects-registry.ts";
import { readProjectsRegistry } from "../lib/projects-registry.ts";
import { exec, run } from "../lib/shell.ts";
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
  splitLines,
  writeSessionStreamEvent,
} from "./session-utils.ts";

/**
 * Parsed tmux session info.
 */
interface TmuxSession {
  readonly name: string;
  readonly attached: boolean;
  readonly path: string | null;
}

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

const optDetach = defineOption({
  name: "detach",
  type: "boolean",
  long: "--detach",
  short: "-d",
  description: "Create/switch session without attaching (for GUI/non-TTY use)",
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
  summary: "List active tmux sessions",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const startSpec = defineCommand({
  name: "start",
  summary: "Start or attach to a session for a project",
  group: "Project",
  options: [optUp, optNew, optName, optDetach],
  positionals: [
    { name: "project", description: "Project name or path", required: false },
  ],
  subcommands: [],
} as const);

const stopSpec = defineCommand({
  name: "stop",
  summary: "Stop (kill) a tmux session",
  group: "Project",
  options: [],
  positionals: [
    { name: "session", description: "Session name", required: true },
  ],
  subcommands: [],
} as const);

const attachSpec = defineCommand({
  name: "attach",
  summary: "Attach to an existing tmux session",
  group: "Project",
  options: [],
  positionals: [
    { name: "session", description: "Session name", required: true },
  ],
  subcommands: [],
} as const);

const execSpec = defineCommand({
  name: "exec",
  summary: "Execute a command in a tmux session",
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

type SessionOption = {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
};

type SessionStreamContext = {
  readonly session: string;
  readonly target: string;
  readonly lines: number;
  readonly follow: boolean;
  readonly intervalMs?: number;
  readonly maxMs?: number;
};

function shortenHomePath(input: {
  readonly path: string;
  readonly home: string;
}): string {
  if (input.home && input.path.startsWith(input.home)) {
    return `~${input.path.slice(input.home.length)}`;
  }
  return input.path;
}

function findProjectByName(input: {
  readonly projects: readonly RegisteredProject[];
  readonly name: string;
}): RegisteredProject | undefined {
  return input.projects.find((project) => project.name === input.name);
}

function buildSessionPickerOptions(input: {
  readonly sessions: readonly TmuxSession[];
  readonly projects: readonly RegisteredProject[];
  readonly home: string;
}): SessionOption[] {
  const sessionNames = new Set(input.sessions.map((session) => session.name));
  const availableProjects = input.projects.filter(
    (project) => !sessionNames.has(project.name)
  );
  const options: SessionOption[] = [];

  for (const session of input.sessions.filter((session) => session.attached)) {
    options.push({
      value: `session:${session.name}`,
      label: session.name,
      hint: `attached${session.path ? ` • ${shortenHomePath({ path: session.path, home: input.home })}` : ""}`,
    });
  }

  for (const session of input.sessions.filter((session) => !session.attached)) {
    options.push({
      value: `session:${session.name}`,
      label: session.name,
      hint: session.path
        ? shortenHomePath({ path: session.path, home: input.home })
        : "detached",
    });
  }

  for (const project of availableProjects) {
    options.push({
      value: `project:${project.name}`,
      label: project.name,
      hint: `new • ${shortenHomePath({ path: project.repoRoot, home: input.home })}`,
    });
  }

  return options;
}

async function resolveAttachedSessionAction(input: {
  readonly sessionName: string;
  readonly sessions: readonly TmuxSession[];
  readonly projects: readonly RegisteredProject[];
}): Promise<
  | { readonly ok: true; readonly action: "attach" }
  | {
      readonly ok: true;
      readonly action: "new";
      readonly cwd: string;
      readonly nextNum: number;
    }
  | { readonly ok: true; readonly action: "cancelled" }
> {
  const session = input.sessions.find(
    (candidate) => candidate.name === input.sessionName
  );
  if (!session?.attached) {
    return { ok: true, action: "attach" };
  }

  const nextNum = getNextSessionNumber([...input.sessions], input.sessionName);
  const action = await p.select({
    message: `Session '${input.sessionName}' is attached elsewhere`,
    options: [
      { value: "attach", label: "Attach", hint: "detaches other clients" },
      {
        value: "new",
        label: "Create new",
        hint: `${input.sessionName}:${nextNum}`,
      },
    ],
  });

  if (p.isCancel(action)) {
    p.outro("Cancelled");
    return { ok: true, action: "cancelled" };
  }

  if (action === "attach") {
    return { ok: true, action: "attach" };
  }

  const project = findProjectByName({
    projects: input.projects,
    name: input.sessionName,
  });
  return {
    ok: true,
    action: "new",
    cwd: project?.repoRoot ?? session.path ?? process.cwd(),
    nextNum,
  };
}

function isJsonSessionOutput(input: {
  readonly json: boolean;
  readonly pretty: boolean;
}): boolean | null {
  if (input.json && input.pretty) {
    process.stderr.write("Cannot combine --json with --pretty.\n");
    return null;
  }
  return input.json || !input.pretty;
}

function writeSessionError(input: {
  readonly json: boolean;
  readonly context: SessionStreamContext;
  readonly message: string;
}): void {
  if (input.json) {
    writeSessionStreamEvent({
      event: buildSessionStreamErrorEvent({
        context: input.context,
        message: input.message,
      }),
    });
    writeSessionStreamEvent({
      event: buildSessionStreamEndEvent({
        context: input.context,
        reason: "error",
      }),
    });
    return;
  }
  console.error(input.message);
}

function writeSessionOutputLines(input: {
  readonly json: boolean;
  readonly context: SessionStreamContext;
  readonly text: string;
}): void {
  if (input.json) {
    for (const line of splitLines(input.text)) {
      writeSessionStreamEvent({
        event: buildSessionStreamLogEvent({ context: input.context, line }),
      });
    }
    return;
  }
  process.stdout.write(input.text);
}

function resolveProjectForSessionStart(input: {
  readonly projects: readonly RegisteredProject[];
  readonly projectNameOrPath?: string;
}): RegisteredProject | null {
  if (!input.projectNameOrPath) {
    return null;
  }
  const resolvedPath = resolve(input.projectNameOrPath);
  return (
    input.projects.find(
      (project) =>
        project.name === input.projectNameOrPath ||
        project.projectDir === resolvedPath
    ) ?? null
  );
}

async function resolveSessionStartName(input: {
  readonly baseName: string;
  readonly forceNew: boolean;
  readonly customName?: string;
  readonly detach: boolean;
  readonly runUp: boolean;
  readonly project: RegisteredProject;
}): Promise<
  | { readonly ok: true; readonly sessionName: string }
  | { readonly ok: true; readonly existingSession: string }
> {
  if (input.customName) {
    return {
      ok: true,
      sessionName: `${input.baseName}:${input.customName}`,
    };
  }

  const sessions = await listTmuxSessions();
  if (!input.forceNew) {
    const existing = sessions.find(
      (session) => session.name === input.baseName
    );
    if (existing) {
      if (input.detach) {
        logger.info({ message: `Session ready: ${input.baseName}` });
      } else {
        logger.info({
          message: `Attaching to existing session: ${input.baseName}`,
        });
      }
      if (input.runUp) {
        await runHackUp(input.project.projectDir);
      }
      return {
        ok: true,
        existingSession: input.baseName,
      };
    }
  }

  if (input.forceNew) {
    return {
      ok: true,
      sessionName: `${input.baseName}:${getNextSessionNumber(sessions, input.baseName)}`,
    };
  }

  return {
    ok: true,
    sessionName: input.baseName,
  };
}

/**
 * Interactive session picker (default when no subcommand).
 *
 * Uses clack prompts with grouped options for sessions and projects.
 */
async function handleSessionPicker(): Promise<number> {
  const sessions = await listTmuxSessions();
  const registry = await readProjectsRegistry();
  const projects = registry.projects;

  p.intro("Sessions");
  const home = process.env.HOME ?? "";
  const options = buildSessionPickerOptions({ sessions, projects, home });

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

  // Parse selection
  const [type, ...rest] = selection.split(":");
  const name = rest.join(":"); // Handle names with colons like "project:2"

  if (!name) {
    p.log.error("Invalid selection");
    return 1;
  }

  if (type === "session") {
    const action = await resolveAttachedSessionAction({
      sessionName: name,
      sessions,
      projects,
    });
    if (action.action === "cancelled") {
      return 0;
    }
    if (action.action === "new") {
      return await createAndAttachSession({
        name: `${name}:${action.nextNum}`,
        cwd: action.cwd,
      });
    }

    return await attachToSession(name);
  }

  // Create new session for project
  const project = findProjectByName({ projects, name });
  if (!project) {
    p.log.error(`Project not found: ${name}`);
    return 1;
  }

  return await createAndAttachSession({
    name: project.name,
    cwd: project.repoRoot,
  });
}

/**
 * Get the next available session number for a base name.
 */
function getNextSessionNumber(
  sessions: readonly TmuxSession[],
  baseName: string
): number {
  const existing = sessions.filter(
    (s) => s.name === baseName || s.name.startsWith(`${baseName}:`)
  );
  let n = 2;
  while (existing.some((s) => s.name === `${baseName}:${n}`)) {
    n++;
  }
  return n;
}

const handleList: CommandHandlerFor<
  typeof listSpec
> = async (): Promise<number> => {
  const sessions = await listTmuxSessions();
  const registry = await readProjectsRegistry();
  const projects = registry.projects;

  if (sessions.length === 0) {
    logger.info({ message: "No active tmux sessions" });
    return 0;
  }

  console.log(
    `${"Session".padEnd(20) + "Project".padEnd(20) + "Node".padEnd(10)}Status`
  );
  console.log("-".repeat(60));

  for (const session of sessions) {
    const project = projects.find(
      (p: RegisteredProject) => p.name === session.name
    );
    const projectName = project?.name ?? "-";
    const status = session.attached ? "attached" : "detached";
    console.log(
      session.name.padEnd(20) +
        projectName.padEnd(20) +
        "local".padEnd(10) +
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
  const detach = args.options.detach === true;

  // Find project
  const registry = await readProjectsRegistry();
  const projects = registry.projects;
  const project = resolveProjectForSessionStart({
    projects,
    projectNameOrPath,
  });

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

  const baseName = project.name;
  const sessionPlan = await resolveSessionStartName({
    baseName,
    forceNew,
    customName,
    detach,
    runUp,
    project,
  });
  if ("existingSession" in sessionPlan) {
    if (detach) {
      return 0;
    }
    return await attachToSession(sessionPlan.existingSession);
  }
  const sessionName = sessionPlan.sessionName;

  // Run hack up if requested
  if (runUp) {
    await runHackUp(project.repoRoot);
  }

  // Use repoRoot (project root), not projectDir (.hack/)
  if (detach) {
    return await createSessionDetached({
      name: sessionName,
      cwd: project.repoRoot,
    });
  }
  return await createAndAttachSession({
    name: sessionName,
    cwd: project.repoRoot,
  });
};

const handleStop = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: StopArgs;
}): Promise<number> => {
  const sessionName = args.positionals.session;

  const result = await exec(["tmux", "kill-session", "-t", sessionName], {
    stdin: "ignore",
  });
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
  return await attachToSession(sessionName);
};

const handleExec = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: ExecArgs;
}): Promise<number> => {
  const sessionName = args.positionals.session;
  const command = args.positionals.command;

  const result = await exec(
    ["tmux", "send-keys", "-t", sessionName, command, "Enter"],
    {
      stdin: "ignore",
    }
  );

  if (result.exitCode !== 0) {
    logger.error({
      message: `Failed to send command to session: ${sessionName}`,
    });
    return 1;
  }

  logger.success({ message: `Sent command to ${sessionName}: ${command}` });
  return 0;
};

const handlePanes = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PanesArgs;
}): Promise<number> => {
  const sessionName = args.positionals.session;
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
  const target =
    args.options.target ?? (await resolveActiveTarget(sessionName));
  const lines = args.options.lines ?? 200;
  const intervalMs = args.options.intervalMs ?? 500;
  const maxMs = args.options.maxMs ?? 5000;
  const pretty = args.options.pretty === true;
  const json = isJsonSessionOutput({
    json: args.options.json === true,
    pretty,
  });
  if (json === null) {
    return 1;
  }

  const context: SessionStreamContext = {
    session: sessionName,
    target,
    lines,
    follow: true,
    intervalMs,
    maxMs,
  };

  if (json) {
    writeSessionStreamEvent({
      event: buildSessionStreamStartEvent({ context }),
    });
  }

  const initial = await capturePane({ target, lines });
  if (initial.exitCode !== 0) {
    writeSessionError({
      json,
      context,
      message: initial.stderr || `Failed to capture ${sessionName}`,
    });
    return 1;
  }

  let lastOutput = initial.stdout;
  const start = Date.now();

  while (Date.now() - start < maxMs) {
    await delay(intervalMs);

    const result = await capturePane({ target, lines });
    if (result.exitCode !== 0) {
      writeSessionError({
        json,
        context,
        message: result.stderr || `Failed to capture ${sessionName}`,
      });
      return 1;
    }

    const nextOutput = result.stdout;
    const suffix = diffNewLines({ previous: lastOutput, next: nextOutput });
    if (suffix) {
      writeSessionOutputLines({ json, context, text: suffix });
    }

    lastOutput = nextOutput;
  }

  if (json) {
    writeSessionStreamEvent({
      event: buildSessionStreamEndEvent({ context, reason: "timeout" }),
    });
  }

  return 0;
};

export const sessionCommand = defineCommand({
  name: "session",
  summary: "Manage tmux sessions for hack projects",
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

/**
 * List all tmux sessions.
 */
async function listTmuxSessions(): Promise<TmuxSession[]> {
  const separator = "|||HACK_SESSION_FIELD|||";
  const format = [
    "#{session_name}",
    "#{session_attached}",
    "#{session_path}",
  ].join(separator);
  const result = await exec(["tmux", "list-sessions", "-F", format], {
    stdin: "ignore",
  });

  if (result.exitCode !== 0) {
    return [];
  }

  const sessions: TmuxSession[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const fields = parseTmuxSessionFields(line, separator, 3);
    if (!fields) {
      continue;
    }
    const [name, attached, path] = fields;
    if (name) {
      sessions.push({
        name,
        attached: attached === "1",
        path: path || null,
      });
    }
  }

  return sessions;
}

function parseTmuxSessionFields(
  line: string,
  separator: string,
  expectedCount: number
): readonly string[] | null {
  const bySeparator = line.split(separator);
  if (bySeparator.length === expectedCount) {
    return bySeparator;
  }
  const byTab = line.split("\t");
  if (byTab.length === expectedCount) {
    return byTab;
  }
  return null;
}

/**
 * Attach to or switch to an existing tmux session.
 * Uses switch-client when already inside tmux to avoid nesting.
 * Uses -d to detach other clients (avoids size conflicts from different terminals).
 */
async function attachToSession(name: string): Promise<number> {
  const insideTmux = Boolean(process.env.TMUX);

  if (insideTmux) {
    // Already in tmux - switch to the session instead of nesting
    const exitCode = await run(["tmux", "switch-client", "-t", name], {
      stdin: "inherit",
    });
    return exitCode;
  }

  // Outside tmux - attach with -d to detach other clients
  const exitCode = await run(["tmux", "attach", "-d", "-t", name], {
    stdin: "inherit",
  });
  return exitCode;
}

/**
 * Create a new tmux session and attach/switch to it.
 */
async function createAndAttachSession(opts: {
  readonly name: string;
  readonly cwd: string;
}): Promise<number> {
  const createExitCode = await createSessionDetached({
    name: opts.name,
    cwd: opts.cwd,
  });

  if (createExitCode !== 0) {
    return createExitCode;
  }

  // Switch or attach depending on context (attachToSession handles this)
  return await attachToSession(opts.name);
}

async function createSessionDetached(opts: {
  readonly name: string;
  readonly cwd: string;
}): Promise<number> {
  const createResult = await exec(
    ["tmux", "new-session", "-d", "-s", opts.name, "-c", opts.cwd],
    { stdin: "ignore" }
  );

  if (createResult.exitCode !== 0) {
    logger.error({ message: `Failed to create session: ${opts.name}` });
    return 1;
  }

  logger.info({ message: `Created session: ${opts.name}` });
  return 0;
}

/**
 * Run hack up -d in a project directory.
 */
async function runHackUp(projectPath: string): Promise<void> {
  logger.info({ message: `Running hack up -d in ${projectPath}...` });
  await run(["hack", "up", "-d"], { cwd: projectPath, stdin: "inherit" });
}
