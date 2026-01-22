import { resolve } from "node:path";
import * as p from "@clack/prompts";
import type {
  CliContext,
  CommandArgs,
  CommandHandlerFor,
} from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import type { RegisteredProject } from "../lib/projects-registry.ts";
import { readProjectsRegistry } from "../lib/projects-registry.ts";
import { exec, run } from "../lib/shell.ts";
import { logger } from "../ui/logger.ts";

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
  options: [optUp, optNew, optName],
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
          { value: "new", label: "Create new", hint: `${name}:${nextNum}` },
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
          name: `${name}:${nextNum}`,
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

  const baseName = project.name;
  let sessionName = baseName;

  if (forceNew || customName) {
    if (customName) {
      sessionName = `${baseName}:${customName}`;
    } else {
      // Find next available number
      const sessions = await listTmuxSessions();
      const existing = sessions.filter(
        (s) => s.name === baseName || s.name.startsWith(`${baseName}:`)
      );
      if (existing.length > 0) {
        let n = 2;
        while (existing.some((s) => s.name === `${baseName}:${n}`)) {
          n++;
        }
        sessionName = `${baseName}:${n}`;
      }
    }
  } else {
    // Check if session exists
    const sessions = await listTmuxSessions();
    const existing = sessions.find((s) => s.name === baseName);
    if (existing) {
      logger.info({ message: `Attaching to existing session: ${baseName}` });
      if (runUp) {
        await runHackUp(project.projectDir);
      }
      return await attachToSession(baseName);
    }
  }

  // Run hack up if requested
  if (runUp) {
    await runHackUp(project.repoRoot);
  }

  // Use repoRoot (project root), not projectDir (.hack/)
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
  ],
} as const);

/**
 * List all tmux sessions.
 */
async function listTmuxSessions(): Promise<TmuxSession[]> {
  const result = await exec(
    [
      "tmux",
      "list-sessions",
      "-F",
      "#{session_name}:#{session_attached}:#{session_path}",
    ],
    { stdin: "ignore" }
  );

  if (result.exitCode !== 0) {
    return [];
  }

  const sessions: TmuxSession[] = [];
  for (const line of result.stdout.trim().split("\n")) {
    if (!line) {
      continue;
    }
    const [name, attached, path] = line.split(":");
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
  // Create detached session first
  const createResult = await exec(
    ["tmux", "new-session", "-d", "-s", opts.name, "-c", opts.cwd],
    { stdin: "ignore" }
  );

  if (createResult.exitCode !== 0) {
    logger.error({ message: `Failed to create session: ${opts.name}` });
    return 1;
  }

  logger.info({ message: `Created session: ${opts.name}` });

  // Switch or attach depending on context (attachToSession handles this)
  return await attachToSession(opts.name);
}

/**
 * Run hack up -d in a project directory.
 */
async function runHackUp(projectPath: string): Promise<void> {
  logger.info({ message: `Running hack up -d in ${projectPath}...` });
  await run(["hack", "up", "-d"], { cwd: projectPath, stdin: "inherit" });
}
