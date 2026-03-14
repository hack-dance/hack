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
import {
  buildSessionName,
  getNextNumericSessionSuffix,
  parseSessionBase,
} from "../mux/session-names.ts";
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
  description: "Run hack up -d before creating or attaching",
} as const);

const optNew = defineOption({
  name: "new",
  type: "boolean",
  long: "--new",
  description:
    "Create an isolated workspace instead of reusing the default project workspace",
} as const);

const optName = defineOption({
  name: "name",
  type: "string",
  long: "--name",
  description:
    "Suffix for an isolated workspace name (for example: agent-1 -> project--agent-1)",
} as const);

const optDetach = defineOption({
  name: "detach",
  type: "boolean",
  long: "--detach",
  short: "-d",
  description:
    "Create or reuse the workspace without attaching (for GUI/non-TTY use)",
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
  summary: "List active tmux workspaces",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const startSpec = defineCommand({
  name: "start",
  summary: "Reuse the default project workspace or create an isolated one",
  group: "Project",
  description:
    "Reuse the default project workspace when it already exists, or create an isolated long-running workspace with --new or --name. Use --detach when another tool should keep the workspace alive without attaching your terminal.",
  options: [optUp, optNew, optName, optDetach],
  positionals: [
    { name: "project", description: "Project name or path", required: false },
  ],
  subcommands: [],
} as const);

const stopSpec = defineCommand({
  name: "stop",
  summary: "Stop a tmux-backed workspace",
  group: "Project",
  options: [],
  positionals: [
    { name: "workspace", description: "Workspace name", required: true },
  ],
  subcommands: [],
} as const);

const attachSpec = defineCommand({
  name: "attach",
  summary: "Attach to an existing workspace",
  group: "Project",
  description:
    "Attach to a running tmux workspace by name. When you are already inside tmux, hack switches clients instead of nesting tmux inside tmux.",
  options: [],
  positionals: [
    { name: "workspace", description: "Workspace name", required: true },
  ],
  subcommands: [],
} as const);

const execSpec = defineCommand({
  name: "exec",
  summary: "Send a command to a running workspace",
  group: "Project",
  description:
    "Queue a command in the workspace's active pane without opening a new shell. This is useful for long-running agents, background checks, or remote follow-up work.",
  options: [],
  positionals: [
    { name: "workspace", description: "Workspace name", required: true },
    {
      name: "command",
      description: "Command to execute in workspace",
      required: true,
    },
  ],
  subcommands: [],
} as const);

const panesSpec = defineCommand({
  name: "panes",
  summary: "List panes in a tmux workspace",
  group: "Project",
  options: [optJson, optPretty],
  positionals: [
    { name: "workspace", description: "Workspace name", required: true },
  ],
  subcommands: [],
} as const);

const captureSpec = defineCommand({
  name: "capture",
  summary: "Capture recent output from a tmux workspace",
  group: "Project",
  options: [optTarget, optLines, optJson, optPretty],
  positionals: [
    { name: "workspace", description: "Workspace name", required: true },
  ],
  subcommands: [],
} as const);

const tailSpec = defineCommand({
  name: "tail",
  summary: "Tail output from a tmux workspace",
  group: "Project",
  options: [optTarget, optLines, optIntervalMs, optMaxMs, optJson, optPretty],
  positionals: [
    { name: "workspace", description: "Workspace name", required: true },
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

type SessionPickerOption = {
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

function shortenPathForDisplay(opts: {
  readonly path: string;
  readonly home: string;
}): string {
  if (opts.home && opts.path.startsWith(opts.home)) {
    return `~${opts.path.slice(opts.home.length)}`;
  }
  return opts.path;
}

function buildSessionPickerOptions(opts: {
  readonly sessions: readonly TmuxSession[];
  readonly projects: readonly RegisteredProject[];
  readonly home: string;
}): SessionPickerOption[] {
  const options: SessionPickerOption[] = [];

  for (const session of opts.sessions.filter((s) => s.attached)) {
    options.push({
      value: `session:${session.name}`,
      label: session.name,
      hint: `attached${
        session.path
          ? ` • ${shortenPathForDisplay({ path: session.path, home: opts.home })}`
          : ""
      }`,
    });
  }

  for (const session of opts.sessions.filter((s) => !s.attached)) {
    options.push({
      value: `session:${session.name}`,
      label: session.name,
      hint: session.path
        ? shortenPathForDisplay({ path: session.path, home: opts.home })
        : "detached",
    });
  }

  const sessionNames = new Set(opts.sessions.map((s) => s.name));
  for (const project of opts.projects.filter(
    (proj: RegisteredProject) => !sessionNames.has(proj.name)
  )) {
    options.push({
      value: `project:${project.name}`,
      label: project.name,
      hint: `new • ${shortenPathForDisplay({
        path: project.repoRoot,
        home: opts.home,
      })}`,
    });
  }

  return options;
}

async function promptAttachedWorkspaceAction(opts: {
  readonly attachedWorkspaceName: string;
  readonly nextWorkspaceName: string;
}): Promise<"attach" | "new" | null> {
  const action = await p.select({
    message: `Workspace '${opts.attachedWorkspaceName}' is attached elsewhere`,
    options: [
      { value: "attach", label: "Attach", hint: "detaches other clients" },
      {
        value: "new",
        label: "Create isolated",
        hint: opts.nextWorkspaceName,
      },
    ],
  });

  if (p.isCancel(action)) {
    p.outro("Cancelled");
    return null;
  }

  return action;
}

async function handleSelectedSession(opts: {
  readonly name: string;
  readonly sessions: readonly TmuxSession[];
  readonly projects: readonly RegisteredProject[];
}): Promise<number> {
  const session = opts.sessions.find((s) => s.name === opts.name);
  if (!session?.attached) {
    return await attachToSession(opts.name);
  }

  const baseName = resolveWorkspaceBaseName({ workspaceName: opts.name });
  const nextWorkspaceName = resolveNextIsolatedWorkspaceName({
    workspaceName: opts.name,
    sessions: opts.sessions,
  });
  const action = await promptAttachedWorkspaceAction({
    attachedWorkspaceName: opts.name,
    nextWorkspaceName,
  });
  if (!action) {
    return 0;
  }
  if (action !== "new") {
    return await attachToSession(opts.name);
  }

  const project = opts.projects.find(
    (proj: RegisteredProject) => proj.name === baseName
  );
  return await createAndAttachSession({
    name: nextWorkspaceName,
    cwd: project?.repoRoot ?? session.path ?? process.cwd(),
  });
}

async function handleSelectedProject(opts: {
  readonly name: string;
  readonly projects: readonly RegisteredProject[];
}): Promise<number> {
  const project = opts.projects.find(
    (proj: RegisteredProject) => proj.name === opts.name
  );
  if (!project) {
    p.log.error(`Project not found: ${opts.name}`);
    return 1;
  }

  return await createAndAttachSession({
    name: project.name,
    cwd: project.repoRoot,
  });
}

async function resolveProjectForSessionStart(opts: {
  readonly projectNameOrPath: string | undefined;
}): Promise<RegisteredProject | null> {
  const registry = await readProjectsRegistry();
  const projects = registry.projects;
  const projectNameOrPath = opts.projectNameOrPath;

  const directMatch = projectNameOrPath
    ? projects.find(
        (project: RegisteredProject) =>
          project.name === projectNameOrPath ||
          project.projectDir === resolve(projectNameOrPath)
      )
    : null;
  if (directMatch) {
    return directMatch;
  }

  if (!projectNameOrPath) {
    return null;
  }

  const resolvedPath = resolve(projectNameOrPath);
  return (
    projects.find(
      (project: RegisteredProject) => project.projectDir === resolvedPath
    ) ?? null
  );
}

async function resolveSessionNameForStart(opts: {
  readonly baseName: string;
  readonly forceNew: boolean;
  readonly customName: string | undefined;
}): Promise<string> {
  if (opts.customName) {
    return buildSessionName({ base: opts.baseName, suffix: opts.customName });
  }

  if (!opts.forceNew) {
    return opts.baseName;
  }

  const sessions = await listTmuxSessions();
  const nextSuffix = getNextNumericSessionSuffix({
    sessions,
    base: opts.baseName,
  });
  return buildSessionName({
    base: opts.baseName,
    suffix: String(nextSuffix),
  });
}

async function maybeReuseExistingWorkspace(opts: {
  readonly baseName: string;
  readonly project: RegisteredProject;
  readonly detach: boolean;
  readonly runUp: boolean;
  readonly forceNew: boolean;
  readonly customName: string | undefined;
}): Promise<number | null> {
  if (opts.forceNew || opts.customName) {
    return null;
  }

  const sessions = await listTmuxSessions();
  const existing = sessions.find((s) => s.name === opts.baseName);
  if (!existing) {
    return null;
  }

  if (opts.detach) {
    logger.info({ message: `Workspace ready: ${opts.baseName}` });
  } else {
    logger.info({
      message: `Attaching to existing workspace: ${opts.baseName}`,
    });
  }

  if (opts.runUp) {
    await runHackUp(resolveRunUpCwd({ project: opts.project }));
  }

  if (opts.detach) {
    return 0;
  }

  return await attachToSession(opts.baseName);
}

function ensureStreamOutputMode(opts: {
  readonly json: boolean;
  readonly pretty: boolean;
}): boolean {
  if (!(opts.json && opts.pretty)) {
    return true;
  }

  process.stderr.write("Cannot combine --json with --pretty.\n");
  return false;
}

function writeSessionStreamError(opts: {
  readonly json: boolean;
  readonly context: SessionStreamContext;
  readonly message: string;
}): void {
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
    return;
  }

  console.error(opts.message);
}

function emitSessionOutputLines(opts: {
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

async function captureTailOutput(opts: {
  readonly target: string;
  readonly lines: number;
  readonly sessionName: string;
  readonly json: boolean;
  readonly context: SessionStreamContext;
}): Promise<string | null> {
  const result = await capturePane({ target: opts.target, lines: opts.lines });
  if (result.exitCode === 0) {
    return result.stdout;
  }

  writeSessionStreamError({
    json: opts.json,
    context: opts.context,
    message: result.stderr || `Failed to capture ${opts.sessionName}`,
  });
  return null;
}

async function streamTailOutput(opts: {
  readonly target: string;
  readonly lines: number;
  readonly intervalMs: number;
  readonly maxMs: number;
  readonly sessionName: string;
  readonly json: boolean;
  readonly context: SessionStreamContext;
  readonly initialOutput: string;
}): Promise<number> {
  let lastOutput = opts.initialOutput;
  const start = Date.now();

  while (Date.now() - start < opts.maxMs) {
    await delay(opts.intervalMs);

    const nextOutput = await captureTailOutput({
      target: opts.target,
      lines: opts.lines,
      sessionName: opts.sessionName,
      json: opts.json,
      context: opts.context,
    });
    if (nextOutput === null) {
      return 1;
    }

    const suffix = diffNewLines({ previous: lastOutput, next: nextOutput });
    if (suffix) {
      emitSessionOutputLines({
        json: opts.json,
        context: opts.context,
        output: suffix,
      });
    }

    lastOutput = nextOutput;
  }

  return 0;
}

/**
 * Interactive session picker (default when no subcommand).
 *
 * Uses clack prompts with grouped options for sessions and projects.
 */
async function handleSessionPicker(): Promise<number> {
  const sessions = await listTmuxSessions();
  p.intro("Workspaces");
  const projects = (await readProjectsRegistry()).projects;
  const options = buildSessionPickerOptions({
    sessions,
    projects,
    home: process.env.HOME ?? "",
  });

  if (options.length === 0) {
    p.log.warn(
      "No workspaces or projects found. Run 'hack init' in a project first."
    );
    p.outro("");
    return 1;
  }

  const selection = await p.select({
    message: "Select workspace or project",
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
    return await handleSelectedSession({ name, sessions, projects });
  }

  return await handleSelectedProject({ name, projects });
}

function resolveWorkspaceBaseName(opts: {
  readonly workspaceName: string;
}): string {
  return parseSessionBase({ name: opts.workspaceName });
}

function resolveNextIsolatedWorkspaceName(opts: {
  readonly workspaceName: string;
  readonly sessions: readonly TmuxSession[];
}): string {
  const baseName = resolveWorkspaceBaseName({
    workspaceName: opts.workspaceName,
  });
  const nextSuffix = getNextNumericSessionSuffix({
    sessions: opts.sessions,
    base: baseName,
  });
  return buildSessionName({ base: baseName, suffix: String(nextSuffix) });
}

function resolveWorkspaceProjectName(opts: {
  readonly workspaceName: string;
  readonly projects: readonly RegisteredProject[];
}): string {
  const workspaceBase = resolveWorkspaceBaseName({
    workspaceName: opts.workspaceName,
  });
  const project =
    opts.projects.find((candidate) => candidate.name === opts.workspaceName) ??
    opts.projects.find((candidate) => candidate.name === workspaceBase);
  return project?.name ?? "-";
}

function resolveRunUpCwd(opts: {
  readonly project: RegisteredProject;
}): string {
  return opts.project.repoRoot;
}

const handleList: CommandHandlerFor<
  typeof listSpec
> = async (): Promise<number> => {
  const sessions = await listTmuxSessions();
  const registry = await readProjectsRegistry();
  const projects = registry.projects;

  if (sessions.length === 0) {
    logger.info({ message: "No active tmux workspaces" });
    return 0;
  }

  console.log(
    `${"Workspace".padEnd(20) + "Project".padEnd(20) + "Node".padEnd(10)}Status`
  );
  console.log("-".repeat(60));

  for (const session of sessions) {
    const projectName = resolveWorkspaceProjectName({
      workspaceName: session.name,
      projects,
    });
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
  const project = await resolveProjectForSessionStart({ projectNameOrPath });

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
  const reused = await maybeReuseExistingWorkspace({
    baseName,
    project,
    detach,
    runUp,
    forceNew,
    customName,
  });
  if (reused !== null) {
    return reused;
  }

  const sessionName = await resolveSessionNameForStart({
    baseName,
    forceNew,
    customName,
  });

  // Run hack up if requested
  if (runUp) {
    await runHackUp(resolveRunUpCwd({ project }));
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
  const workspaceName = args.positionals.workspace;

  const result = await exec(["tmux", "kill-session", "-t", workspaceName], {
    stdin: "ignore",
  });
  if (result.exitCode !== 0) {
    logger.error({ message: `Failed to stop workspace: ${workspaceName}` });
    return 1;
  }

  logger.success({ message: `Stopped workspace: ${workspaceName}` });
  return 0;
};

const handleAttach = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: AttachArgs;
}): Promise<number> => {
  const workspaceName = args.positionals.workspace;
  return await attachToSession(workspaceName);
};

const handleExec = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: ExecArgs;
}): Promise<number> => {
  const workspaceName = args.positionals.workspace;
  const command = args.positionals.command;

  const result = await exec(
    ["tmux", "send-keys", "-t", workspaceName, command, "Enter"],
    {
      stdin: "ignore",
    }
  );

  if (result.exitCode !== 0) {
    logger.error({
      message: `Failed to send command to workspace: ${workspaceName}`,
    });
    return 1;
  }

  logger.success({ message: `Sent command to ${workspaceName}: ${command}` });
  return 0;
};

const handlePanes = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PanesArgs;
}): Promise<number> => {
  const sessionName = args.positionals.workspace;
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
  const sessionName = args.positionals.workspace;
  const target =
    args.options.target ?? (await resolveActiveTarget(sessionName));
  const lines = args.options.lines ?? 200;
  const pretty = args.options.pretty === true;
  const json = args.options.json === true || !pretty;

  if (!ensureStreamOutputMode({ json, pretty })) {
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
  const sessionName = args.positionals.workspace;
  const target =
    args.options.target ?? (await resolveActiveTarget(sessionName));
  const lines = args.options.lines ?? 200;
  const intervalMs = args.options.intervalMs ?? 500;
  const maxMs = args.options.maxMs ?? 5000;
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
    follow: true,
    intervalMs,
    maxMs,
  };

  if (json) {
    writeSessionStreamEvent({
      event: buildSessionStreamStartEvent({ context }),
    });
  }

  const initialOutput = await captureTailOutput({
    target,
    lines,
    sessionName,
    json,
    context,
  });
  if (initialOutput === null) {
    return 1;
  }

  const tailExitCode = await streamTailOutput({
    target,
    lines,
    intervalMs,
    maxMs,
    sessionName,
    json,
    context,
    initialOutput,
  });
  if (tailExitCode !== 0) {
    return tailExitCode;
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
  summary: "Manage persistent project workspaces with tmux-first onboarding",
  group: "Project",
  description:
    "Sessions keep a project workspace alive across terminal restarts, SSH reconnects, and long-running agent work. The guided default is tmux, including `hack setup tmux` for a popup picker. Other mux backends such as zellij still exist through `sessions.mux`, but the interactive session tooling is tmux-first today.",
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
    logger.error({ message: `Failed to create workspace: ${opts.name}` });
    return 1;
  }

  logger.info({ message: `Created workspace: ${opts.name}` });
  return 0;
}

/**
 * Run hack up -d in a project directory.
 */
async function runHackUp(projectPath: string): Promise<void> {
  logger.info({ message: `Running hack up -d in ${projectPath}...` });
  await run(["hack", "up", "-d"], { cwd: projectPath, stdin: "inherit" });
}

export const __testOnlySessionCommand = {
  resolveNextIsolatedWorkspaceName,
  resolveRunUpCwd,
  resolveWorkspaceProjectName,
};
