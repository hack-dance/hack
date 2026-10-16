import { resolve } from "node:path";
import * as p from "@clack/prompts";
import type {
  CliContext,
  CommandArgs,
  CommandHandlerFor,
} from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optEnv, optJson, optPretty } from "../cli/options.ts";
import {
  readHackEnvContract,
  resolveHackEnv,
  selectHackEnvValues,
} from "../lib/hack-env.ts";
import { appendHackHostTrustEnvironment } from "../lib/local-ca.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  type ProjectContext,
  parseEnvConfigSelection,
  readProjectConfig,
} from "../lib/project.ts";
import {
  assertValidProjectEnvScopeName,
  discoverComposeServiceNames,
  migrateLegacyProjectEnv,
  projectEnvConfigExists,
  resolveProjectEnvConfig,
  selectProjectEnvValues,
} from "../lib/project-env-config.ts";
import type { RegisteredProject } from "../lib/projects-registry.ts";
import { readProjectsRegistry } from "../lib/projects-registry.ts";
import { exec, run } from "../lib/shell.ts";
import type {
  MuxBackend,
  MuxBackendName,
  MuxSession,
} from "../mux/mux-backend.ts";
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
import { attachTmuxSession } from "../mux/tmux-backend.ts";
import { attachZellijSession } from "../mux/zellij-backend.ts";
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

const optService = defineOption({
  name: "service",
  type: "string",
  long: "--service",
  valueHint: "<global|service>",
  description: "Inject env for the selected scope (global or a service name)",
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
  summary: "List active workspaces",
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
  options: [optUp, optNew, optName, optDetach, optEnv, optService],
  positionals: [
    { name: "project", description: "Project name or path", required: false },
  ],
  subcommands: [],
} as const);

const stopSpec = defineCommand({
  name: "stop",
  summary: "Stop a workspace",
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
    "Attach to a running workspace by name. Tmux switches clients instead of nesting tmux inside tmux, while zellij attaches to the named session directly.",
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
    "Queue a command in the workspace without opening a new interactive attach flow. Tmux sends it to the active pane; zellij opens a new pane for the command. This is useful for long-running agents, background checks, or remote follow-up work.",
  options: [optEnv, optService],
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
  readonly sessions: readonly MuxSession[];
  readonly projects: readonly RegisteredProject[];
  readonly home: string;
}): SessionPickerOption[] {
  const options: SessionPickerOption[] = [];

  for (const session of opts.sessions.filter((s) => s.attached === true)) {
    options.push({
      value: `session:${session.name}`,
      label: session.name,
      hint: `${session.backend} attached${
        session.path
          ? ` • ${shortenPathForDisplay({ path: session.path, home: opts.home })}`
          : ""
      }`,
    });
  }

  for (const session of opts.sessions.filter((s) => s.attached !== true)) {
    options.push({
      value: `session:${session.name}`,
      label: session.name,
      hint: session.path
        ? `${session.backend} • ${shortenPathForDisplay({ path: session.path, home: opts.home })}`
        : session.backend,
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
  readonly sessions: readonly MuxSession[];
  readonly projects: readonly RegisteredProject[];
}): Promise<number> {
  const session = opts.sessions.find((s) => s.name === opts.name);
  if (!session) {
    p.log.error(`Workspace not found: ${opts.name}`);
    return 1;
  }

  if (session.attached !== true) {
    return await attachToSession(session);
  }

  const baseName = resolveWorkspaceProjectKey({ workspaceName: opts.name });
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
    return await attachToSession(session);
  }

  const project = opts.projects.find(
    (proj: RegisteredProject) => proj.name === baseName
  );
  const projectContext = project
    ? await findProjectContext(project.repoRoot)
    : await resolveCurrentProjectContext();
  const resolvedBackend = await resolveWorkspaceBackendForCreate({
    project: projectContext,
    preferredBackendName: session.backend,
  });
  if (!resolvedBackend) {
    logger.error({
      message:
        "No session mux backend available. Install tmux or zellij, or set sessions.mux to auto|tmux|zellij.",
    });
    return 1;
  }
  const inferredScope = inferWorkspaceScopeSelection({
    workspaceName: opts.name,
  });
  const projectEnv = projectContext
    ? await resolveSessionInjectedEnv({
        project: projectContext,
        projectName: baseName,
        envName: inferredScope.envName,
        serviceName: inferredScope.serviceName,
      })
    : undefined;
  return await createAndAttachSession({
    backend: resolvedBackend.backend,
    name: nextWorkspaceName,
    cwd: project?.repoRoot ?? session.path ?? process.cwd(),
    env: projectEnv,
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

  const projectContext = await findProjectContext(project.repoRoot);
  const resolvedBackend = await resolveWorkspaceBackendForCreate({
    project: projectContext,
  });
  if (!resolvedBackend) {
    logger.error({
      message:
        "No session mux backend available. Install tmux or zellij, or set sessions.mux to auto|tmux|zellij.",
    });
    return 1;
  }
  const projectEnv = projectContext
    ? await resolveSessionInjectedEnv({
        project: projectContext,
        projectName: project.name,
        envName: undefined,
        serviceName: null,
      })
    : undefined;

  return await createAndAttachSession({
    backend: resolvedBackend.backend,
    name: project.name,
    cwd: project.repoRoot,
    env: projectEnv,
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
  readonly project: ProjectContext | null;
}): Promise<string> {
  if (opts.customName) {
    return buildSessionName({ base: opts.baseName, suffix: opts.customName });
  }

  if (!opts.forceNew) {
    return opts.baseName;
  }

  const sessions = await listWorkspaceSessions({ project: opts.project });
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
  readonly projectContext: ProjectContext | null;
  readonly detach: boolean;
  readonly runUp: boolean;
  readonly envName: string | null | undefined;
  readonly forceNew: boolean;
  readonly customName: string | undefined;
}): Promise<number | null> {
  if (opts.forceNew || opts.customName) {
    return null;
  }

  const sessions = await listWorkspaceSessions({
    project: opts.projectContext,
  });
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
    await runHackUp({
      projectPath: resolveRunUpCwd({ project: opts.project }),
      envName: opts.envName,
    });
  }

  if (opts.detach) {
    return 0;
  }

  return await attachToSession(existing);
}

async function resolveCurrentProjectContext(): Promise<ProjectContext | null> {
  return await findProjectContext(process.cwd());
}

async function listWorkspaceSessions(opts: {
  readonly project: ProjectContext | null;
}): Promise<readonly MuxSession[]> {
  const mux = await resolveMux({ project: opts.project });
  return await listMuxSessions({
    mode: mux.mode,
    backends: mux.backends,
  });
}

async function resolveWorkspaceBackendForCreate(opts: {
  readonly project: ProjectContext | null;
  readonly preferredBackendName?: MuxBackendName;
}): Promise<{
  readonly backendName: MuxBackendName;
  readonly backend: MuxBackend;
} | null> {
  const mux = await resolveMux({ project: opts.project });
  const backendName = resolveWorkspaceBackendNameForCreate({
    preferredBackendName: opts.preferredBackendName,
    defaultBackendName: resolveDefaultBackendName({
      mode: mux.mode,
      backends: mux.backends,
    }),
  });
  if (!backendName) {
    return null;
  }
  const backend = mux.backends.get(backendName);
  if (!backend?.available) {
    return null;
  }
  return { backendName, backend };
}

function resolveWorkspaceBackendNameForCreate(opts: {
  readonly preferredBackendName?: MuxBackendName | null;
  readonly defaultBackendName?: MuxBackendName | null;
}): MuxBackendName | null {
  return opts.preferredBackendName ?? opts.defaultBackendName ?? null;
}

function resolveWorkspaceBackendName(opts: {
  readonly workspaceName: string;
  readonly sessions: readonly MuxSession[];
}): MuxBackendName | null {
  return (
    opts.sessions.find((session) => session.name === opts.workspaceName)
      ?.backend ?? null
  );
}

function resolveTmuxOnlyWorkspaceError(opts: {
  readonly workspaceName: string;
  readonly sessions: readonly MuxSession[];
}): string {
  const backendName = resolveWorkspaceBackendName(opts);
  if (backendName === "zellij") {
    return `Workspace '${opts.workspaceName}' is running in zellij. Pane inspection is tmux-only.`;
  }
  return `Workspace '${opts.workspaceName}' does not support tmux-only pane inspection.`;
}

async function resolveRequiredWorkspaceSession(opts: {
  readonly workspaceName: string;
}): Promise<MuxSession | null> {
  const projectContext = await resolveCurrentProjectContext();
  const sessions = await listWorkspaceSessions({ project: projectContext });
  const session =
    sessions.find((candidate) => candidate.name === opts.workspaceName) ?? null;
  if (!session) {
    logger.error({ message: `Workspace not found: ${opts.workspaceName}` });
    return null;
  }
  return session;
}

async function requireTmuxWorkspaceSession(opts: {
  readonly workspaceName: string;
}): Promise<MuxSession | null> {
  const projectContext = await resolveCurrentProjectContext();
  const sessions = await listWorkspaceSessions({ project: projectContext });
  const session =
    sessions.find((candidate) => candidate.name === opts.workspaceName) ?? null;
  if (!session) {
    logger.error({ message: `Workspace not found: ${opts.workspaceName}` });
    return null;
  }
  if (session.backend !== "tmux") {
    logger.error({
      message: resolveTmuxOnlyWorkspaceError({
        workspaceName: opts.workspaceName,
        sessions,
      }),
    });
    return null;
  }
  return session;
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
  const projectContext = await resolveCurrentProjectContext();
  const sessions = await listWorkspaceSessions({ project: projectContext });
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
  readonly sessions: readonly Pick<MuxSession, "name">[];
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
  const workspaceProjectKey = resolveWorkspaceProjectKey({
    workspaceName: opts.workspaceName,
  });
  const project =
    opts.projects.find((candidate) => candidate.name === opts.workspaceName) ??
    opts.projects.find((candidate) => candidate.name === workspaceProjectKey);
  return project?.name ?? "-";
}

function resolveRunUpCwd(opts: {
  readonly project: RegisteredProject;
}): string {
  return opts.project.repoRoot;
}

function resolveRequestedEnvName(opts: {
  readonly envOption: string | undefined;
}): string | null | undefined {
  const envName = parseEnvConfigSelection(opts.envOption);
  if (opts.envOption !== undefined && envName === undefined) {
    throw new CliUsageError("Invalid --env value.");
  }
  return envName;
}

function resolveRequestedServiceName(opts: {
  readonly serviceOption: string | undefined;
}): string | null {
  try {
    const serviceName = assertValidProjectEnvScopeName({
      scopeName: opts.serviceOption,
    });
    return serviceName === "global" ? null : serviceName;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Invalid --service value.";
    throw new CliUsageError(message);
  }
}

function buildScopedWorkspaceBaseName(opts: {
  readonly projectName: string;
  readonly envOptionSpecified: boolean;
  readonly envName: string | null | undefined;
  readonly serviceName: string | null;
}): string {
  const suffixParts: string[] = [];
  if (opts.envOptionSpecified) {
    suffixParts.push(`env-${opts.envName ?? "base"}`);
  }
  if (opts.serviceName && opts.serviceName !== "global") {
    suffixParts.push(`svc-${opts.serviceName}`);
  }
  if (suffixParts.length === 0) {
    return opts.projectName;
  }
  return `${opts.projectName}.${suffixParts.join(".")}`;
}

function resolveWorkspaceProjectKey(opts: {
  readonly workspaceName: string;
}): string {
  const baseName = resolveWorkspaceBaseName({
    workspaceName: opts.workspaceName,
  });
  const dotIndex = baseName.indexOf(".");
  return dotIndex >= 0 ? baseName.slice(0, dotIndex) : baseName;
}

function inferWorkspaceScopeSelection(opts: {
  readonly workspaceName: string;
}): {
  readonly hasScopedSelection: boolean;
  readonly envName: string | null | undefined;
  readonly serviceName: string | null;
} {
  const baseName = resolveWorkspaceBaseName({
    workspaceName: opts.workspaceName,
  });
  const projectKey = resolveWorkspaceProjectKey({
    workspaceName: opts.workspaceName,
  });
  if (baseName === projectKey) {
    return {
      hasScopedSelection: false,
      envName: undefined,
      serviceName: null,
    };
  }

  const suffix = baseName.startsWith(`${projectKey}.`)
    ? baseName.slice(projectKey.length + 1)
    : "";
  if (suffix.length === 0) {
    return {
      hasScopedSelection: false,
      envName: undefined,
      serviceName: null,
    };
  }

  const serviceMarker = suffix.indexOf(".svc-");
  const startsWithService = suffix.startsWith("svc-");
  let serviceName: string | null = null;
  if (startsWithService) {
    serviceName = suffix.slice("svc-".length);
  } else if (serviceMarker >= 0) {
    serviceName = suffix.slice(serviceMarker + ".svc-".length);
  }
  let envName: string | null | undefined;
  if (suffix.startsWith("env-")) {
    const rawEnv =
      serviceMarker >= 0
        ? suffix.slice("env-".length, serviceMarker)
        : suffix.slice("env-".length);
    envName = rawEnv === "base" ? null : rawEnv;
  }

  return {
    hasScopedSelection: envName !== undefined || serviceName !== null,
    envName,
    serviceName,
  };
}

function resolveEffectiveWorkspaceScopeSelection(opts: {
  readonly workspaceName: string;
  readonly envOptionSpecified: boolean;
  readonly envName: string | null | undefined;
  readonly serviceOptionSpecified: boolean;
  readonly serviceName: string | null;
}): {
  readonly shouldInject: boolean;
  readonly envName: string | null | undefined;
  readonly serviceName: string | null;
} {
  const inferred = inferWorkspaceScopeSelection({
    workspaceName: opts.workspaceName,
  });
  const envName = opts.envOptionSpecified ? opts.envName : inferred.envName;
  const serviceName = opts.serviceOptionSpecified
    ? opts.serviceName
    : inferred.serviceName;

  return {
    shouldInject:
      opts.envOptionSpecified ||
      opts.serviceOptionSpecified ||
      inferred.hasScopedSelection,
    envName,
    serviceName,
  };
}

async function resolveProjectName(project: ProjectContext): Promise<string> {
  const cfg = await readProjectConfig(project);
  const derived = defaultProjectSlugFromPath(project.projectRoot);
  return (cfg.name ?? derived).trim() || derived;
}

async function maybeMigrateLegacySessionEnv(opts: {
  readonly project: ProjectContext;
  readonly projectName: string;
}): Promise<void> {
  if (
    await projectEnvConfigExists({
      projectDir: opts.project.projectDir,
    })
  ) {
    return;
  }

  const contract = await readHackEnvContract({
    projectDir: opts.project.projectDir,
  });
  if (!contract.exists) {
    return;
  }

  const serviceNames = await discoverComposeServiceNames({
    composeFile: opts.project.composeFile,
  });
  const migrated = await migrateLegacyProjectEnv({
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    projectName: opts.projectName,
    serviceNames,
    materialize: false,
  });
  if (migrated.wroteFiles.length > 0) {
    logger.info({
      message: `Migrated legacy env config to ${migrated.wroteFiles.join(", ")}`,
    });
  }
}

async function resolveSessionInjectedEnv(opts: {
  readonly project: ProjectContext;
  readonly projectName: string;
  readonly envName: string | null | undefined;
  readonly serviceName: string | null;
}): Promise<Record<string, string>> {
  await maybeMigrateLegacySessionEnv({
    project: opts.project,
    projectName: opts.projectName,
  });

  const serviceNames = await discoverComposeServiceNames({
    composeFile: opts.project.composeFile,
  });
  const modern = await resolveProjectEnvConfig({
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    envName: opts.envName,
    serviceNames,
  });
  if (modern) {
    return await appendHackHostTrustEnvironment(
      selectProjectEnvValues({
        resolved: modern,
        scopeName: opts.serviceName,
      })
    );
  }

  const resolved = await resolveHackEnv({
    projectDir: opts.project.projectDir,
    projectName: opts.projectName,
    envName: opts.envName,
  });
  return await appendHackHostTrustEnvironment(
    selectHackEnvValues({
      resolved,
      serviceName: opts.serviceName,
    })
  );
}

async function resolveProjectContextForWorkspace(opts: {
  readonly workspaceName: string;
}): Promise<ProjectContext | null> {
  const workspaceProjectName = resolveWorkspaceProjectKey({
    workspaceName: opts.workspaceName,
  });
  const registry = await readProjectsRegistry();
  const registered = registry.projects.find(
    (project) => project.name === workspaceProjectName
  );
  if (registered) {
    return await findProjectContext(registered.repoRoot);
  }

  const currentProject = await resolveCurrentProjectContext();
  if (!currentProject) {
    return null;
  }

  const currentProjectName = await resolveProjectName(currentProject);
  return currentProjectName === workspaceProjectName ? currentProject : null;
}

const handleList: CommandHandlerFor<
  typeof listSpec
> = async (): Promise<number> => {
  const projectContext = await resolveCurrentProjectContext();
  const sessions = await listWorkspaceSessions({ project: projectContext });
  const registry = await readProjectsRegistry();
  const projects = registry.projects;

  if (sessions.length === 0) {
    logger.info({ message: "No active workspaces" });
    return 0;
  }

  console.log(
    `${"Workspace".padEnd(20) + "Project".padEnd(20) + "Backend".padEnd(10)}Status`
  );
  console.log("-".repeat(60));

  for (const session of sessions) {
    const projectName = resolveWorkspaceProjectName({
      workspaceName: session.name,
      projects,
    });
    const status = session.attached === true ? "attached" : "detached";
    console.log(
      session.name.padEnd(20) +
        projectName.padEnd(20) +
        session.backend.padEnd(10) +
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
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });
  const serviceName = resolveRequestedServiceName({
    serviceOption: args.options.service,
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

  const baseName = buildScopedWorkspaceBaseName({
    projectName: project.name,
    envOptionSpecified: args.options.env !== undefined,
    envName,
    serviceName,
  });
  const projectContext = await findProjectContext(project.repoRoot);
  if (!projectContext) {
    logger.error({ message: `Project not found: ${project.repoRoot}` });
    return 1;
  }
  const projectEnv = await resolveSessionInjectedEnv({
    project: projectContext,
    projectName: project.name,
    envName,
    serviceName,
  });
  const reused = await maybeReuseExistingWorkspace({
    baseName,
    project,
    projectContext,
    detach,
    runUp,
    envName,
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
    project: projectContext,
  });

  const resolvedBackend = await resolveWorkspaceBackendForCreate({
    project: projectContext,
  });
  if (!resolvedBackend) {
    logger.error({
      message:
        "No session mux backend available. Install tmux or zellij, or set sessions.mux to auto|tmux|zellij.",
    });
    return 1;
  }

  // Run hack up if requested
  if (runUp) {
    await runHackUp({
      projectPath: resolveRunUpCwd({ project }),
      envName,
    });
  }

  // Use repoRoot (project root), not projectDir (.hack/)
  if (detach) {
    return await createSessionDetached({
      backend: resolvedBackend.backend,
      name: sessionName,
      cwd: project.repoRoot,
      env: projectEnv,
    });
  }
  return await createAndAttachSession({
    backend: resolvedBackend.backend,
    name: sessionName,
    cwd: project.repoRoot,
    env: projectEnv,
  });
};

const handleStop = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: StopArgs;
}): Promise<number> => {
  const workspaceName = args.positionals.workspace;
  const session = await resolveRequiredWorkspaceSession({ workspaceName });
  if (!session) {
    return 1;
  }

  const mux = await resolveMux({
    project: await resolveCurrentProjectContext(),
  });
  const backend = mux.backends.get(session.backend);
  if (!backend?.available) {
    logger.error({ message: `Backend unavailable: ${session.backend}` });
    return 1;
  }

  const result = await backend.killSession({ name: workspaceName });
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
  const session = await resolveRequiredWorkspaceSession({ workspaceName });
  if (!session) {
    return 1;
  }
  return await attachToSession(session);
};

const handleExec = async ({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: ExecArgs;
}): Promise<number> => {
  const workspaceName = args.positionals.workspace;
  const command = args.positionals.command;
  const session = await resolveRequiredWorkspaceSession({ workspaceName });
  if (!session) {
    return 1;
  }

  const mux = await resolveMux({
    project: await resolveCurrentProjectContext(),
  });
  const backend = mux.backends.get(session.backend);
  if (!backend?.available) {
    logger.error({ message: `Backend unavailable: ${session.backend}` });
    return 1;
  }

  const workspaceProject = await resolveProjectContextForWorkspace({
    workspaceName,
  });
  const projectName = workspaceProject
    ? await resolveProjectName(workspaceProject)
    : null;
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });
  const serviceName = resolveRequestedServiceName({
    serviceOption: args.options.service,
  });
  if (
    (args.options.env !== undefined || args.options.service !== undefined) &&
    !(workspaceProject && projectName)
  ) {
    logger.error({
      message: `Unable to resolve project env for workspace: ${workspaceName}`,
    });
    return 1;
  }
  const scopeSelection = resolveEffectiveWorkspaceScopeSelection({
    workspaceName,
    envOptionSpecified: args.options.env !== undefined,
    envName,
    serviceOptionSpecified: args.options.service !== undefined,
    serviceName,
  });
  const injectedEnv =
    workspaceProject && projectName && scopeSelection.shouldInject
      ? await resolveSessionInjectedEnv({
          project: workspaceProject,
          projectName,
          envName: scopeSelection.envName,
          serviceName: scopeSelection.serviceName,
        })
      : undefined;

  const result = await backend.execInSession({
    name: workspaceName,
    command,
    env: injectedEnv,
  });

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

  const tmuxSession = await requireTmuxWorkspaceSession({
    workspaceName: sessionName,
  });
  if (!tmuxSession) {
    return 1;
  }

  if (json) {
    writeSessionStreamEvent({
      event: buildSessionPanesStartEvent({ context }),
    });
  }

  const result = await listTmuxPanes(tmuxSession.name);
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
  const tmuxSession = await requireTmuxWorkspaceSession({
    workspaceName: sessionName,
  });
  if (!tmuxSession) {
    return 1;
  }
  const target =
    args.options.target ?? (await resolveActiveTarget(tmuxSession.name));
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
  const tmuxSession = await requireTmuxWorkspaceSession({
    workspaceName: sessionName,
  });
  if (!tmuxSession) {
    return 1;
  }
  const target =
    args.options.target ?? (await resolveActiveTarget(tmuxSession.name));
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

async function createAndAttachSession(opts: {
  readonly backend: MuxBackend;
  readonly name: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<number> {
  const createExitCode = await createSessionDetached({
    backend: opts.backend,
    name: opts.name,
    cwd: opts.cwd,
    env: opts.env,
  });

  if (createExitCode !== 0) {
    return createExitCode;
  }

  return await attachToSession({
    backend: opts.backend.name,
    name: opts.name,
  });
}

async function createSessionDetached(opts: {
  readonly backend: MuxBackend;
  readonly name: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<number> {
  const createResult = await opts.backend.createSession({
    name: opts.name,
    cwd: opts.cwd,
    env: opts.env,
  });
  if (!createResult.ok) {
    logger.error({ message: `Failed to create workspace: ${opts.name}` });
    return 1;
  }

  logger.info({ message: `Created workspace: ${opts.name}` });
  return 0;
}

async function attachToSession(opts: {
  readonly backend: MuxBackendName;
  readonly name: string;
}): Promise<number> {
  if (opts.backend === "zellij") {
    return await attachZellijSession({
      name: opts.name,
      createIfMissing: false,
      run,
    });
  }
  return await attachTmuxSession({
    name: opts.name,
    run,
  });
}

/**
 * Run hack up -d in a project directory.
 */
async function runHackUp(opts: {
  readonly projectPath: string;
  readonly envName: string | null | undefined;
}): Promise<void> {
  logger.info({ message: `Running hack up -d in ${opts.projectPath}...` });
  const command = ["hack", "up", "-d"];
  if (opts.envName === null) {
    command.push("--env", "base");
  } else if (typeof opts.envName === "string") {
    command.push("--env", opts.envName);
  }
  await run(command, { cwd: opts.projectPath, stdin: "inherit" });
}

export const __testOnlySessionCommand = {
  buildScopedWorkspaceBaseName,
  inferWorkspaceScopeSelection,
  resolveNextIsolatedWorkspaceName,
  resolveEffectiveWorkspaceScopeSelection,
  resolveWorkspaceBackendNameForCreate,
  resolveWorkspaceProjectKey,
  resolveTmuxOnlyWorkspaceError,
  resolveRunUpCwd,
  resolveWorkspaceBackendName,
  resolveWorkspaceProjectName,
};
