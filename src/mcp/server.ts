import { appendFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  type ServerNotification,
  type ServerRequest,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import pkg from "../../package.json";
import {
  type OnboardingMode,
  renderOnboardingPrompt,
} from "../agents/onboarding-prompt.ts";
import type { HackErrorCode } from "../lib/cli-result.ts";
import { ensureDir, pathExists } from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { findProjectContext } from "../lib/project.ts";
import {
  AmbiguousProjectNameError,
  normalizeProjectName,
} from "../lib/project-name.ts";
import {
  AmbiguousProjectIdError,
  readProjectsRegistry,
  resolveRegisteredProjectByName,
} from "../lib/projects-registry.ts";
import { readLinesFromStream } from "../ui/lines.ts";
import type { McpCommandAdmission } from "./command-admission.ts";
import { superviseMcpCommand } from "./command-lifetime.ts";
import {
  classifyLogCollection,
  MCP_LOG_BACKEND_ERROR,
  type McpLogCutoff,
  type McpLogOutcome,
  type McpLogStopReason,
  observeLogStreamEvent,
  toLogStopReason,
} from "./logs-contract.ts";
import {
  createMcpOutputBudget,
  MCP_OUTPUT_LIMIT_BYTES,
} from "./output-budget.ts";
import {
  captureMcpSessionContext,
  type McpSessionContext,
} from "./session-context.ts";

type PackageJsonType = {
  readonly name: string;
  readonly version: string;
} & Record<string, unknown>;

const packageJson = pkg as unknown as PackageJsonType;

type ProjectSelection = {
  readonly projectName?: string;
  readonly repoRoot?: string;
  readonly path?: string;
};

type HackCommandResult = {
  readonly outputTruncated?: boolean;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Existing CLI error codes reused for pre-spawn MCP refusals (no new codes). */
type McpRefusalCode = Extract<HackErrorCode, "E_USAGE" | "E_PROJECT_NOT_FOUND">;

/**
 * Closed catalogue of pre-spawn refusals. Each reason maps to one existing
 * error code and one fixed message. Messages are value-free: they never repeat
 * caller-supplied project names, ids, paths, services or argv, nor registry
 * values derived from them. `invalid_arguments` may append the rejected schema
 * field names, which are drawn only from the tool's own input schema keys.
 */
export const MCP_REFUSALS = Object.freeze({
  invalid_arguments: {
    code: "E_USAGE",
    message: "Invalid arguments.",
  },
  conflicting_project_selection: {
    code: "E_USAGE",
    message: "Use only one of projectName, repoRoot, or path.",
  },
  invalid_project_name: {
    code: "E_USAGE",
    message: "Invalid projectName: use a name containing letters or digits.",
  },
  ambiguous_project: {
    code: "E_USAGE",
    message:
      "Ambiguous project selection: multiple registrations match. Select by path and inspect 'hack projects' before renaming or pruning an entry.",
  },
  project_not_found: {
    code: "E_PROJECT_NOT_FOUND",
    message: "Unknown project. Run 'hack init' or 'hack projects' first.",
  },
  path_not_found: {
    code: "E_PROJECT_NOT_FOUND",
    message: "Path not found.",
  },
  path_not_registered: {
    code: "E_PROJECT_NOT_FOUND",
    message: "Path is outside registered hack projects.",
  },
  no_project_context: {
    code: "E_PROJECT_NOT_FOUND",
    message: "No project context found. Provide projectName or path.",
  },
  init_path_required: {
    code: "E_USAGE",
    message: "Provide repoRoot or path for initialization.",
  },
} as const satisfies Record<
  string,
  { readonly code: McpRefusalCode; readonly message: string }
>);

export type McpRefusalReason = keyof typeof MCP_REFUSALS;

/** Reasons whose message is exactly the catalogue text. */
type FixedRefusalReason = Exclude<McpRefusalReason, "invalid_arguments">;

const MCP_REFUSAL_REASONS = Object.keys(MCP_REFUSALS) as [
  McpRefusalReason,
  ...McpRefusalReason[],
];

/**
 * In-band result for a `tools/call` naming an unregistered tool. Matches the
 * SDK dispatcher's earlier shape (untyped `isError` text carrying the
 * InvalidParams code) but never repeats the requested tool name.
 */
export const MCP_UNKNOWN_TOOL_MESSAGE = `MCP error ${ErrorCode.InvalidParams}: Tool not found`;

type ToolResultPayload = HackCommandResult & {
  readonly ok: boolean;
  readonly data?: unknown;
  /** Present (and false) only on refusals returned before any child spawned. */
  readonly spawned?: false;
  readonly error?:
    | {
        readonly code: McpRefusalCode;
        readonly reason: McpRefusalReason;
        readonly message: string;
      }
    | typeof MCP_LOG_BACKEND_ERROR;
};

type ProjectArgsResolution =
  | { readonly ok: true; readonly args: string[] }
  | { readonly ok: false; readonly reason: FixedRefusalReason };

const DEFAULT_CMD_TIMEOUT_MS = 120_000;
const DEFAULT_LOG_TAIL_EVENTS = 200;
const DEFAULT_LOG_TAIL_MS = 5000;

/**
 * Hard ceilings for numeric MCP inputs. These are provisional F27 experiment
 * settings: values are refused above the ceiling (never clamped), and the
 * effective limits a call ran with are echoed in `data.limits`.
 */
export const MCP_INPUT_CEILINGS = Object.freeze({
  tail: 10_000,
  maxEvents: 10_000,
  maxMs: 60_000,
  timeoutMs: 600_000,
});

/**
 * Compose-style identifier: starts with an ASCII letter or digit, so a value
 * can never be read as an option (`-x`) or be empty. Applied to service,
 * services, profiles, logs service and open target.
 */
const COMPOSE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Same rule for branch names, which may also carry `/` (the CLI slugs it). */
const BRANCH_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;
const IDENTIFIER_MAX_LENGTH = 253;

const READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  openWorldHint: false,
}) satisfies ToolAnnotations;

/** Changes local runtime state without removing it (up, restart). */
const ADDITIVE_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}) satisfies ToolAnnotations;

/** May stop, replace or overwrite local state (down, run, init). */
const DESTRUCTIVE_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
}) satisfies ToolAnnotations;

const toolOutputSchema = {
  ok: z.boolean(),
  outputTruncated: z.boolean().optional(),
  command: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  data: z.unknown().optional(),
  spawned: z.literal(false).optional(),
  error: z
    .object({
      code: z.enum(["E_USAGE", "E_PROJECT_NOT_FOUND", "E_UNEXPECTED"]),
      reason: z.enum([...MCP_REFUSAL_REASONS, MCP_LOG_BACKEND_ERROR.reason]),
      message: z.string(),
    })
    .optional(),
} as const;

function composeIdentifierInput(description: string) {
  return z
    .string()
    .max(IDENTIFIER_MAX_LENGTH)
    .regex(COMPOSE_IDENTIFIER_PATTERN)
    .describe(description);
}

function branchIdentifierInput(description: string) {
  return z
    .string()
    .max(IDENTIFIER_MAX_LENGTH)
    .regex(BRANCH_IDENTIFIER_PATTERN)
    .describe(description);
}

function boundedLimitInput(opts: {
  readonly ceiling: number;
  readonly description: string;
}) {
  return z
    .number()
    .int()
    .positive()
    .max(opts.ceiling)
    .describe(`${opts.description} (1-${opts.ceiling})`);
}

/** Child environment: the frozen session env plus forced non-interactivity. */
function buildChildEnv(
  env: Readonly<Record<string, string>>
): Record<string, string> {
  return { ...env, HACK_NO_INTERACTIVE: "1" };
}

/**
 * Start the hack MCP server on stdio for local tool clients.
 */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer({ cwd: process.cwd(), env: process.env });
  await connectStdioServer(server);
}

/** Build a transport-independent server whose project and command state belongs
 * only to this session. Creating it does not install process signal handlers.
 */
export function createMcpServer(opts: {
  readonly admission?: McpCommandAdmission;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): McpServer {
  const context = captureMcpSessionContext(opts);
  const server = new McpServer(
    {
      name: packageJson.name,
      version: packageJson.version,
    },
    {
      capabilities: { tools: {}, prompts: {} },
    }
  );

  registerTools({ server, context });
  registerPrompts({ server });
  return server;
}

async function connectStdioServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  let closing = false;
  const close = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    void server.close();
  };
  // Keep graceful signals handled while cancelled command groups finish draining.
  // Signal listeners alone do not prevent process exit.
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
  process.stdin.once("end", close);
  process.stdin.once("close", close);
  server.server.onclose = () => {
    process.stdin.off("end", close);
    process.stdin.off("close", close);
  };
  try {
    await server.connect(transport);
  } catch (error) {
    process.off("SIGTERM", close);
    process.off("SIGINT", close);
    process.stdin.off("end", close);
    process.stdin.off("close", close);
    throw error;
  }
}

const ONBOARDING_MODES: ReadonlySet<string> = new Set([
  "new-project",
  "existing-project",
]);

/**
 * Register MCP prompts for no-shell clients.
 *
 * `hack-init` returns the canonical project-onboarding prompt (same content
 * as `hack agent onboard`, `hack init --with`, and the `/hack-init` skill).
 */
function registerPrompts(opts: { readonly server: McpServer }): void {
  opts.server.registerPrompt(
    "hack-init",
    {
      title: "hack project onboarding",
      description:
        "Agent-assisted onboarding prompt: stand up or adopt hack in a project (inventory, compose + env setup, deps/ops container patterns, verification loop).",
      argsSchema: {
        mode: z
          .string()
          .describe(
            'Onboarding mode: "new-project" (no .hack/ yet) or "existing-project" (adopt/refine an existing setup). Default: existing-project.'
          )
          .optional(),
        projectName: z.string().describe("Project slug, when known").optional(),
        devHost: z
          .string()
          .describe("Project dev host (e.g. myapp.hack), when known")
          .optional(),
      },
    },
    ({ mode, projectName, devHost }) => {
      const resolvedMode: OnboardingMode = ONBOARDING_MODES.has(mode ?? "")
        ? ((mode ?? "existing-project") as OnboardingMode)
        : "existing-project";

      const prompt = renderOnboardingPrompt({
        mode: resolvedMode,
        projectName,
        devHost,
      });

      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: prompt },
          },
        ],
      };
    }
  );
}

function registerTools(opts: {
  readonly server: McpServer;
  readonly context: McpSessionContext;
}): void {
  const tools: HackToolRegistry = new Map();
  const register = <const Shape extends z.ZodRawShape>(
    tool: HackToolDefinition<Shape>
  ): void => {
    registerHackTool({ server: opts.server, tools, tool });
  };

  const projectSelectorInput = {
    projectName: z
      .string()
      .describe("Registered project name (from ~/.hack/projects.json)")
      .optional(),
    repoRoot: z
      .string()
      .describe("Repo root path (absolute or relative)")
      .optional(),
    path: z
      .string()
      .describe("Path inside a repo (absolute or relative)")
      .optional(),
  };

  const branchInput = {
    branch: branchIdentifierInput("Branch/worktree name").optional(),
  };

  const profileInput = {
    profiles: z
      .array(composeIdentifierInput("Compose profile name"))
      .describe("Compose profile names")
      .optional(),
  };

  const logSelectionInput = {
    service: composeIdentifierInput("Single service name").optional(),
    services: z
      .array(composeIdentifierInput("Service name"))
      .describe("Multiple service names")
      .optional(),
    query: z.string().describe("Raw LogQL selector/query").optional(),
    loki: z.boolean().describe("Force Loki backend").optional(),
    compose: z.boolean().describe("Force docker compose backend").optional(),
    tail: boundedLimitInput({
      ceiling: MCP_INPUT_CEILINGS.tail,
      description: "Tail last N log lines",
    }).optional(),
    since: z.string().describe("Start time (RFC3339 or duration)").optional(),
    until: z.string().describe("End time (RFC3339 or duration)").optional(),
  };

  register({
    name: "hack.projects.list",
    title: "List hack projects",
    description: "List registered hack projects and runtime status.",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      filter: z.string().describe("Filter by project name").optional(),
      includeGlobal: z
        .boolean()
        .describe("Include global infra projects")
        .optional(),
      includeUnregistered: z
        .boolean()
        .describe("Include unregistered compose projects")
        .optional(),
    },
    handler: async (
      { filter, includeGlobal, includeUnregistered },
      extra
    ): Promise<CallToolResult> => {
      const args = [
        "projects",
        "--json",
        ...(filter ? [`--project=${filter}`] : []),
        ...(includeGlobal ? ["--include-global"] : []),
        ...(includeUnregistered ? ["--all"] : []),
      ];

      const result = await runHackCommand({
        context: opts.context,
        signal: extra.signal,
        tool: "hack.projects.list",
        args,
      });

      return buildToolResult({
        result,
        data: parseJson(result.stdout),
      });
    },
  });

  register({
    name: "hack.project.status",
    title: "Project status",
    description: "Get docker compose status for a project.",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      ...projectSelectorInput,
      ...branchInput,
      ...profileInput,
    },
    handler: async (input, extra) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: opts.context.cwd,
        registryPath: opts.context.registryPath,
      });
      if (!resolved.ok) {
        return buildToolError(resolved);
      }

      const args = [
        "ps",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
        "--json",
      ];

      const result = await runHackCommand({
        context: opts.context,
        signal: extra.signal,
        tool: "hack.project.status",
        args,
      });

      return buildToolResult({
        result,
        data: parseJson(result.stdout),
      });
    },
  });

  register({
    name: "hack.project.up",
    title: "Start project",
    description: "Start project services in detached mode.",
    annotations: ADDITIVE_TOOL_ANNOTATIONS,
    inputSchema: {
      ...projectSelectorInput,
      ...branchInput,
      ...profileInput,
    },
    handler: async (input, extra) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: opts.context.cwd,
        registryPath: opts.context.registryPath,
      });
      if (!resolved.ok) {
        return buildToolError(resolved);
      }

      const args = [
        "up",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
        "--detach",
      ];

      const result = await runHackCommand({
        context: opts.context,
        signal: extra.signal,
        tool: "hack.project.up",
        args,
      });

      return buildToolResult({ result });
    },
  });

  register({
    name: "hack.project.down",
    title: "Stop project",
    description: "Stop project services.",
    annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    inputSchema: {
      ...projectSelectorInput,
      ...branchInput,
      ...profileInput,
    },
    handler: async (input, extra) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: opts.context.cwd,
        registryPath: opts.context.registryPath,
      });
      if (!resolved.ok) {
        return buildToolError(resolved);
      }

      const args = [
        "down",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
      ];

      const result = await runHackCommand({
        context: opts.context,
        signal: extra.signal,
        tool: "hack.project.down",
        args,
      });

      return buildToolResult({ result });
    },
  });

  register({
    name: "hack.project.restart",
    title: "Restart project",
    description: "Restart project services.",
    annotations: ADDITIVE_TOOL_ANNOTATIONS,
    inputSchema: {
      ...projectSelectorInput,
      ...branchInput,
      ...profileInput,
    },
    handler: async (input, extra) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: opts.context.cwd,
        registryPath: opts.context.registryPath,
      });
      if (!resolved.ok) {
        return buildToolError(resolved);
      }

      const args = [
        "restart",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
      ];

      const result = await runHackCommand({
        context: opts.context,
        signal: extra.signal,
        tool: "hack.project.restart",
        args,
      });

      return buildToolResult({ result });
    },
  });

  register({
    name: "hack.project.run",
    title: "Run command in service container",
    description:
      "Run a one-off command inside a service container. Command arguments are passed to the child after `--` and are never parsed as hack options.",
    annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    inputSchema: {
      ...projectSelectorInput,
      ...branchInput,
      ...profileInput,
      service: composeIdentifierInput("Compose service name"),
      cmd: z.array(z.string()).describe("Command arguments").optional(),
      workdir: z
        .string()
        .describe("Working directory inside container")
        .optional(),
      timeoutMs: boundedLimitInput({
        ceiling: MCP_INPUT_CEILINGS.timeoutMs,
        description: "Command timeout in ms",
      }).optional(),
    },
    handler: async (input, extra) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: opts.context.cwd,
        registryPath: opts.context.registryPath,
      });
      if (!resolved.ok) {
        return buildToolError(resolved);
      }

      const timeoutMs = input.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
      const result = await runHackCommand({
        context: opts.context,
        signal: extra.signal,
        tool: "hack.project.run",
        args: buildRunArgs({
          projectArgs: resolved.args,
          branch: input.branch,
          profiles: input.profiles,
          workdir: input.workdir,
          service: input.service,
          cmd: input.cmd ?? [],
        }),
        timeoutMs,
      });

      return buildToolResult({ result, data: { limits: { timeoutMs } } });
    },
  });

  register({
    name: "hack.project.logs.snapshot",
    title: "Snapshot logs",
    description: "Fetch a log snapshot and return structured log events.",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      ...projectSelectorInput,
      ...branchInput,
      ...profileInput,
      ...logSelectionInput,
    },
    handler: async (input, extra) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: opts.context.cwd,
        registryPath: opts.context.registryPath,
      });
      if (!resolved.ok) {
        return buildToolError(resolved);
      }

      const args = [
        "logs",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
        "--json",
        "--no-follow",
        ...buildLogSelectionArgs(input),
      ];

      const result = await runHackLogCollect({
        context: opts.context,
        signal: extra.signal,
        tool: "hack.project.logs.snapshot",
        args,
        timeoutMs: DEFAULT_CMD_TIMEOUT_MS,
      });

      return buildLogToolResult({
        result,
        data: {
          events: result.events,
          count: result.events.length,
          cutoff: cutoffOf(result.outcome),
          limits: { tail: input.tail ?? null },
        },
      });
    },
  });

  register({
    name: "hack.project.logs.tail",
    title: "Tail logs",
    description: "Stream logs briefly and return the collected events.",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      ...projectSelectorInput,
      ...branchInput,
      ...profileInput,
      ...logSelectionInput,
      maxEvents: boundedLimitInput({
        ceiling: MCP_INPUT_CEILINGS.maxEvents,
        description: "Max events to collect",
      }).optional(),
      maxMs: boundedLimitInput({
        ceiling: MCP_INPUT_CEILINGS.maxMs,
        description: "Max duration in ms",
      }).optional(),
    },
    handler: async (input, extra) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: opts.context.cwd,
        registryPath: opts.context.registryPath,
      });
      if (!resolved.ok) {
        return buildToolError(resolved);
      }

      const args = [
        "logs",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        ...buildProfileArgs({ profiles: input.profiles }),
        "--json",
        ...buildLogSelectionArgs(input),
      ];

      const maxEvents = input.maxEvents ?? DEFAULT_LOG_TAIL_EVENTS;
      const maxMs = input.maxMs ?? DEFAULT_LOG_TAIL_MS;
      const result = await runHackLogCollect({
        context: opts.context,
        signal: extra.signal,
        tool: "hack.project.logs.tail",
        args,
        maxEvents,
        timeoutMs: maxMs,
      });

      return buildLogToolResult({
        result,
        data: {
          events: result.events,
          count: result.events.length,
          cutoff: cutoffOf(result.outcome),
          stop_reason: result.stopReason,
          duration_ms: result.durationMs,
          limits: { tail: input.tail ?? null, maxEvents, maxMs },
        },
      });
    },
  });

  register({
    name: "hack.project.open",
    title: "Resolve project URL",
    description: "Return a URL for the project without launching a browser.",
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      ...projectSelectorInput,
      ...branchInput,
      target: composeIdentifierInput("Target host or subdomain").optional(),
    },
    handler: async (input, extra) => {
      const resolved = await resolveProjectArgs({
        selection: toProjectSelection(input),
        cwd: opts.context.cwd,
        registryPath: opts.context.registryPath,
      });
      if (!resolved.ok) {
        return buildToolError(resolved);
      }

      const args = [
        "open",
        ...resolved.args,
        ...buildBranchArgs({ branch: input.branch }),
        "--json",
        ...(input.target ? [input.target] : []),
      ];

      const result = await runHackCommand({
        context: opts.context,
        signal: extra.signal,
        tool: "hack.project.open",
        args,
      });

      return buildToolResult({
        result,
        data: parseJson(result.stdout),
      });
    },
  });

  register({
    name: "hack.project.init",
    title: "Initialize project",
    description: "Initialize a repo using non-interactive defaults.",
    annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    inputSchema: {
      ...projectSelectorInput,
      name: z.string().describe("Project slug").optional(),
      devHost: z.string().describe("DEV_HOST override").optional(),
      oauth: z.boolean().describe("Enable OAuth alias host").optional(),
      oauthTld: z.string().describe("OAuth alias TLD").optional(),
      manual: z
        .boolean()
        .describe("Skip discovery and generate a minimal compose")
        .optional(),
      noDiscovery: z
        .boolean()
        .describe("Skip discovery even if available")
        .optional(),
    },
    handler: async (input, extra) => {
      const selection = toProjectSelection(input);
      if (!(selection.path || selection.repoRoot)) {
        return buildToolError({ reason: "init_path_required" });
      }

      const resolved = await resolveProjectArgs({
        selection,
        cwd: opts.context.cwd,
        registryPath: opts.context.registryPath,
        allowUnregistered: true,
      });
      if (!resolved.ok) {
        return buildToolError(resolved);
      }

      const args = [
        "init",
        ...resolved.args,
        "--auto",
        ...(input.name ? [`--name=${input.name}`] : []),
        ...(input.devHost ? [`--dev-host=${input.devHost}`] : []),
        ...(input.oauth ? ["--oauth"] : []),
        ...(input.oauthTld ? [`--oauth-tld=${input.oauthTld}`] : []),
        ...(input.manual ? ["--manual"] : []),
        ...(input.noDiscovery ? ["--no-discovery"] : []),
      ];

      const result = await runHackCommand({
        context: opts.context,
        signal: extra.signal,
        tool: "hack.project.init",
        args,
        timeoutMs: 180_000,
      });

      return buildToolResult({ result });
    },
  });

  installTypedToolDispatch({ server: opts.server, tools });
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type HackToolDefinition<Shape extends z.ZodRawShape> = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly inputSchema: Shape;
  readonly handler: (
    input: z.output<z.ZodObject<Shape>>,
    extra: ToolExtra
  ) => Promise<CallToolResult>;
};

type HackToolEntry = {
  /** Validates raw arguments and refuses before the handler can spawn. */
  readonly call: (args: unknown, extra: ToolExtra) => Promise<CallToolResult>;
};

type HackToolRegistry = Map<string, HackToolEntry>;

/**
 * Register one tool for discovery (`tools/list`) and keep its validating entry
 * point for {@link installTypedToolDispatch}. The schema advertised by the SDK
 * and the schema enforced at call time are the same object.
 */
function registerHackTool<const Shape extends z.ZodRawShape>(opts: {
  readonly server: McpServer;
  readonly tools: HackToolRegistry;
  readonly tool: HackToolDefinition<Shape>;
}): void {
  const { tool } = opts;
  const schema = z.object(tool.inputSchema);
  const schemaKeys: ReadonlySet<string> = new Set(
    Object.keys(tool.inputSchema)
  );
  const entry: HackToolEntry = {
    call: async (args, extra) => {
      const parsed = await schema.safeParseAsync(args ?? {});
      if (!parsed.success) {
        return buildToolError({
          reason: "invalid_arguments",
          message: describeInvalidArguments({
            error: parsed.error,
            schemaKeys,
          }),
        });
      }
      return await tool.handler(parsed.data, extra);
    },
  };
  opts.tools.set(tool.name, entry);
  const listedSchema: z.ZodObject = schema;
  opts.server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      annotations: { title: tool.title, ...tool.annotations },
      inputSchema: listedSchema,
      outputSchema: toolOutputSchema,
    },
    (args: unknown, extra: ToolExtra) => entry.call(args, extra)
  );
}

/**
 * Replace the SDK's generic `tools/call` dispatcher. The SDK rejects schema
 * failures with untyped text before a handler runs; this dispatcher keeps that
 * ordering (validation precedes any spawn) but returns the typed
 * `{error, spawned: false}` refusal. Thrown handler failures and output-schema
 * mismatches keep the SDK's untyped `isError` text result, because they may
 * occur after a child was spawned.
 *
 * An unknown tool name keeps the SDK 1.26 contract: an in-band `isError` text
 * result (not a JSON-RPC protocol error), with the fixed
 * {@link MCP_UNKNOWN_TOOL_MESSAGE} that omits the requested name.
 */
function installTypedToolDispatch(opts: {
  readonly server: McpServer;
  readonly tools: HackToolRegistry;
}): void {
  const outputSchema = z.object(toolOutputSchema);
  opts.server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const entry = opts.tools.get(request.params.name);
      if (!entry) {
        return buildUntypedToolError(MCP_UNKNOWN_TOOL_MESSAGE);
      }
      try {
        const result = await entry.call(request.params.arguments, extra);
        if (
          !(
            result.isError ||
            outputSchema.safeParse(result.structuredContent).success
          )
        ) {
          return buildUntypedToolError(
            `Output validation error: Invalid structured content for tool ${request.params.name}`
          );
        }
        return result;
      } catch (error) {
        return buildUntypedToolError(
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );
}

/**
 * Closed, value-free summary: names the rejected fields, never echoes input.
 * Field names are kept only when they are keys of the tool's own schema, so a
 * caller-chosen key can never reach the message.
 */
function describeInvalidArguments(opts: {
  readonly error: z.ZodError;
  readonly schemaKeys: ReadonlySet<string>;
}): string {
  const fields = [
    ...new Set(
      opts.error.issues
        .map((issue) => issue.path[0])
        .filter(
          (key): key is string =>
            typeof key === "string" && opts.schemaKeys.has(key)
        )
    ),
  ];
  const subject =
    fields.length > 0
      ? `Invalid arguments: ${fields.join(", ")}.`
      : MCP_REFUSALS.invalid_arguments.message;
  return `${subject} Identifiers must match ${COMPOSE_IDENTIFIER_PATTERN.source} (branches may also contain "/"); limits must be positive integers within their documented ceiling.`;
}

function buildUntypedToolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function buildToolResult(opts: {
  readonly result: HackCommandResult;
  readonly data?: unknown;
}): CallToolResult {
  const ok = opts.result.exitCode === 0;
  const payload: ToolResultPayload = {
    ok,
    command: opts.result.command,
    exitCode: opts.result.exitCode,
    stdout: opts.result.stdout,
    stderr: opts.result.stderr,
    ...(opts.result.outputTruncated ? { outputTruncated: true } : {}),
    ...(!opts.result.outputTruncated && opts.data !== undefined
      ? { data: opts.data }
      : {}),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(ok ? {} : { isError: true }),
  };
}

/**
 * Logs tools result. Unlike {@link buildToolResult}, success follows the
 * collection outcome rather than the child's exit status: a cutoff is `ok`
 * with `data.cutoff` set (the server stopped the child, so `exitCode` may be
 * non-zero), and `data` is kept after the byte bound so partial events
 * survive. A backend failure is `ok: false` with the closed `backend_error`.
 */
function buildLogToolResult(opts: {
  readonly result: HackLogCollection;
  readonly data: Record<string, unknown>;
}): CallToolResult {
  const { result } = opts;
  const ok =
    result.outcome.kind === "complete" || result.outcome.kind === "cutoff";
  const payload: ToolResultPayload = {
    ok,
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.outputTruncated ? { outputTruncated: true } : {}),
    data: opts.data,
    ...(result.outcome.kind === "backend_error"
      ? { error: MCP_LOG_BACKEND_ERROR }
      : {}),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(ok ? {} : { isError: true }),
  };
}

function cutoffOf(outcome: McpLogOutcome): McpLogCutoff | null {
  return outcome.kind === "cutoff" ? outcome.cutoff : null;
}

/**
 * Typed refusal for a request rejected before any child process exists.
 * `spawned: false` is a guarantee: every caller returns before
 * `runHackCommand`/`runHackLogCollect`, so no argv, audit line or mutation occurs.
 * `stderr` repeats the message for clients reading the earlier contract.
 * The message is the reason's fixed text from {@link MCP_REFUSALS}; only
 * `invalid_arguments` may pass its schema-key-only summary instead.
 */
function buildToolError(
  opts:
    | { readonly reason: FixedRefusalReason }
    | { readonly reason: "invalid_arguments"; readonly message: string }
): CallToolResult {
  const { code } = MCP_REFUSALS[opts.reason];
  const message =
    opts.reason === "invalid_arguments"
      ? opts.message
      : MCP_REFUSALS[opts.reason].message;
  const payload: ToolResultPayload = {
    ok: false,
    command: "",
    exitCode: 1,
    stdout: "",
    stderr: message,
    spawned: false,
    error: { code, reason: opts.reason, message },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

/**
 * `hack run` argv. Every option value is fused (`--opt=value`) and `--` ends
 * hack's option parsing, so nothing in `cmd` (for example `--branch other` or
 * `--version`) can be consumed by hack or retarget the instance.
 */
export function buildRunArgs(opts: {
  readonly projectArgs: readonly string[];
  readonly branch?: string;
  readonly profiles?: readonly string[];
  readonly workdir?: string;
  readonly service: string;
  readonly cmd: readonly string[];
}): string[] {
  return [
    "run",
    ...opts.projectArgs,
    ...buildBranchArgs({ branch: opts.branch }),
    ...buildProfileArgs({ profiles: opts.profiles }),
    ...(opts.workdir ? [`--workdir=${opts.workdir}`] : []),
    "--",
    opts.service,
    ...opts.cmd,
  ];
}

function buildLogSelectionArgs(input: {
  readonly loki?: boolean;
  readonly compose?: boolean;
  readonly tail?: number;
  readonly query?: string;
  readonly services?: readonly string[];
  readonly since?: string;
  readonly until?: string;
  readonly service?: string;
}): string[] {
  return [
    ...(input.loki ? ["--loki"] : []),
    ...(input.compose ? ["--compose"] : []),
    ...(input.tail === undefined ? [] : [`--tail=${input.tail}`]),
    ...(input.query ? [`--query=${input.query}`] : []),
    ...(input.services ? buildServicesArgs({ services: input.services }) : []),
    ...(input.since ? [`--since=${input.since}`] : []),
    ...(input.until ? [`--until=${input.until}`] : []),
    ...(input.service ? [input.service] : []),
  ];
}

function buildBranchArgs(opts: { readonly branch?: string }): string[] {
  return opts.branch ? [`--branch=${opts.branch}`] : [];
}

function buildProfileArgs(opts: {
  readonly profiles?: readonly string[];
}): string[] {
  const profiles = opts.profiles ?? [];
  if (profiles.length === 0) {
    return [];
  }
  return [`--profile=${profiles.join(",")}`];
}

function buildServicesArgs(opts: {
  readonly services: readonly string[];
}): string[] {
  if (opts.services.length === 0) {
    return [];
  }
  return [`--services=${opts.services.join(",")}`];
}

function toProjectSelection(input: ProjectSelection): ProjectSelection {
  return {
    projectName: input.projectName,
    repoRoot: input.repoRoot,
    path: input.path,
  };
}

async function resolveProjectArgs(opts: {
  readonly registryPath: string;
  readonly selection: ProjectSelection;
  readonly cwd: string;
  readonly allowUnregistered?: boolean;
}): Promise<ProjectArgsResolution> {
  const selection = opts.selection;
  const picked = [
    selection.projectName,
    selection.repoRoot,
    selection.path,
  ].filter((value) => value !== undefined);
  if (picked.length > 1) {
    return { ok: false, reason: "conflicting_project_selection" };
  }

  if (selection.projectName !== undefined) {
    return await resolveProjectNameArgs({
      projectName: selection.projectName,
      registryPath: opts.registryPath,
    });
  }

  const pathLike = selection.repoRoot ?? selection.path;
  if (pathLike) {
    const absPath = resolve(opts.cwd, pathLike);
    if (!(await pathExists(absPath))) {
      return { ok: false, reason: "path_not_found" };
    }
    if (!opts.allowUnregistered) {
      const allowed = await isPathAllowed({
        absPath,
        registryPath: opts.registryPath,
      });
      if (!allowed) {
        return { ok: false, reason: "path_not_registered" };
      }
    }
    return { ok: true, args: [`--path=${absPath}`] };
  }

  const context = await findProjectContext(opts.cwd);
  if (context) {
    return { ok: true, args: [] };
  }

  if (!opts.allowUnregistered) {
    const allowed = await isPathAllowed({
      absPath: opts.cwd,
      registryPath: opts.registryPath,
    });
    if (!allowed) {
      return { ok: false, reason: "no_project_context" };
    }
  }

  return { ok: true, args: [`--path=${opts.cwd}`] };
}

async function resolveProjectNameArgs(opts: {
  readonly projectName: string;
  readonly registryPath: string;
}): Promise<ProjectArgsResolution> {
  const name = normalizeProjectName(opts.projectName);
  if (!name) {
    return { ok: false, reason: "invalid_project_name" };
  }
  try {
    const project = await resolveRegisteredProjectByName({
      name,
      registryPath: opts.registryPath,
    });
    if (!project) {
      return { ok: false, reason: "project_not_found" };
    }
    return { ok: true, args: [`--project=${name}`] };
  } catch (error) {
    if (
      error instanceof AmbiguousProjectNameError ||
      error instanceof AmbiguousProjectIdError
    ) {
      return { ok: false, reason: "ambiguous_project" };
    }
    throw error;
  }
}

async function isPathAllowed(opts: {
  readonly registryPath: string;
  readonly absPath: string;
}): Promise<boolean> {
  const roots = await readAllowedRoots(opts.registryPath);
  if (roots.length === 0) {
    return false;
  }
  return roots.some((root) =>
    isPathWithin({ parent: root, child: opts.absPath })
  );
}

async function readAllowedRoots(registryPath: string): Promise<string[]> {
  const registry = await readProjectsRegistry({ registryPath });
  const roots = new Set<string>();
  for (const project of registry.projects) {
    roots.add(resolve(project.repoRoot));
    roots.add(resolve(project.projectDir));
  }
  return [...roots];
}

function isPathWithin(opts: {
  readonly parent: string;
  readonly child: string;
}): boolean {
  const rel = relative(opts.parent, opts.child);
  if (rel === "") {
    return true;
  }
  return !(rel.startsWith("..") || isAbsolute(rel));
}

async function runHackCommand(opts: {
  readonly context: McpSessionContext;
  readonly signal: AbortSignal;
  readonly tool: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}): Promise<HackCommandResult> {
  const work = async () => {
    const invocation = await resolveHackInvocation(opts.context);
    opts.signal.throwIfAborted();
    const cmd = [invocation.bin, ...invocation.args, ...opts.args];
    const proc = Bun.spawn(cmd, {
      detached: true,
      cwd: opts.cwd ?? opts.context.cwd,
      env: buildChildEnv(opts.context.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = opts.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
    const lifetime = superviseMcpCommand({
      proc,
      signal: opts.signal,
      timeoutMs,
    });
    const output = createMcpOutputBudget({
      onLimit: () => lifetime.stop("output_limit"),
    });
    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        streamToText(output.wrap(proc.stdout)),
        streamToText(output.wrap(proc.stderr)),
        proc.exited,
      ]);
    } finally {
      lifetime.dispose();
    }

    if (output.exceeded()) {
      exitCode = 1;
      stderr +=
        "\nMCP output exceeded the 8 MiB capture limit; use the CLI for full output.\n";
    }
    const command = formatCommand(cmd);
    await appendAuditLog({
      hackHome: opts.context.hackHome,
      tool: opts.tool,
      command,
      exitCode,
    });

    return {
      command,
      exitCode,
      stdout,
      stderr,
      ...(output.exceeded() ? { outputTruncated: true } : {}),
    };
  };
  return opts.context.admission
    ? await opts.context.admission.run(work)
    : await work();
}

type HackLogCollection = {
  readonly outputTruncated?: boolean;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly events: readonly Record<string, unknown>[];
  readonly stopReason: McpLogStopReason;
  readonly durationMs: number;
  readonly outcome: McpLogOutcome;
};

/**
 * Run `hack logs --json` and collect its stream events under the contract in
 * `logs-contract.ts`. `maxEvents` counts `type: "log"` events only; `timeoutMs`
 * bounds the whole collection; the shared byte budget cuts on a UTF-8 code
 * point boundary. Nothing outlives the call: a later call, in this session or
 * a reconnected one, starts a new backend stream (no cursor, no replay).
 */
async function runHackLogCollect(opts: {
  readonly context: McpSessionContext;
  readonly signal: AbortSignal;
  readonly tool: string;
  readonly args: readonly string[];
  readonly maxEvents?: number;
  readonly timeoutMs: number;
}): Promise<HackLogCollection> {
  const work = async (): Promise<HackLogCollection> => {
    const invocation = await resolveHackInvocation(opts.context);
    opts.signal.throwIfAborted();
    const cmd = [invocation.bin, ...invocation.args, ...opts.args];
    const proc = Bun.spawn(cmd, {
      detached: true,
      cwd: opts.context.cwd,
      env: buildChildEnv(opts.context.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const { maxEvents } = opts;
    const start = Date.now();

    const events: Record<string, unknown>[] = [];
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    let stopReason: McpLogStopReason = "eof";
    let stopped = false;
    let logCount = 0;
    let backendFailureObserved = false;

    const lifetime = superviseMcpCommand({
      proc,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onStop: (reason) => {
        stopped = true;
        stopReason = toLogStopReason(reason);
      },
    });

    const output = createMcpOutputBudget({
      codePointSafe: true,
      onLimit: () => lifetime.stop("output_limit"),
    });
    /** Record one stream event; true once the log-event bound is reached. */
    const recordEvent = (event: Record<string, unknown>): boolean => {
      events.push(event);
      const observed = observeLogStreamEvent(event);
      // Events after a server-initiated stop describe that stop.
      if (observed.backendFailure && !stopped) {
        backendFailureObserved = true;
      }
      if (observed.isLog) {
        logCount += 1;
      }
      return maxEvents !== undefined && logCount >= maxEvents;
    };
    const stdoutTask = (async () => {
      for await (const line of readLinesFromStream(output.wrap(proc.stdout))) {
        stdoutLines.push(line);
        const parsed = parseJsonLine(line.trim());
        if (parsed && recordEvent(parsed)) {
          lifetime.stop("max_events");
          break;
        }
      }
    })();

    const stderrTask = (async () => {
      for await (const line of readLinesFromStream(output.wrap(proc.stderr))) {
        stderrLines.push(line);
      }
    })();

    let exitCode: number;
    try {
      [exitCode] = await Promise.all([proc.exited, stdoutTask, stderrTask]);
    } finally {
      lifetime.dispose();
    }

    if (output.exceeded()) {
      stderrLines.push(
        "MCP output exceeded the 8 MiB capture limit; use the CLI for full output."
      );
    }
    const command = formatCommand(cmd);
    await appendAuditLog({
      hackHome: opts.context.hackHome,
      tool: opts.tool,
      command,
      exitCode,
    });

    return {
      command,
      exitCode,
      stdout: joinLines(stdoutLines),
      stderr: joinLines(stderrLines),
      events,
      ...(output.exceeded() ? { outputTruncated: true } : {}),
      stopReason,
      durationMs: Date.now() - start,
      outcome: classifyLogCollection({
        stopReason,
        exitCode,
        backendFailureObserved,
        limits: {
          ...(maxEvents === undefined ? {} : { maxEvents }),
          timeMs: opts.timeoutMs,
          bytes: MCP_OUTPUT_LIMIT_BYTES,
        },
      }),
    };
  };
  return opts.context.admission
    ? await opts.context.admission.run(work)
    : await work();
}

function formatCommand(parts: readonly string[]): string {
  return parts
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
}

function parseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  if (line.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function joinLines(lines: readonly string[]): string {
  if (lines.length === 0) {
    return "";
  }
  return `${lines.join("\n")}\n`;
}

async function streamToText(
  stream: ReadableStream<Uint8Array> | null
): Promise<string> {
  if (!stream) {
    return "";
  }
  return await new Response(stream).text();
}

async function appendAuditLog(opts: {
  readonly hackHome: string;
  readonly tool: string;
  readonly command: string;
  readonly exitCode: number;
}): Promise<void> {
  const logPath = resolve(opts.hackHome, "mcp-audit.log");
  try {
    await ensureDir(dirname(logPath));
    const payload = {
      ts: new Date().toISOString(),
      tool: opts.tool,
      command: opts.command,
      exit_code: opts.exitCode,
    };
    await appendFile(logPath, `${JSON.stringify(payload)}\n`);
  } catch {
    return;
  }
}
