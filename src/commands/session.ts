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
import { buildSessionName } from "../mux/session-names.ts";
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

/**
 * Interactive session picker (default when no subcommand).
 *
 * Uses clack prompts with grouped options for sessions and projects.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: explicit CLI branching keeps command UX behavior stable.
async function handleSessionPicker(): Promise<number> {
  const sessions = await listTmuxSessions();
  const registry = await readProjectsRegistry();
  const projects = registry.projects;

  p.intro("Sessions");

  const sessionNames = new Set(sessions.map((s) => s.name));
  const home = process.env.HOME ?? "";

  // Helper to shorten paths with ~/
  const shortenPath = (path: string): string => {
    if (home && path.startsWith(home)) {
      return `~${path.slice(home.length)}`;
    }
    return path;
  };

  // Build options for clack select
  type SessionOption = {
    value: string;
    label: string;
    hint?: string;
  };

  const options: SessionOption[] = [];

  // Active sessions
  const attachedSessions = sessions.filter((s) => s.attached);
  const detachedSessions = sessions.filter((s) => !s.attached);

  for (const session of attachedSessions) {
    options.push({
      value: `session:${session.name}`,
      label: session.name,
      hint: `attached${session.path ? ` • ${shortenPath(session.path)}` : ""}`,
    });
  }

  for (const session of detachedSessions) {
    options.push({
      value: `session:${session.name}`,
      label: session.name,
      hint: session.path ? shortenPath(session.path) : "detached",
    });
  }

  // Projects without active sessions
  const availableProjects = projects.filter(
    (proj: RegisteredProject) => !sessionNames.has(proj.name)
  );

  for (const project of availableProjects) {
    options.push({
      value: `project:${project.name}`,
      label: project.name,
      hint: `new • ${shortenPath(project.repoRoot)}`,
    });
  }

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
    const session = sessions.find((s) => s.name === name);

    // If session is attached elsewhere, offer choice
    if (session?.attached) {
      const nextNum = getNextSessionNumber(sessions, name);

      const action = await p.select({
        message: `Session '${name}' is attached elsewhere`,
        options: [
          { value: "attach", label: "Attach", hint: "detaches other clients" },
          {
            value: "new",
            label: "Create new",
            hint: buildSessionName({ base: name, suffix: String(nextNum) }),
          },
        ],
      });

      if (p.isCancel(action)) {
        p.outro("Cancelled");
        return 0;
      }

      if (action === "new") {
        const project = projects.find(
          (proj: RegisteredProject) => proj.name === name
        );
        const cwd = project?.repoRoot ?? session.path ?? process.cwd();
        return await createAndAttachSession({
          name: buildSessionName({ base: name, suffix: String(nextNum) }),
          cwd,
        });
      }
    }

    return await attachToSession(name);
  }

  // Create new session for project
  const project = projects.find(
    (proj: RegisteredProject) => proj.name === name
  );
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
  sessions: TmuxSession[],
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
  const registry = await readProjectsRegistry();
  const project = resolveProjectForSessionStart({
    projects: registry.projects,
    projectNameOrPath,
  });
  if (!project) {
    if (projectNameOrPath) {
      logger.error({ message: `Project not found: ${projectNameOrPath}` });
      return 1;
    }
    logger.error({
      message: "No project specified. Use: hack session start <project>",
    });
    return 1;
  }

  return await startOrAttachSession({
    project,
    args,
    sessions: await listTmuxSessions(),
  });
};

function resolveProjectForSessionStart(opts: {
  readonly projects: readonly RegisteredProject[];
  readonly projectNameOrPath: string | undefined;
}): RegisteredProject | null {
  if (!opts.projectNameOrPath) {
    return null;
  }

  const input = opts.projectNameOrPath;
  const normalizedPath = resolve(input);
  const project =
    opts.projects.find(
      (p: RegisteredProject) =>
        p.name === input ||
        p.projectDir === input ||
        p.projectDir === normalizedPath
    ) ?? null;

  return project;
}

function buildSessionNameForStart(opts: {
  readonly baseName: string;
  readonly sessions: readonly TmuxSession[];
  readonly forceNew: boolean;
  readonly customSuffix?: string;
}): string | null {
  const hasCustomSuffix = opts.customSuffix !== undefined;
  if (!(opts.forceNew || hasCustomSuffix)) {
    const exists = opts.sessions.find((s) => s.name === opts.baseName);
    if (exists) {
      return null;
    }
    return opts.baseName;
  }

  if (hasCustomSuffix) {
    return buildSessionName({
      base: opts.baseName,
      suffix: opts.customSuffix,
    });
  }

  const existing = opts.sessions.filter(
    (s) => s.name === opts.baseName || s.name.startsWith(`${opts.baseName}:`)
  );
  let n = 2;
  while (existing.some((s) => s.name === `${opts.baseName}:${n}`)) {
    n++;
  }
  return buildSessionName({
    base: opts.baseName,
    suffix: String(n),
  });
}

async function startOrAttachSession(opts: {
  readonly project: RegisteredProject;
  readonly args: StartArgs;
  readonly sessions: readonly TmuxSession[];
}): Promise<number> {
  const sessionName = buildSessionNameForStart({
    baseName: opts.project.name,
    sessions: opts.sessions,
    forceNew: opts.args.options.new === true,
    customSuffix: opts.args.options.name,
  });
  const runUp = opts.args.options.up === true;
  const detach = opts.args.options.detach === true;

  if (sessionName === null) {
    if (runUp) {
      await runHackUp(opts.project.projectDir);
    }
    if (detach) {
      logger.info({ message: `Session ready: ${opts.project.name}` });
      return 0;
    }
    return await attachToSession(opts.project.name);
  }

  if (runUp) {
    await runHackUp(opts.project.repoRoot);
  }

  if (detach) {
    return await createSessionDetached({
      name: sessionName,
      cwd: opts.project.repoRoot,
    });
  }

  return await createAndAttachSession({
    name: sessionName,
    cwd: opts.project.repoRoot,
  });
}

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
  const opts = await buildTailArgs({
    sessionName: args.positionals.session,
    options: args.options,
  });

  if (opts.json && opts.pretty) {
    process.stderr.write("Cannot combine --json with --pretty.\n");
    return 1;
  }

  if (opts.json) {
    writeSessionStreamEvent({
      event: buildSessionStreamStartEvent({ context: opts.context }),
    });
  }

  const initial = await capturePane({ target: opts.target, lines: opts.lines });
  if (initial.exitCode !== 0) {
    const message =
      initial.stderr || `Failed to capture ${opts.context.session}`;
    if (opts.json) {
      writeSessionStreamEvent({
        event: buildSessionStreamErrorEvent({
          context: opts.context,
          message,
        }),
      });
      writeSessionStreamEvent({
        event: buildSessionStreamEndEvent({
          context: opts.context,
          reason: "error",
        }),
      });
    } else {
      console.error(message);
    }
    return 1;
  }

  return await streamTailOutput({
    context: opts.context,
    target: opts.target,
    lines: opts.lines,
    json: opts.json,
    initial,
  });
};

async function buildTailArgs(opts: {
  readonly sessionName: string;
  readonly options: TailArgs["options"];
}): Promise<{
  readonly target: string;
  readonly lines: number;
  readonly intervalMs: number;
  readonly maxMs: number;
  readonly pretty: boolean;
  readonly json: boolean;
  readonly context: {
    readonly session: string;
    readonly target: string;
    readonly lines: number;
    readonly follow: boolean;
    readonly intervalMs: number;
    readonly maxMs: number;
  };
}> {
  const target =
    opts.options.target ?? (await resolveActiveTarget(opts.sessionName));
  const lines = opts.options.lines ?? 200;
  const intervalMs = opts.options.intervalMs ?? 500;
  const maxMs = opts.options.maxMs ?? 5000;
  const pretty = opts.options.pretty === true;
  const json = opts.options.json === true || !pretty;

  return {
    target,
    lines,
    intervalMs,
    maxMs,
    pretty,
    json,
    context: {
      session: opts.sessionName,
      target,
      lines,
      follow: true,
      intervalMs,
      maxMs,
    },
  };
}

async function streamTailOutput(opts: {
  readonly context: {
    readonly session: string;
    readonly target: string;
    readonly lines: number;
    readonly follow: boolean;
    readonly intervalMs: number;
    readonly maxMs: number;
  };
  readonly lines: number;
  readonly target: string;
  readonly json: boolean;
  readonly initial: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  };
}): Promise<number> {
  let lastOutput = opts.initial.stdout;
  const start = Date.now();

  while (Date.now() - start < opts.context.maxMs) {
    await delay(opts.context.intervalMs);

    const result = await capturePane({
      target: opts.target,
      lines: opts.lines,
    });
    if (result.exitCode !== 0) {
      const message =
        result.stderr || `Failed to capture ${opts.context.session}`;
      if (opts.json) {
        writeSessionStreamEvent({
          event: buildSessionStreamErrorEvent({
            context: opts.context,
            message,
          }),
        });
        writeSessionStreamEvent({
          event: buildSessionStreamEndEvent({
            context: opts.context,
            reason: "error",
          }),
        });
      } else {
        console.error(message);
      }
      return 1;
    }

    const nextOutput = result.stdout;
    const suffix = diffNewLines({ previous: lastOutput, next: nextOutput });
    if (suffix) {
      if (opts.json) {
        for (const line of splitLines(suffix)) {
          writeSessionStreamEvent({
            event: buildSessionStreamLogEvent({ context: opts.context, line }),
          });
        }
      } else {
        process.stdout.write(suffix);
      }
    }

    lastOutput = nextOutput;
  }

  if (opts.json) {
    writeSessionStreamEvent({
      event: buildSessionStreamEndEvent({
        context: opts.context,
        reason: "timeout",
      }),
    });
  }

  return 0;
}

export const sessionCommand = defineCommand({
  name: "session",
  summary: "Keep reusable terminal workspaces alive",
  group: "Integrations",
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
